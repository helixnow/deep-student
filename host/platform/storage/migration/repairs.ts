/**
 * 迁移协调器中 Rust 编写的 schema 修复 / 旧库兼容步骤，逐个移植自
 * `dstu-storage/src/migration/coordinator.rs`（操作顺序、SQL 文本、错误文案保持一致）：
 *
 * - `ensure_legacy_baseline` / `detect_legacy_migration`
 * - `cleanup_intermediate_tables`
 * - `pre_repair_schema` → `pre_repair_vfs_schema`（`apply_vfs_init_missing_tables`、
 *   `apply_vfs_init_missing_schema_objects`、`ensure_vfs_deleted_at_core`、
 *   `vfs_sync_fields_would_conflict`、`apply_vfs_sync_fields_compat`、
 *   `pre_repair_vfs_v20260204/0205/0209/0210`、`pre_repair_vfs_v20260824_note_props`）、
 *   `pre_repair_chat_v2_schema`（`pre_repair_chat_v2_v20260201/v20260204`）、
 *   `pre_repair_mistakes_schema`（`apply_mistakes_init_compat`、`apply_mistakes_sync_fields_compat`）、
 *   `pre_repair_llm_usage_schema`
 * - `repair_recorded_migration_schema_gaps` → `repair_vfs_v20260714_vector_index_profiles`、
 *   `repair_mistakes_v20260523_document_tasks`
 *
 * Rust 中 `include_str!` 嵌入的 SQL 在这里从同一迁移目录读取。
 */
import path from 'node:path';
import type { CoordinatedDatabaseName, SqlParams } from '../api.ts';
import type { MigrationSet } from './definitions.ts';
import { MigrationError, errorText } from './errors.ts';
import type { RepairHelpers } from './helpers.ts';
import { chronoRfc3339Now, readMigrationSql, type Runner } from './refinery.ts';
import { extractColumnDef, extractCreateTableIfNotExists, extractInitNonTableSchemaObjects, parseAlterAddColumns } from './sql-text.ts';
import { MigrationVerifier } from './verifier.ts';

export interface RepairContext {
  h: RepairHelpers;
  id: CoordinatedDatabaseName;
  runner: Runner;
  set: MigrationSet;
  migrationsDir: string;
}

// ------------------------------------------------------------------ 小工具

function readSql(migrationsDir: string, file: string): string {
  return readMigrationSql(path.join(migrationsDir, file));
}

/** `conn.execute(sql, params).map_err(|e| MigrationError::Database(..))`。 */
function run(h: RepairHelpers, sql: string, params: SqlParams | undefined, wrap?: (e: string) => string): number {
  try {
    return h.conn.run(sql, params).changes;
  } catch (error) {
    throw MigrationError.database(wrap === undefined ? errorText(error) : wrap(errorText(error)), error);
  }
}

/** `query_row(.., |row| row.get(0))` 包装成 `MigrationError::Database`。 */
function pluck<T>(h: RepairHelpers, sql: string, params?: SqlParams): T | undefined {
  try {
    return h.conn.pluck<T>(sql, params);
  } catch (error) {
    throw MigrationError.database(errorText(error), error);
  }
}

/** coordinator `get_current_version`：history 表不存在为 0，否则 MAX(version)（NULL → 0）。 */
export function getCurrentVersion(h: RepairHelpers): number {
  const exists = pluck<number>(
    h,
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
  );
  if (exists !== 1) return 0;
  const version = pluck<number | null>(h, 'SELECT MAX(version) FROM refinery_schema_history');
  return version ?? 0;
}

// ------------------------------------------------------------------ legacy baseline

/** `detect_legacy_migration`：返回 `[旧迁移类型, 是否有数据]` 或 undefined。 */
export function detectLegacyMigration(h: RepairHelpers, id: CoordinatedDatabaseName): [string, boolean] | undefined {
  switch (id) {
    case 'chat_v2':
      if (h.tableExists('chat_v2_migrations')) return ['chat_v2_migrations', true];
      if (h.tableExists('chat_v2_sessions')) return ['existing_tables', true];
      break;
    case 'llm_usage':
      if (h.tableExists('schema_version')) return ['schema_version', true];
      if (h.tableExists('llm_usage_logs')) return ['existing_tables', true];
      break;
    case 'mistakes':
      if (h.tableExists('migration_progress')) return ['migration_progress', true];
      if (h.tableExists('mistakes')) return ['existing_tables', true];
      break;
    case 'vfs':
      if (h.tableExists('vfs_schema_history')) return ['vfs_schema_history', true];
      break;
  }
  return undefined;
}

/** `ensure_legacy_baseline`。 */
export function ensureLegacyBaseline(ctx: Omit<RepairContext, 'runner'>): void {
  const { h, id, set } = ctx;
  let hasRefineryWithRecords = false;
  try {
    hasRefineryWithRecords = h.conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM refinery_schema_history LIMIT 1)') === 1;
  } catch (error) {
    // 表不存在时返回 false（Rust `unwrap_or(false)`）
    h.log('debug', 'refinery_schema_history not readable; treating as empty', { error: errorText(error) });
  }
  if (hasRefineryWithRecords) return;

  const legacy = detectLegacyMigration(h, id);
  if (legacy === undefined) return;
  const [legacyType, hasData] = legacy;
  if (!hasData) return;

  h.log('info', `🔄 [Migration] 检测到旧数据库 ${id} (${legacyType}), 创建 Refinery baseline`);
  run(
    h,
    `CREATE TABLE IF NOT EXISTS refinery_schema_history (
                        version INTEGER PRIMARY KEY,
                        name TEXT,
                        applied_on TEXT,
                        checksum TEXT
                    )`,
    undefined,
  );

  const first = set.migrations[0];
  if (first === undefined) return;
  try {
    MigrationVerifier.verify(h.conn, first);
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    h.log('warn', '⚠️ [Migration] 首迁移契约未满足，跳过 baseline 记账，后续将执行真实迁移', {
      database: id,
      version: first.refineryVersion,
      error: error.message,
    });
    return;
  }
  run(
    h,
    `INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)
                                 VALUES (?1, ?2, ?3, ?4)`,
    [first.refineryVersion, first.name, chronoRfc3339Now(), '0'],
  );
  h.log('info', `✅ [Migration] 已为 ${id} 创建 baseline: v${first.refineryVersion}`);
}

// ------------------------------------------------------------------ 中间表清理

