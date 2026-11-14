/**
 * 移植自 dstu-storage/src/migration/coordinator.rs #[cfg(test)] 中只依赖修复函数的用例。
 * `verify_migrations` 在这里用其中的契约验证部分（逐个 MigrationVerifier::verify，版本 ≤ current）
 * 代替；schema 指纹部分属于协调器，见 TESTMAP。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import type { CoordinatedDatabaseName } from '../api.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationSets } from '../migration/definitions/index.ts';
import type { MigrationSet } from '../migration/definitions.ts';
import { MigrationError } from '../migration/errors.ts';
import { RepairHelpers } from '../migration/helpers.ts';
import { loadSqlMigrations, Runner } from '../migration/refinery.ts';
import {
  applyMistakesInitCompat,
  applyVfsInitMissingSchemaObjects,
  applyVfsInitMissingTables,
  cleanupIntermediateTables,
  ensureLegacyBaseline,
  preRepairSchema,
  preRepairVfsSchema,
  preRepairVfsV20260824NoteProps,
  repairRecordedMigrationSchemaGaps,
  type RepairContext,
} from '../migration/repairs.ts';
import { extractCreateTableIfNotExists, splitSqlStatements } from '../migration/sql-text.ts';
import { MigrationVerifier } from '../migration/verifier.ts';

const DIR = DEFAULT_MIGRATIONS_DIR;
const sets = loadMigrationSets(DIR);
const readSql = (file: string) => fs.readFileSync(path.join(DIR, file), 'utf8');

const opened: Connection[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await setImmediate();
});

function tempDb(name: string): Connection {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-repairs-'));
  tempDirs.push(dir);
  const conn = new Connection(path.join(dir, name), { label: name, profile: PROFILES.plain });
  opened.push(conn);
  return conn;
}

const quiet = () => undefined;
// Runner/Migration 不可变（Rust `migrations::runner()` 每次重建只是为了拿同一份嵌入迁移）；
// 每个库只加载并计算 checksum 一次，避免每个用例重复读盘+哈希全部迁移 SQL。
const runners = new Map<CoordinatedDatabaseName, Runner>();
const runnerFor = (id: CoordinatedDatabaseName) => {
  let runner = runners.get(id);
  if (runner === undefined) runners.set(id, (runner = new Runner(loadSqlMigrations(path.join(DIR, id)))));
  return runner;
};

function ctxFor(conn: Connection, id: CoordinatedDatabaseName): RepairContext {
  return { h: new RepairHelpers(conn, quiet), id, runner: runnerFor(id), set: sets[id], migrationsDir: DIR };
}

/** `verify_migrations` 的契约部分。 */
function verifyThrough(conn: Connection, set: MigrationSet, version: number): void {
  for (const def of set.migrations) {
    if (def.refineryVersion <= version) MigrationVerifier.verify(conn, def);
  }
}

function exists(conn: Connection, type: string, name: string): boolean {
  return conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)', [type, name]) === 1;
}

function recorded(conn: Connection, version: number): boolean {
  return conn.pluck<number>('SELECT COUNT(*) FROM refinery_schema_history WHERE version = ?1', [version]) === 1;
}

/** `build_v0944_vfs`：按 runner 真实 name/checksum 记账到 V20260808。 */
function buildV0944Vfs(): RepairContext {
  // Rust coordinator.rs:5551 uses open_in_memory; this fixture does not test durability.
  const conn = new Connection(':memory:', { label: 'vfs', profile: PROFILES.plain });
  opened.push(conn);
  const ctx = ctxFor(conn, 'vfs');
  ctx.h.ensureRefineryHistoryTable();
  for (const m of ctx.runner.getMigrations().filter((m) => m.version <= 20260808)) {
    conn.exec(m.sql!);
    ctx.h.markMigrationComplete(ctx.runner, m.version);
  }
  return ctx;
}

