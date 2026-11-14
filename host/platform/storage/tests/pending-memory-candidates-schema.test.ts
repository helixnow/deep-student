import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationSets } from '../migration/definitions/index.ts';
import { ensurePendingMemoryCandidatesSchema, type SchemaRepairConnection } from '../pending-memory-candidates-schema.ts';
import { PROFILES } from '../profiles.ts';
import { createStorageService } from '../service.ts';

/** v0.9.2 `database/manager.rs:698-716`（`1813b3c9c`）的建表原文。 */
const V092_DDL = `CREATE TABLE IF NOT EXISTS pending_memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    origin TEXT DEFAULT 'auto_extract',
    user_edited INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'saved', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'))
);
CREATE INDEX IF NOT EXISTS idx_pending_mem_conversation ON pending_memory_candidates(conversation_id);`;

/** `knowledge_executor.rs:125` 与 `enhanced_anki.rs:751` 的 SQL 原文。 */
const RUST_INSERT = 'INSERT INTO pending_memory_candidates (conversation_id, subject, content, category, origin, user_edited) VALUES (?1, ?2, ?3, ?4, ?5, ?6)';
const RUST_SELECT = `SELECT subject, content, category, origin, user_edited, created_at
         FROM pending_memory_candidates
         WHERE conversation_id = ?1 AND status = 'pending'
         ORDER BY id ASC`;
const COLUMNS = ['id', 'conversation_id', 'content', 'category', 'origin', 'user_edited', 'status', 'created_at', 'expires_at', 'subject'];
const INDEXES = ['idx_pending_mem_conversation', 'idx_pending_mem_expires', 'idx_pending_mem_status'];

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-pending-mem-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** 迁移前写入旧版 mistakes.db（模拟 v0.9.2 升级上来的库）；必须在 `runAll` 之前调用。 */
function seedLegacyMistakes(sql: string): void {
  const db = new Connection(path.join(root, 'slots', 'slotA', 'mistakes.db'), { label: 'mistakes', profile: PROFILES.plain });
  try { db.exec(sql); } finally { db.close(); }
}

/** `runAll` 中 mistakes 迁移完成后由 coordinator 执行修复；`run` 拿到迁移后的同一个库。 */
async function withMigratedMistakes<T>(run: (db: ReturnType<ReturnType<typeof createStorageService>['database']>) => T): Promise<T> {
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  try {
    const report = await storage.migrations.runAll();
    expect(report.success).toBe(true);
    return run(storage.database('mistakes'));
  } finally {
    storage.dispose();
  }
}

const historyOf = (db: SchemaRepairConnection) =>
  db.all<{ version: number }>('SELECT version FROM refinery_schema_history ORDER BY version').map((row) => row.version);
const columnsOf = (db: SchemaRepairConnection) =>
  db.all<{ name: string }>("SELECT name FROM pragma_table_info('pending_memory_candidates')").map((row) => row.name);
const indexesOf = (db: SchemaRepairConnection) =>
  db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_memory_candidates' AND name LIKE 'idx_%' ORDER BY name").map((row) => row.name);
const MISTAKES_VERSIONS = new Set(loadMigrationSets(DEFAULT_MIGRATIONS_DIR).mistakes.migrations.map((migration) => migration.refineryVersion));

it('RF-W07-pending-memory-candidates-schema: a freshly migrated mistakes.db gets the table with subject, and the Rust INSERT/SELECT succeed', async () => {
  await withMigratedMistakes((db) => {
    expect(columnsOf(db)).toEqual(COLUMNS);
    expect(indexesOf(db)).toEqual(INDEXES);
    const history = historyOf(db);
    db.run(RUST_INSERT, ['chat-c1', '通用', 'fact one', 'fact', 'tool_extract', 0]);
    expect(db.all(RUST_SELECT, ['chat-c1'])).toMatchObject([{ subject: '通用', content: 'fact one', category: 'fact', origin: 'tool_extract', user_edited: 0 }]);
    expect(ensurePendingMemoryCandidatesSchema(db)).toBe('none');
    expect(historyOf(db)).toEqual(history);
  });
});