/** `cleanup_intermediate_tables`。 */
export function cleanupIntermediateTables(ctx: Pick<RepairContext, 'h' | 'id'>): void {
  const { h, id } = ctx;
  const intermediate: Record<CoordinatedDatabaseName, readonly string[]> = {
    vfs: ['vfs_index_segments_new', 'vfs_index_units_new', 'vfs_blobs_new'],
    chat_v2: ['messages_new', 'variants_new', 'sessions_new'],
    mistakes: ['mistakes_new'],
    llm_usage: ['llm_usage_new'],
  };
  for (const table of intermediate[id]) {
    let exists = false;
    try {
      exists = h.conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]) === 1;
    } catch (error) {
      h.log('debug', 'intermediate table probe failed; treating as absent', { table, error: errorText(error) });
    }
    if (!exists) continue;
    h.log('warn', '检测到中间状态表（可能来自失败的迁移），正在清理...', { database: id, table });
    try {
      h.conn.run(`DROP TABLE IF EXISTS ${table}`);
      h.log('info', '成功清理中间状态表', { database: id, table });
    } catch (error) {
      h.log('warn', '清理中间状态表失败，继续迁移流程', { database: id, table, error: errorText(error) });
    }
  }
}

// ------------------------------------------------------------------ pre_repair_schema

/** `pre_repair_schema`。 */
export function preRepairSchema(ctx: RepairContext): void {
  switch (ctx.id) {
    case 'vfs':
      preRepairVfsSchema(ctx);
      break;
    case 'chat_v2':
      preRepairChatV2Schema(ctx);
      break;
    case 'mistakes':
      preRepairMistakesSchema(ctx);
      break;
    case 'llm_usage':
      preRepairLlmUsageSchema(ctx);
      break;
  }
}

// ------------------------------------------------------------------ VFS

/** `pre_repair_vfs_schema`。 */
export function preRepairVfsSchema(ctx: RepairContext): void {
  const { h, runner, migrationsDir } = ctx;
  if (h.tableExists('resources')) {
    applyVfsInitMissingTables(h, migrationsDir);
    applyVfsInitMissingSchemaObjects(h, migrationsDir);
  }

  h.ensureChangeLogTable('vfs', readSql(migrationsDir, 'vfs/V20260131__add_change_log.sql'), 'resources');

  const TARGET_VERSION = 20260201;
  if (!h.tableExists('resources')) return;

  if (h.isMigrationRecorded(TARGET_VERSION)) {
    applyVfsSyncFieldsCompat(h);
  } else if (vfsSyncFieldsWouldConflict(h)) {
    applyVfsSyncFieldsCompat(h);
    h.ensureRefineryHistoryTable();
    h.markMigrationComplete(runner, TARGET_VERSION);
  } else {
    ensureVfsDeletedAtCore(h);
  }

  preRepairVfsV20260204(h, runner);
  preRepairVfsV20260205(h, runner);
  preRepairVfsV20260209(h, runner);
  preRepairVfsV20260210(h, runner);
  preRepairVfsV20260824NoteProps(h, runner);
}

/** `pre_repair_vfs_v20260824_note_props`。 */
export function preRepairVfsV20260824NoteProps(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260824;
  if (!h.tableExists('notes')) return;
  const recorded = h.isMigrationRecorded(VERSION);
  const hasProps = h.columnExists('notes', 'props');
  if (recorded && !hasProps) {
    h.log('warn', `🔧 [PreRepair] VFS: V${VERSION} 已记录但 notes.props 缺失，补齐列`);
    h.addColumnIfMissing('notes', 'props', 'TEXT');
  } else if (!recorded && hasProps) {
    h.log('warn', `🔧 [PreRepair] VFS: notes.props 已存在但 V${VERSION} 未记录，补齐迁移记录`);
    h.ensureRefineryHistoryTable();
    h.markMigrationComplete(runner, VERSION);
  }
}

/** `apply_vfs_init_missing_tables`。 */
export function applyVfsInitMissingTables(h: RepairHelpers, migrationsDir: string): void {
  const INIT_SQL = readSql(migrationsDir, 'vfs/V20260130__init.sql');
  const NOTES_VERSIONS_DROPPED = 20260214;
  const NOTE_PROPS_ADDED = 20260824;

  const skipNotesVersions = h.isMigrationRecorded(NOTES_VERSIONS_DROPPED);
  const restoreNoteProps = h.isMigrationRecorded(NOTE_PROPS_ADDED);
  const statements = extractCreateTableIfNotExists(INIT_SQL);

  const foreignKeysOn = h.foreignKeysValue();
  h.execute('PRAGMA foreign_keys = OFF');

  let failed = false;
  let applyError: unknown;
  try {
    for (const [tableName, statement] of statements) {
      if (tableName === 'notes_versions' && skipNotesVersions) continue;
      if (h.tableExists(tableName)) continue;
      h.log('info', `🔧 [PreRepair] VFS: 补齐缺失表 ${tableName}`);
      h.executeBatch(statement, (e) => `回放 vfs init 补齐 ${tableName} 失败: ${e}`);
    }
    if (restoreNoteProps) h.addColumnIfMissing('notes', 'props', 'TEXT');
  } catch (error) {
    failed = true;
    applyError = error;
  }

  if (foreignKeysOn !== 0) h.execute('PRAGMA foreign_keys = ON');
  if (failed) throw applyError;
}

/** init.sql 中创建、但被后续迁移有意退役的对象：`[类型, 名称, 退役版本]`。 */
const RETIRED_INIT_OBJECTS: ReadonlyArray<readonly [string, string, number]> = [
  ['index', 'idx_vfs_index_segments_modality_dim', 20260202],
  ['index', 'idx_vfs_index_segments_lance', 20260202],
  ['index', 'idx_folder_items_unique_v2', 20260523],
];

/** `apply_vfs_init_missing_schema_objects`。 */
export function applyVfsInitMissingSchemaObjects(h: RepairHelpers, migrationsDir: string): void {
  const INIT_SQL = readSql(migrationsDir, 'vfs/V20260130__init.sql');
  for (const { masterType, name, targetTable, statement } of extractInitNonTableSchemaObjects(INIT_SQL)) {
    const retired = RETIRED_INIT_OBJECTS.find(([kind, objectName]) => kind === masterType && objectName === name);
    if (retired !== undefined && h.isMigrationRecorded(retired[2])) continue;
    if (targetTable !== undefined && !h.tableExists(targetTable)) continue;
    if (masterType === 'trigger' && statement.toUpperCase().includes('QUESTIONS_FTS') && !h.tableExists('questions_fts')) {
      continue;
    }
    const alreadyExists = pluck<number>(h, 'SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)', [
      masterType,
      name,
    ]);
    if (alreadyExists === 1) continue;
    try {
      h.conn.exec(statement);
      h.log('info', `🔧 [PreRepair] VFS: 补齐缺失 init ${masterType} ${name}`);
    } catch (error) {
      // 可降级：缺口由 MigrationVerifier 契约验证兜底 fail-close。
      h.log('warn', `⚠️ [PreRepair] VFS: 回放 init 非表对象 ${masterType} ${name} 失败（降级跳过）: ${errorText(error)}`);
    }
  }
}