describe('coordinator.rs sql splitter', () => {
  it('sql_splitter_keeps_case_end_inside_trigger_body', () => {
    const sql = `
            ALTER TABLE sample ADD COLUMN extra TEXT;
            CREATE TRIGGER sample_ai AFTER INSERT ON sample
            BEGIN
                INSERT INTO audit(value)
                VALUES (CASE WHEN NEW.extra IS NULL THEN 'none' ELSE NEW.extra END);
                UPDATE counters SET value = value + 1;
            END;
            CREATE INDEX sample_extra ON sample(extra);
        `;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('CASE WHEN');
    expect(statements[1]).toContain('UPDATE counters');
    expect(statements[1]!.trimEnd().endsWith('END')).toBe(true);
  });

  it('sql_splitter_delegates_quotes_comments_and_transactions_to_sqlite', () => {
    const sql = `
            /* a block comment containing ; and CASE END */
            CREATE TABLE [odd;table] (\`semi;column\` TEXT, "double;column" TEXT);
            INSERT INTO [odd;table] VALUES ('value;still-string', 'x');
            BEGIN TRANSACTION;
            UPDATE [odd;table] SET \`semi;column\` = 'inside;transaction';
            COMMIT;
        `;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('[odd;table]');
    expect(statements[1]).toContain('value;still-string');
    expect(statements[2]).toBe('BEGIN TRANSACTION');
    expect(statements[4]).toBe('COMMIT');
  });
});

