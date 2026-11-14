/**
 * 移动端迁移在 mistakes 校验之后补 `pending_memory_candidates`，与桌面 coordinator 同一个修复、同一个时机
 * （RF-W07-pending-memory-candidates-schema 的移动端调用点）。整份 schema 与桌面一致由 mobile/tests/host-e2e.spec.ts 用桌面基准比对。
 * 这里用桌面 `Connection`（内存库）驱动 `migrateMobileDatabase`：两者对迁移暴露的 SqlExecutor 面相同。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection } from '../../storage/connection.ts';
import { PROFILES } from '../../storage/profiles.ts';
import type { MobileConnection } from '../connection.ts';
import { migrateMobileDatabase } from '../migrations.ts';

const REPO = join(import.meta.dirname, '../../../..');

function sources(db: string): Record<string, string> {
  const dir = join(REPO, 'resources/app/migrations', db);
  return Object.fromEntries(readdirSync(dir).filter((name) => name.endsWith('.sql')).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

/** v0.9.2 `database/manager.rs:698-716`（`1813b3c9c`）的建表原文（与桌面测试相同）。 */
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
const COLUMNS = ['id', 'conversation_id', 'content', 'category', 'origin', 'user_edited', 'status', 'created_at', 'expires_at', 'subject'];
const INDEXES = ['idx_pending_mem_conversation', 'idx_pending_mem_expires', 'idx_pending_mem_status'];

const open: Connection[] = [];
afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
});

function migrate(db: 'mistakes' | 'vfs', seed?: string): { conn: Connection; logs: string[]; success: boolean; error: string | null } {
  const conn = new Connection(':memory:', { label: db, profile: PROFILES.plain });
  open.push(conn);
  if (seed !== undefined) conn.exec(seed);
  const logs: string[] = [];
  const report = migrateMobileDatabase(db, conn as unknown as MobileConnection, sources(db), (level, message) => {
    if (message.startsWith('[Migration]')) logs.push(`${level} ${message}`);
  });
  return { conn, logs, success: report.success, error: report.error };
}

const columnsOf = (conn: Connection) => conn.all<{ name: string }>("SELECT name FROM pragma_table_info('pending_memory_candidates')").map((row) => row.name);
const indexesOf = (conn: Connection) =>
  conn.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_memory_candidates' ORDER BY name").map((row) => row.name);
const historyNames = (conn: Connection) => conn.all<{ name: string }>('SELECT name FROM refinery_schema_history ORDER BY version').map((row) => row.name);

describe('mobile migration: pending_memory_candidates repair after mistakes verification', () => {
  it('a new mistakes.db gets the table with subject and its three indexes; refinery history is untouched; a rerun changes nothing', () => {
    const { conn, logs, success, error } = migrate('mistakes');
    expect(success, error ?? '').toBe(true);
    expect(columnsOf(conn)).toEqual(COLUMNS);
    expect(indexesOf(conn)).toEqual(INDEXES);
    expect(logs).toEqual(['info [Migration] pending_memory_candidates schema repaired: created']);
    expect(historyNames(conn).some((name) => name.includes('pending_memory'))).toBe(false);

    const rerun: string[] = [];
    const report = migrateMobileDatabase('mistakes', conn as unknown as MobileConnection, sources('mistakes'), (level, message) => {
      if (message.startsWith('[Migration]')) rerun.push(message);
    });
    expect(report.success).toBe(true);
    expect(rerun).toEqual([]);
  });

  it('a v0.9.2 table without subject gets the column; existing rows read the default subject', () => {
    const { conn, logs, success } = migrate('mistakes', `${V092_DDL}\nINSERT INTO pending_memory_candidates (conversation_id, content, category) VALUES ('c1', '旧候选', 'fact');`);
    expect(success).toBe(true);
    expect(columnsOf(conn)).toEqual(COLUMNS);
    expect(indexesOf(conn)).toEqual(INDEXES);
    expect(conn.all('SELECT conversation_id, content, subject FROM pending_memory_candidates')).toEqual([{ conversation_id: 'c1', content: '旧候选', subject: '通用' }]);
    expect(logs).toEqual(['info [Migration] pending_memory_candidates schema repaired: added_subject']);
  });

  it('other databases are left alone', () => {
    const { conn, logs, success } = migrate('vfs');
    expect(success).toBe(true);
    expect(columnsOf(conn)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('a failing repair only warns: the migration still succeeds and the name keeps what was there', () => {
    const { conn, logs, success, error } = migrate('mistakes', 'CREATE VIEW pending_memory_candidates AS SELECT 1 AS id');
    expect(success, error ?? '').toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^warn \[Migration\] pending_memory_candidates schema repair failed; memory candidates stay unavailable: /);
    expect(conn.pluck("SELECT type FROM sqlite_master WHERE name = 'pending_memory_candidates'")).toBe('view');
  });
});