/** `ensure_vfs_deleted_at_core`。 */
export function ensureVfsDeletedAtCore(h: RepairHelpers): void {
  for (const table of ['resources', 'notes', 'questions', 'folders']) {
    if (h.addColumnIfMissing(table, 'deleted_at', 'TEXT')) {
      h.log('info', `🔧 [PreRepair] VFS: 为 ${table} 表添加缺失的 deleted_at 列 (TEXT)`);
    }
  }
}

/** `vfs_sync_fields_would_conflict`。 */
export function vfsSyncFieldsWouldConflict(h: RepairHelpers): boolean {
  const targets: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['resources', ['device_id', 'local_version']],
    ['notes', ['device_id', 'local_version']],
    ['questions', ['device_id', 'local_version']],
    ['review_plans', ['device_id', 'local_version', 'deleted_at']],
    ['folders', ['device_id', 'local_version']],
  ];
  for (const [table, columns] of targets) {
    if (!h.tableExists(table)) continue;
    for (const column of columns) {
      if (h.columnExists(table, column)) return true;
    }
  }
  return false;
}

/** `apply_vfs_sync_fields_compat`。 */
export function applyVfsSyncFieldsCompat(h: RepairHelpers): void {
  ensureVfsDeletedAtCore(h);
  h.addColumnIfMissing('resources', 'device_id', 'TEXT');
  h.addColumnIfMissing('resources', 'local_version', 'INTEGER DEFAULT 0');
  h.addColumnIfMissing('notes', 'device_id', 'TEXT');
  h.addColumnIfMissing('notes', 'local_version', 'INTEGER DEFAULT 0');
  h.addColumnIfMissing('questions', 'device_id', 'TEXT');
  h.addColumnIfMissing('questions', 'local_version', 'INTEGER DEFAULT 0');
  h.addColumnIfMissing('review_plans', 'device_id', 'TEXT');
  h.addColumnIfMissing('review_plans', 'local_version', 'INTEGER DEFAULT 0');
  h.addColumnIfMissing('review_plans', 'deleted_at', 'TEXT');
  h.addColumnIfMissing('folders', 'device_id', 'TEXT');
  h.addColumnIfMissing('folders', 'local_version', 'INTEGER DEFAULT 0');

  const indexSqls = [
    // resources
    'CREATE INDEX IF NOT EXISTS idx_resources_local_version ON resources(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_resources_device_id ON resources(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_resources_updated_at ON resources(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_resources_device_version ON resources(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_resources_updated_not_deleted ON resources(updated_at) WHERE deleted_at IS NULL',
    // notes
    'CREATE INDEX IF NOT EXISTS idx_notes_local_version ON notes(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_notes_deleted_at_sync ON notes(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_notes_device_id ON notes(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_notes_device_version ON notes(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_notes_updated_not_deleted ON notes(updated_at) WHERE deleted_at IS NULL',
    // questions
    'CREATE INDEX IF NOT EXISTS idx_questions_local_version ON questions(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_questions_device_id ON questions(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_questions_updated_at ON questions(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_questions_device_version ON questions(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_questions_updated_not_deleted ON questions(updated_at) WHERE deleted_at IS NULL',
    // review_plans
    'CREATE INDEX IF NOT EXISTS idx_review_plans_local_version ON review_plans(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_review_plans_deleted_at ON review_plans(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_review_plans_device_id ON review_plans(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_review_plans_updated_at ON review_plans(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_review_plans_device_version ON review_plans(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_review_plans_updated_not_deleted ON review_plans(updated_at) WHERE deleted_at IS NULL',
    // folders
    'CREATE INDEX IF NOT EXISTS idx_folders_local_version ON folders(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_folders_device_id ON folders(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_folders_updated_at ON folders(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_folders_device_version ON folders(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_folders_updated_not_deleted ON folders(updated_at) WHERE deleted_at IS NULL',
  ];
  for (const sql of indexSqls) {
    h.execute(sql, (e) => `创建索引失败: ${sql} (${e})`);
  }
}

/** `pre_repair_vfs_v20260204`：PDF 处理状态字段。 */
export function preRepairVfsV20260204(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260204;
  if (!h.tableExists('files')) return;
  if (h.isMigrationRecorded(VERSION)) return;
  if (!h.columnExists('files', 'processing_status')) return;

  h.log('info', `🔧 [PreRepair] VFS: 检测到 PDF 处理字段残留，补齐并标记 V${VERSION}`);
  h.addColumnIfMissing('files', 'processing_status', "TEXT DEFAULT 'pending'");
  h.addColumnIfMissing('files', 'processing_progress', 'TEXT');
  h.addColumnIfMissing('files', 'processing_error', 'TEXT');
  h.addColumnIfMissing('files', 'processing_started_at', 'INTEGER');
  h.addColumnIfMissing('files', 'processing_completed_at', 'INTEGER');

  const indexSqls = [
    'CREATE INDEX IF NOT EXISTS idx_files_processing_status ON files(processing_status)',
    "CREATE INDEX IF NOT EXISTS idx_files_pdf_processing ON files(mime_type, processing_status) WHERE mime_type = 'application/pdf'",
    "CREATE INDEX IF NOT EXISTS idx_files_processing_started ON files(processing_started_at) WHERE processing_status IN ('text_extraction', 'page_rendering', 'ocr_processing', 'vector_indexing')",
  ];
  for (const sql of indexSqls) {
    h.execute(sql, (e) => `VFS V20260204 索引创建失败: ${sql} (${e})`);
  }

  const backfillSqls = [
    `UPDATE files SET processing_status = 'completed', processing_progress = '{"stage":"completed","percent":100,"ready_modes":["text","image"]}', processing_completed_at = (strftime('%s', 'now') * 1000) WHERE mime_type = 'application/pdf' AND processing_status = 'pending' AND (preview_json IS NOT NULL OR extracted_text IS NOT NULL)`,
    `UPDATE files SET processing_progress = '{"stage":"completed","percent":100,"ready_modes":["text","image","ocr"]}' WHERE mime_type = 'application/pdf' AND processing_status = 'completed' AND ocr_pages_json IS NOT NULL`,
  ];
  for (const sql of backfillSqls) {
    try {
      h.conn.run(sql);
    } catch (error) {
      h.log('warn', `VFS V20260204 回填 PDF 处理状态失败（继续）: ${sql} (${errorText(error)})`);
    }
  }

  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, VERSION);
}