describe('ensure_legacy_baseline', () => {
  it('test_legacy_baseline_skips_when_init_contract_missing', () => {
    const conn = tempDb('mistakes.db');
    conn.run('CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL)');
    conn.run('CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
    ensureLegacyBaseline(ctxFor(conn, 'mistakes'));
    expect(conn.pluck<number>('SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260130')).toBe(0);
  });

  it('test_legacy_baseline_writes_record_when_init_contract_satisfied', () => {
    const conn = tempDb('mistakes.db');
    conn.exec(readSql('mistakes/V20260130__init.sql'));
    conn.run('CREATE TABLE IF NOT EXISTS migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL)');
    ensureLegacyBaseline(ctxFor(conn, 'mistakes'));
    expect(conn.pluck<number>('SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260130')).toBe(1);
    expect(conn.pluck<string>("SELECT checksum FROM refinery_schema_history WHERE version = 20260130")).toBe('0');
    // 已有记录时幂等
    ensureLegacyBaseline(ctxFor(conn, 'mistakes'));
    expect(conn.pluck<number>('SELECT COUNT(*) FROM refinery_schema_history')).toBe(1);
  });

  it('detect_legacy_migration: fresh database is not baselined', () => {
    const conn = tempDb('chat_v2.db');
    ensureLegacyBaseline(ctxFor(conn, 'chat_v2'));
    expect(exists(conn, 'table', 'refinery_schema_history')).toBe(false);
  });
});

describe('cleanup_intermediate_tables', () => {
  it('drops known *_new tables for the database', () => {
    const conn = tempDb('vfs.db');
    conn.exec('CREATE TABLE vfs_blobs_new (id TEXT); CREATE TABLE other_new (id TEXT);');
    cleanupIntermediateTables(ctxFor(conn, 'vfs'));
    expect(exists(conn, 'table', 'vfs_blobs_new')).toBe(false);
    expect(exists(conn, 'table', 'other_new')).toBe(true);
  });
});

describe('mistakes compat', () => {
  it('test_apply_mistakes_init_compat_repairs_legacy_schema', () => {
    const conn = tempDb('mistakes.db');
    conn.exec(`
            CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL);
            CREATE TABLE document_tasks (id TEXT PRIMARY KEY);
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, mistake_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, stable_id TEXT);
            CREATE TABLE review_chat_messages (id INTEGER PRIMARY KEY, review_analysis_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL);
            `);
    applyMistakesInitCompat(new RepairHelpers(conn, quiet), DIR);
    expect(conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')")).toBe(1);
    expect(exists(conn, 'table', 'review_sessions')).toBe(true);
  });

  it('test_apply_mistakes_init_compat_is_idempotent_on_sparse_legacy_schema', () => {
    const conn = tempDb('mistakes.db');
    conn.exec(`
            CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
            CREATE TABLE document_tasks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL DEFAULT '',
                original_document_name TEXT NOT NULL DEFAULT '',
                segment_index INTEGER NOT NULL DEFAULT 0,
                content_segment TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Pending',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                anki_generation_options_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT '',
                card_order_in_task INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                template_id TEXT,
                text TEXT
            );
            CREATE TABLE chat_messages (
                id INTEGER PRIMARY KEY,
                mistake_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                stable_id TEXT
            );
            CREATE TABLE review_chat_messages (
                id INTEGER PRIMARY KEY,
                review_analysis_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            CREATE TABLE custom_anki_templates (
                id TEXT PRIMARY KEY,
                name TEXT,
                generation_prompt TEXT,
                front_template TEXT,
                back_template TEXT,
                css_style TEXT
            );
            `);
    const h = new RepairHelpers(conn, quiet);
    applyMistakesInitCompat(h, DIR);
    applyMistakesInitCompat(h, DIR);
    expect(h.columnExists('mistakes', 'irec_card_id')).toBe(true);
    expect(h.columnExists('chat_messages', 'turn_id')).toBe(true);
    expect(exists(conn, 'index', 'idx_anki_cards_text')).toBe(true);
  });

  it('test_mistakes_recorded_v20260523_document_tasks_gap_is_repaired_and_rebaselined (repair + contract part)', () => {
    const conn = tempDb('mistakes.db');
    for (const file of [
      'V20260130__init.sql',
      'V20260131__add_change_log.sql',
      'V20260201__add_sync_fields.sql',
      'V20260207__add_template_preview_data.sql',
      'V20260208__add_hot_query_indexes.sql',
      'V20260209__anki_card_dedup_unique.sql',
      'V20260524__add_change_log_field_deltas.sql',
    ]) {
      conn.exec(readSql(`mistakes/${file}`));
    }
    const ctx = ctxFor(conn, 'mistakes');
    ctx.h.ensureRefineryHistoryTable();
    for (const [version, name] of [
      [20260130, 'init'],
      [20260131, 'add_change_log'],
      [20260201, 'add_sync_fields'],
      [20260207, 'add_template_preview_data'],
      [20260208, 'add_hot_query_indexes'],
      [20260209, 'anki_card_dedup_unique'],
      [20260523, 'add_missing_sync_coverage'],
      [20260524, 'add_change_log_field_deltas'],
    ] as const) {
      conn.run(
        `INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (?1, ?2, '2026-06-30T00:00:00Z', '0')`,
        [version, name],
      );
    }
    conn.run('CREATE TABLE IF NOT EXISTS runtime_documents (id TEXT PRIMARY KEY, body TEXT)');

    expect(repairRecordedMigrationSchemaGaps(ctx)).toBe(true);
    verifyThrough(conn, ctx.set, 20260524);
    for (const column of ['device_id', 'local_version', 'deleted_at']) {
      expect(ctx.h.columnExists('document_tasks', column)).toBe(true);
    }
    expect(exists(conn, 'index', 'idx_document_tasks_device_version')).toBe(true);
    expect(exists(conn, 'trigger', 'trg__change_log_document_tasks_insert')).toBe(true);
    // 收敛后再跑不再报告修复
    expect(repairRecordedMigrationSchemaGaps(ctx)).toBe(false);
  });
});

describe('vfs pre-repair', () => {
  it('test_extract_vfs_init_create_tables_includes_change_log_parents', () => {
    const names = extractCreateTableIfNotExists(readSql('vfs/V20260130__init.sql')).map(([n]) => n);
    for (const required of ['resources', 'notes', 'questions', 'review_plans', 'folders']) expect(names).toContain(required);
    expect(names).not.toContain('questions_fts');
  });

  it('test_pre_repair_vfs_backfills_questions_before_change_log', () => {
    const conn = tempDb('vfs.db');
    conn.run('PRAGMA foreign_keys = ON');
    conn.exec(`
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL,
                storage_mode TEXT NOT NULL DEFAULT 'inline',
                ref_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                resource_id TEXT NOT NULL,
                title TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                is_favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            `);
    preRepairVfsSchema(ctxFor(conn, 'vfs'));
    expect(exists(conn, 'table', 'questions')).toBe(true);
    expect(exists(conn, 'table', '__change_log')).toBe(true);
    // FK 状态在 apply_vfs_init_missing_tables 后恢复
    expect(Number(conn.pragmaValue('foreign_keys'))).toBe(1);
  });

  it('test_vfs_init_backfill_restores_recorded_note_props_contract', () => {
    const conn = tempDb('vfs.db');
    conn.run('CREATE TABLE resources (id TEXT PRIMARY KEY)');
    const h = new RepairHelpers(conn, quiet);
    h.ensureRefineryHistoryTable();
    conn.run(
      `INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260824, 'note_props', '2026-08-24T00:00:00Z', 'recorded')`,
    );
    applyVfsInitMissingTables(h, DIR);
    expect(h.tableExists('notes')).toBe(true);
    expect(h.columnExists('notes', 'props')).toBe(true);
  });

  it('test_v20260824_recorded_schema_gap_backfills_props_column', () => {
    const ctx = buildV0944Vfs();
    ctx.h.markMigrationComplete(ctx.runner, 20260824);
    preRepairVfsV20260824NoteProps(ctx.h, ctx.runner);
    expect(ctx.h.columnExists('notes', 'props')).toBe(true);
  });

  it('pre_repair_vfs_v20260824_note_props: column present without history is recorded', () => {
    const ctx = buildV0944Vfs();
    ctx.h.conn.run('ALTER TABLE notes ADD COLUMN props TEXT');
    preRepairVfsV20260824NoteProps(ctx.h, ctx.runner);
    expect(recorded(ctx.h.conn, 20260824)).toBe(true);
    const checksum = ctx.h.conn.pluck<string>('SELECT checksum FROM refinery_schema_history WHERE version = 20260824');
    expect(checksum).toBe(ctx.runner.getMigrations().find((m) => m.version === 20260824)!.checksum.toString());
  });
});

// ------------------------------------------------------------------ 稀疏 VFS（P8 / R7）

function buildSparseV20260130RecordedVfs(): RepairContext {
  const conn = tempDb('vfs.db');
  let created = 0;
  for (const [name, statement] of extractCreateTableIfNotExists(readSql('vfs/V20260130__init.sql'))) {
    if (name === 'resources' || name === 'notes') {
      conn.exec(statement);
      created++;
    }
  }
  expect(created).toBe(2);
  expect(conn.pluck<number>("SELECT COUNT(*) FROM sqlite_master WHERE type != 'table' AND name NOT LIKE 'sqlite_autoindex%'")).toBe(0);
  const ctx = ctxFor(conn, 'vfs');
  ctx.h.ensureRefineryHistoryTable();
  ctx.h.markMigrationComplete(ctx.runner, 20260130);
  return ctx;
}

function expectInitRejection(fn: () => void, names?: readonly string[]): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationError);
  const detail = (caught as MigrationError).detail;
  expect(detail.kind).toBe('VerificationFailed');
  if (detail.kind !== 'VerificationFailed') return;
  expect(detail.version).toBe(20260130);
  if (names === undefined) {
    expect(
      (detail.reason.includes("Index '") && detail.reason.includes('not found')) ||
        detail.reason.includes('questions_fts') ||
        detail.reason.includes('trash_view'),
    ).toBe(true);
  } else {
    expect(names.some((n) => detail.reason.includes(n))).toBe(true);
  }
}

