/** SQL-replayed Rust-format fixtures, NOT databases emitted by a Rust binary. */
// boundary-allow native-import: X3 独立构造/只读比对 Rust SQL 旧库样本，按验收要求直接用 better-sqlite3，禁止用被测 Host 迁移器自造样本；仅测试 fixture。
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refineryChecksum } from '../../../platform/storage/migration/refinery.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = resolve(HERE, '../../..');
export const MIGRATIONS = join(ROOT, 'resources/app/migrations');
export const DATABASES = ['vfs', 'chat_v2', 'mistakes', 'llm_usage', 'browser'] as const;
export type FixtureDb = typeof DATABASES[number];
export const APPLIED_ON = '2026-10-30T01:02:03.123456789Z';
export const ISO = '2026-10-01T01:02:03.123456789+08:00';
export const UTC = '2026-09-30T17:02:03.123456789Z';
export const SQL_TIME = '2026-10-01 01:02:03';
export const MS = 1790816523123;
export const LARGE = 9007199254740991;
export const TOKENS = 4294967295; // UsageRecord token fields are Rust u32, not i64.
export const I64 = 9007199254740993n;
export const JSON_TEXT = '{ "中文": "升级📚", "nil": null, "n": 9007199254740991, "ok": true }';
export const TAGS = '[ "中文", "📚" ]';
export type SeedRow = Record<string, string | number | bigint | null>;