/** `pre_repair_vfs_v20260205`：压缩 blob hash。 */
export function preRepairVfsV20260205(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260205;
  if (!h.tableExists('files')) return;
  if (h.isMigrationRecorded(VERSION)) return;
  if (!h.columnExists('files', 'compressed_blob_hash')) return;

  h.log('info', `🔧 [PreRepair] VFS: 检测到 compressed_blob_hash 残留，标记 V${VERSION}`);
  h.execute(
    'CREATE INDEX IF NOT EXISTS idx_files_compressed_blob_hash ON files(compressed_blob_hash)',
    (e) => `VFS V20260205 索引创建失败: ${e}`,
  );
  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, VERSION);
}

/** `pre_repair_vfs_v20260209`：题目图片字段。 */
export function preRepairVfsV20260209(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260209;
  if (!h.tableExists('questions')) return;
  if (h.isMigrationRecorded(VERSION)) return;
  if (!h.columnExists('questions', 'images_json')) return;

  h.log('info', `🔧 [PreRepair] VFS: 检测到 images_json 残留，标记 V${VERSION}`);
  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, VERSION);
}

/** `pre_repair_vfs_v20260210`：答题提交字段。 */
export function preRepairVfsV20260210(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260210;
  if (!h.tableExists('questions')) return;
  if (h.isMigrationRecorded(VERSION)) return;
  const hasAny =
    h.columnExists('questions', 'ai_feedback') || h.columnExists('questions', 'ai_score') || h.columnExists('questions', 'ai_graded_at');
  if (!hasAny) return;

  h.log('info', `🔧 [PreRepair] VFS: 检测到答题提交字段残留，补齐并标记 V${VERSION}`);
  h.addColumnIfMissing('questions', 'ai_feedback', 'TEXT');
  h.addColumnIfMissing('questions', 'ai_score', 'INTEGER');
  h.addColumnIfMissing('questions', 'ai_graded_at', 'TEXT');

  h.executeBatch(
    `CREATE TABLE IF NOT EXISTS answer_submissions (
                id TEXT PRIMARY KEY NOT NULL,
                question_id TEXT NOT NULL,
                user_answer TEXT NOT NULL,
                is_correct INTEGER,
                grading_method TEXT NOT NULL DEFAULT 'auto',
                submitted_at TEXT NOT NULL,
                FOREIGN KEY (question_id) REFERENCES questions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_submissions_question
                ON answer_submissions(question_id, submitted_at DESC);`,
    (e) => `VFS V20260210 answer_submissions 创建失败: ${e}`,
  );

  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, VERSION);
}

// ------------------------------------------------------------------ chat_v2

/** `pre_repair_chat_v2_schema`。 */
export function preRepairChatV2Schema(ctx: RepairContext): void {
  const { h, runner, migrationsDir } = ctx;

  // --- V20260130: 旧库表补齐 ---
  if (h.tableExists('chat_v2_sessions')) {
    h.executeBatch(readSql(migrationsDir, 'chat_v2/V20260130__init.sql'), (e) => `回放 chat_v2 init 补齐缺失表失败: ${e}`);
  }

  // --- V20260131: __change_log 表修复（通用防御） ---
  h.ensureChangeLogTable('chat_v2', readSql(migrationsDir, 'chat_v2/V20260131__add_change_log.sql'), 'chat_v2_sessions');

  // --- V20260201: 同步字段 ---
  preRepairChatV2V20260201(h, runner);

  // --- V20260204: 会话分组 ---
  preRepairChatV2V20260204(h, runner);

  // --- V20260207: active_skill_ids_json ---
  {
    const TARGET_VERSION = 20260207;
    const PREVIOUS_VERSION = 20260204;
    const TARGET_COLUMN = 'active_skill_ids_json';
    const TARGET_TABLE = 'chat_v2_session_state';
    if (h.tableExists(TARGET_TABLE) && getCurrentVersion(h) >= PREVIOUS_VERSION && !h.isMigrationRecorded(TARGET_VERSION)) {
      h.addColumnIfMissing(TARGET_TABLE, TARGET_COLUMN, "TEXT DEFAULT '[]'");
      h.log('info', `🔧 [PreRepair] chat_v2: ${TARGET_COLUMN} 列已补齐，标记 V${TARGET_VERSION} 迁移为已完成`);
      h.ensureRefineryHistoryTable();
      h.markMigrationComplete(runner, TARGET_VERSION);
    }
  }

  // --- V20260221: 分组关联来源（pinned_resource_ids_json） ---
  {
    const TARGET_VERSION = 20260221;
    const PREVIOUS_VERSION = 20260207;
    const TARGET_COLUMN = 'pinned_resource_ids_json';
    const TARGET_TABLE = 'chat_v2_session_groups';
    if (h.tableExists(TARGET_TABLE) && getCurrentVersion(h) >= PREVIOUS_VERSION && !h.isMigrationRecorded(TARGET_VERSION)) {
      h.addColumnIfMissing(TARGET_TABLE, TARGET_COLUMN, "TEXT DEFAULT '[]'");
      h.log('info', `🔧 [PreRepair] chat_v2: ${TARGET_COLUMN} 列已补齐，标记 V${TARGET_VERSION} 迁移为已完成`);
      h.ensureRefineryHistoryTable();
      h.markMigrationComplete(runner, TARGET_VERSION);
    }
  }

  // --- V20260306: skill_state_json ---
  {
    const TARGET_VERSION = 20260306;
    const PREVIOUS_VERSION = 20260302;
    const TARGET_COLUMN = 'skill_state_json';
    const TARGET_TABLE = 'chat_v2_session_state';
    if (h.tableExists(TARGET_TABLE) && getCurrentVersion(h) >= PREVIOUS_VERSION && !h.isMigrationRecorded(TARGET_VERSION)) {
      h.addColumnIfMissing(TARGET_TABLE, TARGET_COLUMN, 'TEXT');
      run(
        h,
        `
                    UPDATE chat_v2_session_state
                    SET skill_state_json = json_object(
                        'manualPinnedSkillIds', json(COALESCE(active_skill_ids_json, '[]')),
                        'modeRequiredBundleIds', json('[]'),
                        'agenticSessionSkillIds', json(COALESCE(loaded_skill_ids_json, '[]')),
                        'branchLocalSkillIds', json('[]'),
                        'effectiveAllowedInternalTools', json('[]'),
                        'effectiveAllowedExternalTools', json('[]'),
                        'effectiveAllowedExternalServers', json('[]'),
                        'version', 0,
                        'legacyMigrated', 1
                    )
                    WHERE skill_state_json IS NULL
                    `,
        undefined,
        (e) => `回填 chat_v2.skill_state_json 失败: ${e}`,
      );
      h.log('info', `🔧 [PreRepair] chat_v2: ${TARGET_COLUMN} 列已补齐，标记 V${TARGET_VERSION} 迁移为已完成`);
      h.ensureRefineryHistoryTable();
      h.markMigrationComplete(runner, TARGET_VERSION);
    }
  }

  // --- V20260717: 课题首选 runtime root ---
  {
    const TARGET_VERSION = 20260717;
    const PREVIOUS_VERSION = 20260711;
    const TARGET_TABLE = 'chat_v2_session_groups';
    if (h.tableExists(TARGET_TABLE) && getCurrentVersion(h) >= PREVIOUS_VERSION && !h.isMigrationRecorded(TARGET_VERSION)) {
      h.addColumnIfMissing(TARGET_TABLE, 'default_runtime_root_id', 'TEXT');
      h.addColumnIfMissing(TARGET_TABLE, 'preferred_project_root_path', 'TEXT');
      h.log('info', `🔧 [PreRepair] chat_v2: 课题首选 runtime root 列已补齐，标记 V${TARGET_VERSION} 迁移为已完成`);
      h.ensureRefineryHistoryTable();
      h.markMigrationComplete(runner, TARGET_VERSION);
    }
  }
}