describe('sparse VFS', () => {
  it('test_sparse_vfs_v20260130_recorded_missing_index_fts_view_is_rejected', () => {
    const ctx = buildSparseV20260130RecordedVfs();
    applyVfsInitMissingTables(ctx.h, DIR);
    for (const table of ['questions', 'folders', 'review_plans', 'files', 'blobs']) expect(ctx.h.tableExists(table)).toBe(true);
    expect(exists(ctx.h.conn, 'index', 'idx_folders_parent')).toBe(false);
    expect(exists(ctx.h.conn, 'table', 'questions_fts')).toBe(false);
    expect(exists(ctx.h.conn, 'view', 'trash_view')).toBe(false);
    expectInitRejection(() => verifyThrough(ctx.h.conn, ctx.set, 20260130));
  });

  it('test_sparse_vfs_after_init_object_backfill_passes_verifier', () => {
    const ctx = buildSparseV20260130RecordedVfs();
    applyVfsInitMissingTables(ctx.h, DIR);
    applyVfsInitMissingSchemaObjects(ctx.h, DIR);
    expect(exists(ctx.h.conn, 'index', 'idx_folders_parent')).toBe(true);
    expect(exists(ctx.h.conn, 'table', 'questions_fts')).toBe(true);
    expect(exists(ctx.h.conn, 'view', 'trash_view')).toBe(true);
    verifyThrough(ctx.h.conn, ctx.set, 20260130);
  });

  const IDX: readonly [string, string, string] = ['index', 'idx_folders_parent', 'DROP INDEX idx_folders_parent'];
  const FTS: readonly [string, string, string] = ['table', 'questions_fts', 'DROP TABLE questions_fts'];
  const VIEW: readonly [string, string, string] = ['view', 'trash_view', 'DROP VIEW trash_view'];

  function buildFullWithDropped(dropped: ReadonlyArray<readonly [string, string, string]>): RepairContext {
    const conn = tempDb('vfs.db');
    conn.exec(readSql('vfs/V20260130__init.sql'));
    for (const [type, name, drop] of dropped) {
      expect(exists(conn, type, name)).toBe(true);
      conn.exec(drop);
      expect(exists(conn, type, name)).toBe(false);
    }
    for (const [type, name] of [IDX, FTS, VIEW]) {
      if (dropped.some(([, d]) => d === name)) continue;
      expect(exists(conn, type, name)).toBe(true);
    }
    const ctx = ctxFor(conn, 'vfs');
    ctx.h.ensureRefineryHistoryTable();
    ctx.h.markMigrationComplete(ctx.runner, 20260130);
    return ctx;
  }

  function assertRejectedThenBackfilled(ctx: RepairContext, dropped: ReadonlyArray<readonly [string, string, string]>): void {
    applyVfsInitMissingTables(ctx.h, DIR);
    for (const [type, name] of dropped) expect(exists(ctx.h.conn, type, name)).toBe(false);
    expectInitRejection(
      () => verifyThrough(ctx.h.conn, ctx.set, 20260130),
      dropped.map(([, n]) => n),
    );
    applyVfsInitMissingSchemaObjects(ctx.h, DIR);
    for (const [type, name] of [IDX, FTS, VIEW]) expect(exists(ctx.h.conn, type, name)).toBe(true);
    verifyThrough(ctx.h.conn, ctx.set, 20260130);
  }

  it('test_sparse_matrix_vfs_missing_idx_folders_parent_rejected_then_backfilled', () => {
    assertRejectedThenBackfilled(buildFullWithDropped([IDX]), [IDX]);
  });

  it('test_sparse_matrix_vfs_missing_questions_fts_rejected_then_backfilled', () => {
    const ctx = buildFullWithDropped([FTS]);
    const triggers = ['trg_questions_fts_insert', 'trg_questions_fts_update', 'trg_questions_fts_delete'];
    for (const t of triggers) expect(exists(ctx.h.conn, 'trigger', t)).toBe(true);
    assertRejectedThenBackfilled(ctx, [FTS]);
    for (const t of triggers) {
      expect(ctx.h.conn.pluck<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?1", [t])).toBe(1);
    }
  });

  it('test_sparse_matrix_vfs_missing_trash_view_rejected_then_backfilled', () => {
    assertRejectedThenBackfilled(buildFullWithDropped([VIEW]), [VIEW]);
  });

  it('test_sparse_matrix_vfs_missing_all_three_objects_rejected_then_backfilled', () => {
    assertRejectedThenBackfilled(buildFullWithDropped([IDX, FTS, VIEW]), [IDX, FTS, VIEW]);
  });
});

describe('repair_vfs_v20260714_vector_index_profiles', () => {
  it('test_vfs_recorded_v20260714_schema_gap_is_repaired_idempotently (checksum reconcile emulated)', () => {
    const conn = tempDb('vfs.db');
    conn.exec(`CREATE TABLE refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            );
            INSERT INTO refinery_schema_history VALUES (
                20260714, 'add_vector_index_profiles',
                '2026-07-14T00:00:00Z', 'old-draft'
            );
            CREATE TABLE vfs_embedding_dims (
                dimension INTEGER NOT NULL,
                modality TEXT NOT NULL,
                lance_table_name TEXT NOT NULL,
                record_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL,
                model_config_id TEXT,
                model_name TEXT,
                PRIMARY KEY (dimension, modality)
            );
            CREATE TABLE vfs_index_profiles (
                id TEXT PRIMARY KEY,
                model_fingerprint TEXT NOT NULL,
                dimension INTEGER NOT NULL,
                modality TEXT NOT NULL,
                embedding_protocol TEXT NOT NULL,
                lance_table_name TEXT NOT NULL
            );
            CREATE TABLE vfs_index_units (
                id TEXT PRIMARY KEY,
                text_embedding_dim INTEGER,
                mm_embedding_dim INTEGER,
                text_required INTEGER NOT NULL DEFAULT 0,
                text_state TEXT NOT NULL DEFAULT 'disabled',
                text_error TEXT,
                mm_required INTEGER NOT NULL DEFAULT 0,
                mm_state TEXT NOT NULL DEFAULT 'disabled',
                mm_error TEXT
            );
            CREATE TABLE vfs_index_segments (
                id TEXT PRIMARY KEY,
                embedding_dim INTEGER NOT NULL,
                modality TEXT NOT NULL
            );
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                index_state TEXT,
                index_error TEXT,
                index_retry_count INTEGER DEFAULT 0,
                mm_index_state TEXT,
                mm_index_error TEXT,
                mm_index_retry_count INTEGER DEFAULT 0
            );
            CREATE TABLE __lance_orphan_queue (
                lance_row_id TEXT PRIMARY KEY,
                enqueued_at INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO vfs_embedding_dims VALUES (
                768, 'text', 'legacy_text_768', 1, 1, 1, 'cfg-text', 'text-model'
            );
            INSERT INTO vfs_index_units (
                id, text_embedding_dim, text_required, text_state
            ) VALUES ('unit-1', 768, 1, 'indexed');
            INSERT INTO vfs_index_segments (id, embedding_dim, modality)
            VALUES ('segment-1', 768, 'text');
            INSERT INTO resources (
                id, index_state, index_retry_count, mm_index_state, mm_index_retry_count
            ) VALUES ('resource-1', 'indexed', 2, NULL, 0);`);
    const ctx = ctxFor(conn, 'vfs');
    const checksum = ctx.runner.getMigrations().find((m) => m.version === 20260714)!.checksum.toString();
    // repair_refinery_checksums（协调器）在验证通过后把同名漂移对齐为当前 checksum；这里直接执行该对齐结果。
    const reconcile = () =>
      conn.run('UPDATE refinery_schema_history SET name = ?1, checksum = ?2 WHERE version = ?3', [
        'add_vector_index_profiles',
        checksum,
        20260714,
      ]);

    expect(repairRecordedMigrationSchemaGaps(ctx)).toBe(true);
    reconcile();
    MigrationVerifier.verify(conn, ctx.set.get(20260714)!);
    const row = conn.get<{ text_profile_id: string; index_state: string }>(
      `SELECT u.text_profile_id, r.index_state
                 FROM vfs_index_units u, resources r
                 WHERE u.id = 'unit-1' AND r.id = 'resource-1'`,
    )!;
    expect(row.text_profile_id).toBe('profile_legacy_text_768');
    expect(row.index_state).toBe('pending');

    conn.exec(`INSERT INTO vfs_embedding_dims (
                dimension, modality, lance_table_name, record_count, created_at,
                last_used_at, model_config_id, model_name, active_profile_id,
                model_fingerprint, embedding_protocol, active_generation,
                ann_metric, ann_index_version
             ) VALUES (
                512, 'image', 'legacy_image_512', 1, 1, 1, 'cfg-image',
                'image-model', 'profile_legacy_image_512',
                'legacy:model-config:cfg-image', 'text-embedding-v1', 0,
                'legacy_l2', 0
             );
             INSERT INTO vfs_index_profiles (
                id, model_fingerprint, model_config_id, model_name, dimension,
                modality, embedding_protocol, schema_version, lance_table_name,
                active_generation, state, ann_metric, ann_index_version,
                created_at, updated_at
             ) VALUES (
                'profile_legacy_image_512', 'legacy:model-config:cfg-image',
                'cfg-image', 'image-model', 512, 'image', 'text-embedding-v1',
                1, 'legacy_image_512', 0, 'active', 'legacy_l2', 0, 1, 1
             );
             INSERT INTO vfs_index_units (
                id, mm_embedding_dim, mm_required, mm_state
             ) VALUES ('unit-image', 512, 1, 'indexed');
             UPDATE refinery_schema_history
             SET checksum = 'old-semantic-draft'
             WHERE version = 20260714;`);

    expect(repairRecordedMigrationSchemaGaps(ctx)).toBe(true);
    reconcile();
    const sem = conn.get<{ d: string; p: string; u: string }>(
      `SELECT d.embedding_protocol AS d, p.embedding_protocol AS p, u.mm_profile_id AS u
                 FROM vfs_embedding_dims d
                 JOIN vfs_index_profiles p ON p.id = d.active_profile_id
                 JOIN vfs_index_units u ON u.id = 'unit-image'
                 WHERE d.dimension = 512 AND d.modality = 'image'`,
    )!;
    expect(sem.d).toBe('multimodal-embedding-v1');
    expect(sem.p).toBe('multimodal-embedding-v1');
    expect(sem.u).toBe('profile_legacy_image_512');

    expect(repairRecordedMigrationSchemaGaps(ctx)).toBe(false);
  });
});

describe('pre_repair_schema dispatch on fresh databases', () => {
  it('is a no-op that leaves fresh databases empty except change_log guards', () => {
    for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
      const conn = tempDb(`${id}.db`);
      preRepairSchema(ctxFor(conn, id));
      expect(conn.pluck<number>("SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")).toBe(0);
    }
  });
});