it('RF-W07-pending-memory-candidates-schema: an upgraded v0.9.2 table keeps its rows and gains subject = 通用', async () => {
  seedLegacyMistakes(`${V092_DDL}
    INSERT INTO pending_memory_candidates (conversation_id, content, category, status) VALUES ('chat-c1', 'old', 'fact', 'pending'), ('chat-c1', 'gone', 'fact', 'dismissed');`);
  await withMigratedMistakes((db) => {
    expect(columnsOf(db)).toEqual(COLUMNS);
    expect(db.all(RUST_SELECT, ['chat-c1'])).toMatchObject([{ subject: '通用', content: 'old' }]);
    expect(db.pluck("SELECT COUNT(*) FROM pending_memory_candidates WHERE status = 'dismissed'")).toBe(1);
    expect(indexesOf(db)).toEqual(INDEXES);
    db.run(RUST_INSERT, ['chat-c1', '通用', 'new', 'fact', 'tool_extract', 0]);
    expect(ensurePendingMemoryCandidatesSchema(db)).toBe('none');
  });
});

it('RF-W07-pending-memory-candidates-schema: the repair stays outside refinery history and the schema fingerprint, so a later runAll still succeeds', async () => {
  const history = await withMigratedMistakes((db) => {
    expect(columnsOf(db)).toContain('subject');
    return historyOf(db);
  });
  expect(history.length).toBeGreaterThan(0);
  expect(history.filter((version) => !MISTAKES_VERSIONS.has(version))).toEqual([]);
  // 第二次启动：表已存在时先过指纹校验，再判定无需修复。
  await withMigratedMistakes((db) => {
    expect(historyOf(db)).toEqual(history);
    expect(columnsOf(db)).toEqual(COLUMNS);
  });
});

it('a failing repair leaves the migration successful and mistakes.db as Rust would leave it', async () => {
  // 同名视图：pragma_table_info 有列但没有 subject，ALTER TABLE 对视图失败。
  seedLegacyMistakes("CREATE VIEW pending_memory_candidates AS SELECT 'chat-c1' AS conversation_id, 'x' AS content");
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const coordinator = new MigrationCoordinator({
    appDataDir: path.join(root, 'slots', 'slotA'),
    auditDbPath: null,
    log: (level, message, fields) => { logs.push({ level, message, fields }); },
  });
  expect(coordinator.migrateSingle('mistakes')).toMatchObject({ id: 'mistakes', success: true, error: null });
  expect(logs.filter((entry) => entry.message.includes('pending_memory_candidates'))).toEqual([
    { level: 'warn', message: expect.stringContaining('repair failed'), fields: { database: 'mistakes', error: 'Cannot add a column to a view' } },
  ]);
  await withMigratedMistakes((db) => {
    expect(columnsOf(db)).toEqual(['conversation_id', 'content']);
    expect(db.pluck("SELECT type FROM sqlite_master WHERE name = 'pending_memory_candidates'")).toBe('view');
    expect(() => db.all(RUST_SELECT, ['chat-c1'])).toThrow('no such column: subject');
  });
});

it('the coordinator logs which repair it applied', () => {
  seedLegacyMistakes(V092_DDL);
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const coordinator = new MigrationCoordinator({
    appDataDir: path.join(root, 'slots', 'slotA'),
    auditDbPath: null,
    log: (level, message, fields) => { logs.push({ level, message, fields }); },
  });
  expect(coordinator.migrateSingle('mistakes').success).toBe(true);
  expect(coordinator.migrateSingle('mistakes').success).toBe(true);
  expect(logs.filter((entry) => entry.message.includes('pending_memory_candidates'))).toEqual([
    { level: 'info', message: expect.stringContaining('added_subject'), fields: { database: 'mistakes', repair: 'added_subject' } },
  ]);
});