/** `pre_repair_chat_v2_v20260201`：同步字段与索引。 */
export function preRepairChatV2V20260201(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260201;
  const PREVIOUS_VERSION = 20260131;
  if (!h.tableExists('chat_v2_sessions')) return;
  if (h.isMigrationRecorded(VERSION)) return;
  if (getCurrentVersion(h) < PREVIOUS_VERSION) return;

  h.log('info', `🔧 [PreRepair] chat_v2: 补齐 V${VERSION} 同步字段和索引（旧库兼容/残留修复）`);
  const syncColumns: ReadonlyArray<readonly [string, string, string]> = [
    ['chat_v2_sessions', 'device_id', 'TEXT'],
    ['chat_v2_sessions', 'local_version', 'INTEGER DEFAULT 0'],
    ['chat_v2_sessions', 'deleted_at', 'TEXT'],
    ['chat_v2_messages', 'device_id', 'TEXT'],
    ['chat_v2_messages', 'local_version', 'INTEGER DEFAULT 0'],
    ['chat_v2_messages', 'updated_at', 'TEXT'],
    ['chat_v2_messages', 'deleted_at', 'TEXT'],
    ['chat_v2_blocks', 'device_id', 'TEXT'],
    ['chat_v2_blocks', 'local_version', 'INTEGER DEFAULT 0'],
    ['chat_v2_blocks', 'updated_at', 'TEXT'],
    ['chat_v2_blocks', 'deleted_at', 'TEXT'],
  ];
  for (const [table, column, def] of syncColumns) h.addColumnIfMissing(table, column, def);

  const indexSqls = [
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_local_version ON chat_v2_sessions(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_deleted_at ON chat_v2_sessions(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_device_id ON chat_v2_sessions(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_sync_updated_at ON chat_v2_sessions(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_local_version ON chat_v2_messages(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_deleted_at ON chat_v2_messages(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_device_id ON chat_v2_messages(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_sync_updated_at ON chat_v2_messages(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_local_version ON chat_v2_blocks(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_deleted_at ON chat_v2_blocks(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_device_id ON chat_v2_blocks(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_sync_updated_at ON chat_v2_blocks(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_device_version ON chat_v2_sessions(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_device_version ON chat_v2_messages(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_device_version ON chat_v2_blocks(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_updated_not_deleted ON chat_v2_sessions(updated_at) WHERE deleted_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_updated_not_deleted ON chat_v2_messages(updated_at) WHERE deleted_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_updated_not_deleted ON chat_v2_blocks(updated_at) WHERE deleted_at IS NULL',
  ];
  for (const sql of indexSqls) {
    h.execute(sql, (e) => `Chat V2 V20260201 索引创建失败: ${sql} (${e})`);
  }

  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, VERSION);
}

/** `pre_repair_chat_v2_v20260204`：会话分组。 */
export function preRepairChatV2V20260204(h: RepairHelpers, runner: Runner): void {
  const VERSION = 20260204;
  const PREVIOUS_VERSION = 20260203;
  if (!h.tableExists('chat_v2_sessions')) return;
  if (h.isMigrationRecorded(VERSION)) return;
  if (getCurrentVersion(h) < PREVIOUS_VERSION) return;

  h.log('info', `🔧 [PreRepair] chat_v2: 补齐 V${VERSION} 会话分组字段和索引（旧库兼容/残留修复）`);
  h.addColumnIfMissing('chat_v2_sessions', 'group_id', 'TEXT');

  h.executeBatch(
    `CREATE TABLE IF NOT EXISTS chat_v2_session_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                icon TEXT,
                color TEXT,
                system_prompt TEXT,
                default_skill_ids_json TEXT DEFAULT '[]',
                workspace_id TEXT,
                sort_order INTEGER DEFAULT 0,
                persist_status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );`,
    (e) => `Chat V2 V20260204 session_groups 创建失败: ${e}`,
  );

  const indexSqls = [
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_sort_order ON chat_v2_session_groups(sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_status ON chat_v2_session_groups(persist_status)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_workspace ON chat_v2_session_groups(workspace_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_group_id ON chat_v2_sessions(group_id)',
  ];
  for (const sql of indexSqls) {
    h.execute(sql, (e) => `Chat V2 V20260204 索引创建失败: ${sql} (${e})`);
  }

  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, VERSION);
}

// ------------------------------------------------------------------ mistakes

/** `pre_repair_mistakes_schema`。 */
export function preRepairMistakesSchema(ctx: RepairContext): void {
  const { h, runner, migrationsDir } = ctx;
  const SYNC_VERSION = 20260201;
  const SYNC_PREVIOUS_VERSION = 20260131;
  const PREVIEW_VERSION = 20260207;
  const PREVIEW_PREVIOUS_VERSION = 20260201;
  const PREVIEW_COLUMN = 'preview_data_json';
  const PREVIEW_TABLE = 'custom_anki_templates';

  const hasMistakes = h.tableExists('mistakes');
  const changeLogSql = readSql(migrationsDir, 'mistakes/V20260131__add_change_log.sql');

  if (hasMistakes) {
    applyMistakesInitCompat(h, migrationsDir);
    h.ensureChangeLogTable('mistakes', changeLogSql, 'mistakes');
  } else {
    h.ensureChangeLogTable('mistakes', changeLogSql, 'mistakes');
  }

  if (hasMistakes && getCurrentVersion(h) >= SYNC_PREVIOUS_VERSION) {
    applyMistakesSyncFieldsCompat(h);
    if (!h.isMigrationRecorded(SYNC_VERSION)) {
      h.ensureRefineryHistoryTable();
      h.log('info', `🔧 [PreRepair] mistakes: sync 字段已补齐，标记 V${SYNC_VERSION} 迁移为已完成`);
      h.markMigrationComplete(runner, SYNC_VERSION);
    }
  }

  if (hasMistakes && getCurrentVersion(h) >= PREVIEW_PREVIOUS_VERSION && h.tableExists(PREVIEW_TABLE)) {
    h.addColumnIfMissing(PREVIEW_TABLE, PREVIEW_COLUMN, 'TEXT');
    if (!h.isMigrationRecorded(PREVIEW_VERSION) && h.columnExists(PREVIEW_TABLE, PREVIEW_COLUMN)) {
      h.ensureRefineryHistoryTable();
      h.log('info', `🔧 [PreRepair] mistakes: ${PREVIEW_COLUMN} 已就绪，标记 V${PREVIEW_VERSION} 迁移为已完成`);
      h.markMigrationComplete(runner, PREVIEW_VERSION);
    }
  }
}

/** `apply_mistakes_init_compat`。 */
export function applyMistakesInitCompat(h: RepairHelpers, migrationsDir: string): void {
  const indexAndTriggerColumns: ReadonlyArray<readonly [string, string, string]> = [
    ['mistakes', 'irec_card_id', 'TEXT'],
    ['mistakes', 'updated_at', 'TEXT'],
    ['chat_messages', 'turn_id', 'TEXT'],
    ['chat_messages', 'mistake_id', 'TEXT'],
    ['document_tasks', 'document_id', 'TEXT'],
    ['document_tasks', 'status', 'TEXT'],
    ['anki_cards', 'task_id', 'TEXT'],
    ['anki_cards', 'is_error_card', 'INTEGER NOT NULL DEFAULT 0'],
    ['anki_cards', 'source_type', "TEXT NOT NULL DEFAULT ''"],
    ['anki_cards', 'source_id', "TEXT NOT NULL DEFAULT ''"],
    ['anki_cards', 'updated_at', 'TEXT'],
    ['anki_cards', 'text', 'TEXT'],
    ['anki_cards', 'tags_json', "TEXT DEFAULT '[]'"],
    ['anki_cards', 'images_json', "TEXT DEFAULT '[]'"],
    ['anki_cards', 'extra_fields_json', "TEXT DEFAULT '{}'"],
    ['review_analyses', 'updated_at', 'TEXT'],
    ['custom_anki_templates', 'is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ['custom_anki_templates', 'is_built_in', 'INTEGER NOT NULL DEFAULT 0'],
    ['document_control_states', 'document_id', 'TEXT'],
    ['document_control_states', 'state', 'TEXT'],
    ['document_control_states', 'updated_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['vectorized_data', 'mistake_id', 'TEXT'],
    ['review_session_mistakes', 'session_id', 'TEXT'],
    ['review_session_mistakes', 'mistake_id', 'TEXT'],
    ['search_logs', 'created_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['search_logs', 'search_type', 'TEXT'],
    ['exam_sheet_sessions', 'status', 'TEXT'],
  ];
  for (const [table, column, def] of indexAndTriggerColumns) h.addColumnIfMissing(table, column, def);

  const runtimeCompatColumns: ReadonlyArray<readonly [string, string, string]> = [
    ['mistakes', 'mistake_summary', 'TEXT'],
    ['mistakes', 'user_error_analysis', 'TEXT'],
    ['mistakes', 'irec_status', 'INTEGER DEFAULT 0'],
    ['chat_messages', 'graph_sources', 'TEXT'],
    ['chat_messages', 'turn_seq', 'SMALLINT'],
    ['chat_messages', 'reply_to_msg_id', 'INTEGER'],
    ['chat_messages', 'message_kind', 'TEXT'],
    ['chat_messages', 'lifecycle', 'TEXT'],
    ['chat_messages', 'metadata', 'TEXT'],
    ['review_chat_messages', 'web_search_sources', 'TEXT'],
    ['review_chat_messages', 'tool_call', 'TEXT'],
    ['review_chat_messages', 'tool_result', 'TEXT'],
    ['review_chat_messages', 'overrides', 'TEXT'],
    ['review_chat_messages', 'relations', 'TEXT'],
  ];
  for (const [table, column, def] of runtimeCompatColumns) h.addColumnIfMissing(table, column, def);

  h.executeBatch(readSql(migrationsDir, 'mistakes/V20260130__init.sql'), (e) => `回放 mistakes init 失败: ${e}`);
  h.executeBatch(readSql(migrationsDir, 'mistakes/V20260131__add_change_log.sql'), (e) => `回放 mistakes add_change_log 失败: ${e}`);

  h.addColumnIfMissing('anki_cards', 'text', 'TEXT');
  h.execute('CREATE INDEX IF NOT EXISTS idx_anki_cards_text ON anki_cards(text)', (e) => `创建 idx_anki_cards_text 失败: ${e}`);
}

/** `apply_mistakes_sync_fields_compat`。 */
export function applyMistakesSyncFieldsCompat(h: RepairHelpers): void {
  const syncColumns: ReadonlyArray<readonly [string, string, string]> = [
    ['mistakes', 'device_id', 'TEXT'],
    ['mistakes', 'local_version', 'INTEGER DEFAULT 0'],
    ['mistakes', 'deleted_at', 'TEXT'],
    ['anki_cards', 'device_id', 'TEXT'],
    ['anki_cards', 'local_version', 'INTEGER DEFAULT 0'],
    ['anki_cards', 'deleted_at', 'TEXT'],
    ['review_analyses', 'device_id', 'TEXT'],
    ['review_analyses', 'local_version', 'INTEGER DEFAULT 0'],
    ['review_analyses', 'deleted_at', 'TEXT'],
  ];
  for (const [table, column, def] of syncColumns) h.addColumnIfMissing(table, column, def);

  const syncIndexSqls = [
    'CREATE INDEX IF NOT EXISTS idx_mistakes_local_version ON mistakes(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_mistakes_deleted_at ON mistakes(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_mistakes_device_id ON mistakes(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_mistakes_updated_at ON mistakes(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_anki_cards_local_version ON anki_cards(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_anki_cards_deleted_at ON anki_cards(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_anki_cards_device_id ON anki_cards(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_anki_cards_updated_at ON anki_cards(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_review_analyses_local_version ON review_analyses(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_review_analyses_deleted_at ON review_analyses(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_review_analyses_device_id ON review_analyses(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_review_analyses_updated_at ON review_analyses(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_mistakes_device_version ON mistakes(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_anki_cards_device_version ON anki_cards(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_review_analyses_device_version ON review_analyses(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_mistakes_updated_not_deleted ON mistakes(updated_at) WHERE deleted_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_anki_cards_updated_not_deleted ON anki_cards(updated_at) WHERE deleted_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_review_analyses_updated_not_deleted ON review_analyses(updated_at) WHERE deleted_at IS NULL',
  ];
  for (const sql of syncIndexSqls) {
    h.execute(sql, (e) => `执行同步索引 SQL 失败: ${sql} (${e})`);
  }
}

// ------------------------------------------------------------------ llm_usage

/** `pre_repair_llm_usage_schema`。 */
export function preRepairLlmUsageSchema(ctx: RepairContext): void {
  const { h, runner, migrationsDir } = ctx;
  h.ensureChangeLogTable('llm_usage', readSql(migrationsDir, 'llm_usage/V20260131__add_change_log.sql'), 'llm_usage_logs');

  if (!h.tableExists('llm_usage_logs')) return;

  const CACHE_WRITE_VERSION = 20260824;
  const CACHE_WRITE_PREDECESSOR = 20260525;
  if (
    !h.isMigrationRecorded(CACHE_WRITE_VERSION) &&
    h.isMigrationRecorded(CACHE_WRITE_PREDECESSOR) &&
    h.columnExists('llm_usage_logs', 'cache_write_tokens')
  ) {
    h.log('info', `🔧 [PreRepair] llm_usage: 检测到 cache_write_tokens 已存在但 V${CACHE_WRITE_VERSION} 未记账，补齐迁移历史`);
    h.ensureRefineryHistoryTable();
    h.markMigrationComplete(runner, CACHE_WRITE_VERSION);
  }

  const SYNC_VERSION = 20260201;
  if (h.isMigrationRecorded(SYNC_VERSION)) return;

  const hasAnySyncField =
    h.columnExists('llm_usage_logs', 'device_id') ||
    h.columnExists('llm_usage_logs', 'local_version') ||
    h.columnExists('llm_usage_daily', 'device_id');
  if (!hasAnySyncField) return;

  h.log('info', `🔧 [PreRepair] llm_usage: 检测到同步字段残留，补齐并标记 V${SYNC_VERSION}`);
  const syncColumns: ReadonlyArray<readonly [string, string, string]> = [
    ['llm_usage_logs', 'device_id', 'TEXT'],
    ['llm_usage_logs', 'local_version', 'INTEGER DEFAULT 0'],
    ['llm_usage_logs', 'updated_at', 'TEXT'],
    ['llm_usage_logs', 'deleted_at', 'TEXT'],
    ['llm_usage_daily', 'device_id', 'TEXT'],
    ['llm_usage_daily', 'local_version', 'INTEGER DEFAULT 0'],
    ['llm_usage_daily', 'deleted_at', 'TEXT'],
  ];
  for (const [table, column, def] of syncColumns) h.addColumnIfMissing(table, column, def);

  const logsIndexSqls = [
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_local_version ON llm_usage_logs(local_version)',
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_deleted_at ON llm_usage_logs(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_device_id ON llm_usage_logs(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_updated_at ON llm_usage_logs(updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_device_version ON llm_usage_logs(device_id, local_version)',
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_updated_not_deleted ON llm_usage_logs(updated_at) WHERE deleted_at IS NULL',
  ];
  for (const sql of logsIndexSqls) {
    h.execute(sql, (e) => `LLM Usage 索引创建失败: ${sql} (${e})`);
  }

  if (h.tableExists('llm_usage_daily')) {
    const dailyIndexSqls = [
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_local_version ON llm_usage_daily(local_version)',
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_deleted_at ON llm_usage_daily(deleted_at)',
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_device_id ON llm_usage_daily(device_id)',
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_updated_at ON llm_usage_daily(updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_device_version ON llm_usage_daily(device_id, local_version)',
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_updated_not_deleted ON llm_usage_daily(updated_at) WHERE deleted_at IS NULL',
    ];
    for (const sql of dailyIndexSqls) {
      h.execute(sql, (e) => `LLM Usage 索引创建失败: ${sql} (${e})`);
    }
  }

  h.ensureRefineryHistoryTable();
  h.markMigrationComplete(runner, SYNC_VERSION);
}

// ------------------------------------------------------------------ 已记录迁移的 schema 缺口

/** `repair_recorded_migration_schema_gaps`：返回是否做了 schema/数据修复。 */
export function repairRecordedMigrationSchemaGaps(ctx: RepairContext): boolean {
  switch (ctx.id) {
    case 'vfs':
      return repairVfsV20260714VectorIndexProfiles(ctx);
    case 'mistakes':
      return repairMistakesV20260523DocumentTasks(ctx.h);
    default:
      return false;
  }
}

/** `repair_vfs_v20260714_vector_index_profiles`。 */
export function repairVfsV20260714VectorIndexProfiles(ctx: RepairContext): boolean {
  const { h, runner, set } = ctx;
  const VERSION = 20260714;
  if (!h.isMigrationRecorded(VERSION) || !h.tableExists('resources')) return false;

  const MIGRATION = set.get(VERSION);
  if (MIGRATION === undefined) {
    throw MigrationError.database(`VFS migration set does not contain V${VERSION}`);
  }
  const current = runner.getMigrations().find((m) => m.version === VERSION);
  if (current === undefined) {
    throw MigrationError.database(`VFS migration runner does not contain V${VERSION}`);
  }
  const recordedChecksum = pluck<string>(h, 'SELECT checksum FROM refinery_schema_history WHERE version = ?1', [VERSION]);
  if (recordedChecksum === undefined) throw MigrationError.database('Query returned no rows');
  const checksumDrift = recordedChecksum !== current.checksum.toString();

  let schemaOrDataRepair = checksumDrift;
  if (h.tableExists('vfs_index_profiles')) {
    for (const column of ['id', 'model_fingerprint', 'dimension', 'modality', 'embedding_protocol', 'lance_table_name']) {
      if (!h.columnExists('vfs_index_profiles', column)) {
        throw MigrationError.database(`recorded VFS V${VERSION} has an incompatible vfs_index_profiles table: missing ${column}`);
      }
    }
    const columns: ReadonlyArray<readonly [string, string]> = [
      ['model_config_id', 'TEXT'],
      ['model_name', 'TEXT'],
      ['schema_version', 'INTEGER NOT NULL DEFAULT 1'],
      ['active_generation', 'INTEGER NOT NULL DEFAULT 0'],
      ['state', "TEXT NOT NULL DEFAULT 'active'"],
      ['ann_metric', "TEXT NOT NULL DEFAULT 'legacy_l2'"],
      ['ann_index_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [column, definition] of columns) {
      schemaOrDataRepair = h.addColumnIfMissing('vfs_index_profiles', column, definition) || schemaOrDataRepair;
    }
  }

  for (const [table, column] of parseAlterAddColumns(MIGRATION.sql)) {
    if (!h.tableExists(table)) {
      throw MigrationError.database(`recorded VFS V${VERSION} requires missing base table ${table}`);
    }
    const definition = extractColumnDef(MIGRATION.sql, table, column);
    schemaOrDataRepair = h.addColumnIfMissing(table, column, definition) || schemaOrDataRepair;
  }

  for (const table of MIGRATION.expectedTables) schemaOrDataRepair = !h.tableExists(table) || schemaOrDataRepair;
  for (const [table, column] of MIGRATION.expectedColumns) {
    schemaOrDataRepair = !h.columnExists(table, column) || schemaOrDataRepair;
  }
  let missingIndex = false;
  for (const index of MIGRATION.expectedIndexes) missingIndex = !h.indexExists(index) || missingIndex;

  if (!schemaOrDataRepair && !missingIndex) return false;

  if (schemaOrDataRepair) {
    h.replayMigrationWithoutAlterAddColumns(MIGRATION.sql, VERSION);
  } else {
    h.executeBatch(
      `CREATE INDEX IF NOT EXISTS idx_vfs_index_profiles_route
                    ON vfs_index_profiles(modality, dimension, state);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_profiles_model
                    ON vfs_index_profiles(model_config_id, state);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_segments_profile_generation
                    ON vfs_index_segments(index_profile_id, generation);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_units_text_profile
                    ON vfs_index_units(text_profile_id, text_generation);
                 CREATE INDEX IF NOT EXISTS idx_vfs_index_units_mm_profile
                    ON vfs_index_units(mm_profile_id, mm_generation);
                 CREATE INDEX IF NOT EXISTS idx_resources_index_retry_due
                    ON resources(index_state, index_next_retry_at);
                 CREATE INDEX IF NOT EXISTS idx_resources_mm_index_retry_due
                    ON resources(mm_index_state, mm_index_next_retry_at);
                 CREATE INDEX IF NOT EXISTS idx_lance_orphan_retry_due
                    ON __lance_orphan_queue(next_retry_at, enqueued_at);`,
    );
  }

  MigrationVerifier.verify(h.conn, MIGRATION);
  h.log('warn', 'Repaired recorded vector profile migration schema gap', { database: 'vfs', version: VERSION });
  return true;
}

/** `repair_mistakes_v20260523_document_tasks`。 */
export function repairMistakesV20260523DocumentTasks(h: RepairHelpers): boolean {
  const VERSION = 20260523;
  if (!h.isMigrationRecorded(VERSION) || !h.tableExists('document_tasks')) return false;

  let repaired = false;
  const columns: ReadonlyArray<readonly [string, string]> = [
    ['device_id', 'TEXT'],
    ['local_version', 'INTEGER DEFAULT 0'],
    ['deleted_at', 'TEXT'],
  ];
  for (const [column, definition] of columns) {
    repaired = h.addColumnIfMissing('document_tasks', column, definition) || repaired;
  }

  const indexes: ReadonlyArray<readonly [string, string]> = [
    ['idx_document_tasks_local_version', 'CREATE INDEX IF NOT EXISTS idx_document_tasks_local_version ON document_tasks(local_version)'],
    ['idx_document_tasks_deleted_at', 'CREATE INDEX IF NOT EXISTS idx_document_tasks_deleted_at ON document_tasks(deleted_at)'],
    ['idx_document_tasks_device_id', 'CREATE INDEX IF NOT EXISTS idx_document_tasks_device_id ON document_tasks(device_id)'],
    ['idx_document_tasks_sync_updated_at', 'CREATE INDEX IF NOT EXISTS idx_document_tasks_sync_updated_at ON document_tasks(updated_at)'],
    [
      'idx_document_tasks_device_version',
      'CREATE INDEX IF NOT EXISTS idx_document_tasks_device_version ON document_tasks(device_id, local_version)',
    ],
    [
      'idx_document_tasks_updated_not_deleted',
      'CREATE INDEX IF NOT EXISTS idx_document_tasks_updated_not_deleted ON document_tasks(updated_at) WHERE deleted_at IS NULL',
    ],
  ];
  for (const [name, sql] of indexes) {
    if (!h.indexExists(name)) repaired = true;
    h.execute(sql, (e) => `repair mistakes V${VERSION} index ${name} failed: ${e}`);
  }

  const triggers: ReadonlyArray<readonly [string, string]> = [
    [
      'trg__change_log_document_tasks_insert',
      `CREATE TRIGGER IF NOT EXISTS trg__change_log_document_tasks_insert
AFTER INSERT ON document_tasks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('document_tasks', NEW.id, 'INSERT');
END;`,
    ],
    [
      'trg__change_log_document_tasks_update',
      `CREATE TRIGGER IF NOT EXISTS trg__change_log_document_tasks_update
AFTER UPDATE ON document_tasks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('document_tasks', NEW.id, 'UPDATE');
END;`,
    ],
    [
      'trg__change_log_document_tasks_delete',
      `CREATE TRIGGER IF NOT EXISTS trg__change_log_document_tasks_delete
AFTER DELETE ON document_tasks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('document_tasks', OLD.id, 'DELETE');
END;`,
    ],
  ];
  for (const [name, sql] of triggers) {
    if (!h.triggerExists(name)) repaired = true;
    h.executeBatch(sql, (e) => `repair mistakes V${VERSION} trigger ${name} failed: ${e}`);
  }

  if (repaired) {
    h.log('warn', 'Repaired recorded migration schema gap for document_tasks sync coverage', { database: 'mistakes', version: VERSION });
  }
  return repaired;
}