// Values are explicit, not obtained from Host serializers. Defaults are supplied by Rust SQL.
export const SEEDS: Record<FixtureDb, Record<string, SeedRow[]>> = {
  vfs: {
    resources: [{ id: 'res_old', hash: 'old-note-hash', type: 'note', source_id: 'note_old', source_table: 'notes',
      storage_mode: 'inline', data: '# 中文📚\n旧用户内容', metadata_json: JSON_TEXT, ref_count: 1, created_at: MS, updated_at: MS },
      { id: 'res_tr_old', hash: 'old-translation-hash', type: 'translation', source_id: 'tr_old', source_table: 'translations',
        storage_mode: 'inline', data: '{ "source": "old text", "translated": "译文📚" }', ref_count: 1, created_at: MS, updated_at: MS }],
    notes: [{ id: 'note_old', resource_id: 'res_old', title: '中文笔记📚', tags: TAGS, is_favorite: 1, created_at: ISO, updated_at: ISO, deleted_at: null }],
    blobs: [{ hash: 'old-blob', relative_path: 'aa/旧文件.bin', size: LARGE, mime_type: null, ref_count: 1, created_at: MS }],
    files: [{ id: 'file_old', resource_id: null, blob_hash: 'old-blob', sha256: 'old-file-hash', file_name: '旧文件📚.bin', size: LARGE,
      tags_json: TAGS, is_favorite: 1, bookmarks_json: '[ {"page":1} ]', created_at: ISO, updated_at: ISO, preview_json: JSON_TEXT, description: null }],
    folders: [{ id: 'fld_old', parent_id: null, title: '旧目录📚', is_expanded: 1, is_favorite: 0, sort_order: 7, created_at: MS, updated_at: MS }],
    folder_items: [{ id: 'fi_old', folder_id: 'fld_old', item_type: 'note', item_id: 'note_old', sort_order: 2, created_at: MS }],
    translations: [{ id: 'tr_old', resource_id: 'res_tr_old', src_lang: 'en', tgt_lang: 'zh', is_favorite: 1, created_at: ISO, updated_at: ISO, title: '翻译📚', metadata_json: JSON_TEXT }],
    exam_sheets: [{ id: 'exam_old', exam_name: '旧题库📚', status: 'completed', temp_id: 'tmp_old', metadata_json: '{}', preview_json: '{}',
      created_at: ISO, updated_at: ISO, is_favorite: 1 }],
    questions: [{ id: 'q_old', exam_id: 'exam_old', content: '中文题干📚', question_type: 'single_choice', difficulty: 'medium',
      options_json: '[ { "key": "A", "content": "选项📚" } ]', answer: 'A', tags: TAGS, is_correct: null, is_favorite: 1,
      structured_data: JSON_TEXT, created_at: ISO, updated_at: SQL_TIME }],
    question_history: [{ id: 'qh_old', question_id: 'q_old', field_name: 'answer', old_value: null, new_value: 'A', operator: 'user', reason: '校对📚', created_at: ISO }],
    review_plans: [{ id: 'rp_old', question_id: 'q_old', exam_id: 'exam_old', ease_factor: 2.625, interval_days: 7, repetitions: 2,
      next_review_date: '2026-11-05', last_review_date: null, is_difficult: 1, created_at: SQL_TIME, updated_at: ISO }],
    todo_lists: [{ id: 'tdl_old', title: '旧待办📚', description: null, is_default: 0, is_favorite: 1, created_at: ISO, updated_at: SQL_TIME }],
    todo_items: [{ id: 'ti_old', todo_list_id: 'tdl_old', title: '复习📚', status: 'pending', priority: 'high', due_date: '2026-10-02',
      due_time: '09:30', tags_json: TAGS, attachments_json: '[ "res_old" ]', repeat_json: JSON_TEXT, created_at: SQL_TIME, updated_at: ISO }],
  },
  chat_v2: {
    chat_v2_sessions: [{ id: 'sess_old', mode: 'general_chat', title: '旧会话📚', title_locked: 1, persist_status: 'active', created_at: ISO, updated_at: ISO, metadata_json: JSON_TEXT }],
    chat_v2_messages: [{ id: 'msg_old', session_id: 'sess_old', role: 'assistant', block_ids_json: '[ "blk_old" ]', timestamp: MS,
      persistent_stable_id: null, meta_json: null, attachments_json: null }],
    chat_v2_blocks: [{ id: 'blk_old', message_id: 'msg_old', block_type: 'content', status: 'success', block_index: 0,
      content: '中文📚\n原文', tool_input_json: JSON_TEXT, tool_output_json: 'null', started_at: MS, ended_at: null }],
    chat_v2_attachments: [{ id: 'att_old', message_id: 'msg_old', block_id: 'blk_old', name: '中文📚.pdf', type: 'document', mime_type: 'application/pdf', size: LARGE, status: 'ready', created_at: ISO }],
    chat_v2_session_state: [{ session_id: 'sess_old', updated_at: ISO, input_value: '草稿📚', temperature: 0.125, enable_thinking: 1,
      disable_tools: 0, model_id: null, features_json: '{ "rag": true }' }],
    resources: [{ id: 'res_chat_old', hash: 'chat-hash', type: 'note', data: JSON_TEXT, metadata_json: JSON_TEXT, ref_count: 1, created_at: MS }],
  },
  mistakes: {
    mistakes: [{ id: 'mistake_old', created_at: ISO, question_images: TAGS, analysis_images: '[]', user_question: '为什么📚？', ocr_text: '中文识别',
      tags: TAGS, mistake_type: 'math', status: 'active', updated_at: SQL_TIME, ocr_note: null, chat_metadata: JSON_TEXT }],
    chat_messages: [{ id: I64, mistake_id: 'mistake_old', role: 'user', content: '旧消息📚', timestamp: SQL_TIME, metadata: JSON_TEXT }],
    settings: [{ key: 'x3.raw_json', value: JSON_TEXT, updated_at: SQL_TIME }],
    document_tasks: [{ id: 'task_old', document_id: 'doc_old', original_document_name: '旧文档📚', segment_index: 0, content_segment: '中文正文',
      status: 'Completed', created_at: ISO, updated_at: ISO, anki_generation_options_json: '{}' }],
    anki_cards: [{ id: 'card_old', task_id: 'task_old', front: '问题📚', back: '答案中文', tags_json: TAGS, images_json: '[]',
      is_error_card: 0, created_at: ISO, updated_at: ISO, extra_fields_json: '{ "备注": "中文📚" }', text: null }],
    custom_anki_templates: [{ id: 'tpl_old', name: '旧模板📚', description: null, author: null, preview_front: '正面', preview_back: '背面',
      fields_json: '[ "Front", "Back" ]', generation_prompt: '生成中文📚', front_template: '{{Front}}', back_template: '{{Back}}', css_style: '.card { color: red; }',
      field_extraction_rules_json: '{}', created_at: ISO, updated_at: ISO, is_active: 1, is_built_in: 0, preview_data_json: JSON_TEXT }],
  },
  llm_usage: {
    llm_usage_logs: [{ id: 'usage_old', timestamp: ISO, provider: '旧提供商📚', model: 'model-old', prompt_tokens: TOKENS, completion_tokens: 0,
      total_tokens: TOKENS, reasoning_tokens: null, cached_tokens: 0, caller_type: 'chat_v2', session_id: 'sess_old', duration_ms: LARGE, cost_estimate: 0.125 }],
    llm_usage_daily: [{ date: '2026-10-01', caller_type: 'translation', model: 'daily-old', provider: '旧提供商📚', request_count: 1,
      success_count: 1, total_prompt_tokens: 42, total_tokens: 42, total_cost_estimate: 0.125, created_at: SQL_TIME, updated_at: ISO }],
  },
  browser: {
    sessions: [{ id: 'browser_old', title: '旧网页📚', current_url: 'https://example.com/中文', history_index: 0, is_active: 0, created_at: ISO, updated_at: SQL_TIME, closed_at: null }],
    history: [{ id: 'history_old', session_id: 'browser_old', url: 'https://example.com/中文', title: '中文📚', seq: 0, visit_count: 2, typed_count: 1, first_visit_at: SQL_TIME, last_visit_at: ISO, hidden: 0 }],
    downloads: [{ id: 'download_old', session_id: 'browser_old', url: 'https://example.com/旧文件', filename: '旧文件📚.pdf', total_bytes: LARGE, received_bytes: 42,
      state: 'completed', started_at: ISO, finished_at: SQL_TIME, mime_type: null }],
    site_permissions: [{ id: 'perm_old', origin: 'https://example.com', permission: 'camera', decision: 'deny', expires_at: null, created_at: ISO, updated_at: ISO }],
    settings: [{ key: 'x3.raw_json', value: JSON_TEXT, updated_at: SQL_TIME }],
  },
};