describe('chat_v2 / llm_usage pre-repair', () => {
  it('pre_repair_chat_v2_v20260201: legacy db at V20260131 gets sync columns and is recorded', () => {
    const conn = tempDb('chat_v2.db');
    conn.exec(readSql('chat_v2/V20260130__init.sql'));
    conn.exec(readSql('chat_v2/V20260131__add_change_log.sql'));
    const ctx = ctxFor(conn, 'chat_v2');
    ctx.h.ensureRefineryHistoryTable();
    ctx.h.markMigrationComplete(ctx.runner, 20260130);
    ctx.h.markMigrationComplete(ctx.runner, 20260131);
    preRepairSchema(ctx);
    expect(ctx.h.columnExists('chat_v2_messages', 'local_version')).toBe(true);
    expect(exists(conn, 'index', 'idx_chat_v2_blocks_updated_not_deleted')).toBe(true);
    expect(recorded(conn, 20260201)).toBe(true);
    // 20260204 的前置版本是 20260203，本库只到 20260201，不应抢跑
    expect(recorded(conn, 20260204)).toBe(false);
  });

  it('pre_repair_llm_usage_schema: cache_write_tokens present without history is recorded', () => {
    const conn = tempDb('llm_usage.db');
    const ctx = ctxFor(conn, 'llm_usage');
    ctx.h.ensureRefineryHistoryTable();
    for (const m of ctx.runner.getMigrations().filter((m) => m.version <= 20260525)) {
      conn.exec(m.sql!);
      ctx.h.markMigrationComplete(ctx.runner, m.version);
    }
    conn.run('ALTER TABLE llm_usage_logs ADD COLUMN cache_write_tokens INTEGER');
    preRepairSchema(ctx);
    expect(recorded(conn, 20260824)).toBe(true);
  });
});