export const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
export function tempDir(): string {
  mkdirSync(join(HERE, '.tmp'), { recursive: true });
  return mkdtempSync(join(HERE, '.tmp/case-'));
}
export function cleanup(dir: string): void { rmSync(dir, { recursive: true, force: true }); }
export function sqlMigrations(db: FixtureDb) {
  // Deliberately independent of the Host loader/Runner and migration coordinator.
  return readdirSync(join(MIGRATIONS, db)).filter(f => f.endsWith('.sql')).map(file => {
    const m = /^V(\d+)__(\w+)\.sql$/.exec(file);
    if (!m) throw new Error(`Unexpected Rust migration filename: ${file}`);
    const version = Number(m[1]), name = m[2]!;
    const sql = readFileSync(join(MIGRATIONS, db, file), 'utf8');
    return { file, version, name, sql, checksum: refineryChecksum(name, version, sql).toString() };
  }).sort((a, b) => a.version - b.version);
}
export function dbPath(active: string, db: FixtureDb): string {
  return db === 'vfs' ? join(active, 'databases/vfs.db') : join(active, `${db}.db`);
}

/** Replay each SQL and history INSERT separately, as refinery grouped=false does. */
export function buildDatabase(active: string, db: FixtureDb, omitLast = false, seeds: Record<string, SeedRow[]> = SEEDS[db]): void {
  const file = dbPath(active, db);
  mkdirSync(dirname(file), { recursive: true });
  const conn = new Database(file);
  try {
    // Disposable SQL-replay input, not a crash-durability test: avoid hundreds of
    // fsync waits while constructing each slot under full-suite disk contention.
    // synchronous is connection-local; the Host opens the closed file with its
    // normal production profile. Keep every migration/history transaction intact.
    conn.pragma('synchronous = OFF');
    conn.pragma('foreign_keys = ON');
    conn.exec('CREATE TABLE refinery_schema_history(version int4 PRIMARY KEY, name VARCHAR(255), applied_on VARCHAR(255), checksum VARCHAR(255))');
    const migrations = sqlMigrations(db);
    for (const migration of omitLast ? migrations.slice(0, -1) : migrations) {
      conn.transaction(() => conn.exec(migration.sql))();
      conn.transaction(() => conn.prepare('INSERT INTO refinery_schema_history VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, APPLIED_ON, migration.checksum))();
    }
    for (const [table, rows] of Object.entries(seeds)) for (const row of rows) {
      const columns = Object.keys(row);
      conn.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
    }
    if (conn.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`${db}: fixture foreign keys invalid`);
    if (conn.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error(`${db}: fixture integrity invalid`);
  } finally { conn.close(); }
}

export function buildSlot(base: string, slot = 'slotA', omitLast = false): string {
  const active = join(base, 'slots', slot);
  for (const db of DATABASES) buildDatabase(active, db, omitLast && db !== 'browser');
  mkdirSync(join(base, 'slots'), { recursive: true });
  return active;
}

/** Distinguish fixture timelines before either slot is opened by the Host. */
export function setTimelineMarker(active: string, marker: string): void {
  const conn = new Database(dbPath(active, 'mistakes'));
  try { conn.prepare('UPDATE settings SET value = ? WHERE key = ?').run(marker, 'x3.raw_json'); }
  finally { conn.close(); }
}

/** Capture every column (including SQL NULL and full i64), not just inserted fields. */
export function snapshot(executor: SqlExecutor, db: FixtureDb): Record<string, unknown[]> {
  return Object.fromEntries(Object.keys(SEEDS[db]).map(table => [table,
    executor.all({ sql: `SELECT * FROM ${quote(table)} ORDER BY rowid`, options: { safeIntegers: true } }),
  ]));
}
export function rawSnapshot(active: string, db: FixtureDb): Record<string, unknown[]> {
  const conn = new Database(dbPath(active, db), { readonly: true });
  try { return Object.fromEntries(Object.keys(SEEDS[db]).map(t => [t, conn.prepare(`SELECT * FROM ${quote(t)} ORDER BY rowid`).safeIntegers().all()])); }
  finally { conn.close(); }
}
export function history(executor: SqlExecutor) {
  return executor.all('SELECT version, name, applied_on, checksum FROM refinery_schema_history ORDER BY version');
}
export function rawHistory(active: string, db: FixtureDb) {
  const conn = new Database(dbPath(active, db), { readonly: true });
  try { return conn.prepare('SELECT version, name, applied_on, checksum FROM refinery_schema_history ORDER BY version').all(); }
  finally { conn.close(); }
}

/** Non-refinery owners: replay the pinned Rust DDL without inventing history rows. */
export function buildOwnerDatabase(file: string, sql: string, seeds: Record<string, SeedRow[]>, userVersion = 0): void {
  mkdirSync(dirname(file), { recursive: true });
  const conn = new Database(file);
  try {
    conn.pragma('foreign_keys = ON');
    conn.exec(sql);
    if (userVersion !== 0) conn.pragma(`user_version = ${userVersion}`);
    for (const [table, rows] of Object.entries(seeds)) for (const row of rows) {
      const columns = Object.keys(row);
      conn.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
    }
    if (conn.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`${file}: fixture foreign keys invalid`);
    if (conn.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error(`${file}: fixture integrity invalid`);
  } finally { conn.close(); }
}

export function ownerSnapshot(executor: SqlExecutor, tables: readonly string[]) {
  return Object.fromEntries(tables.map(table => [table,
    executor.all({ sql: `SELECT * FROM ${quote(table)} ORDER BY rowid`, options: { safeIntegers: true } }),
  ]));
}

export function ownerSchema(executor: SqlExecutor) {
  return {
    userVersion: executor.pluck<number>('PRAGMA user_version'),
    objects: executor.all('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'),
  };
}

export function rawOwnerDatabase(file: string, tables: readonly string[]) {
  const conn = new Database(file, { readonly: true });
  try {
    return {
      rows: Object.fromEntries(tables.map(table => [table,
        conn.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).safeIntegers().all(),
      ])),
      schema: {
        userVersion: conn.pragma('user_version', { simple: true }),
        objects: conn.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
      },
    };
  } finally { conn.close(); }
}
