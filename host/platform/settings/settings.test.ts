/**
 * 移植 `src-tauri/tests/secure_store_tests.rs` 的数据库部分与 `Database::*_setting/_secret` 语义。
 * 需要 better-sqlite3；原生模块/ABI 加载失败会直接使本文件失败，不再自动跳过。
 * 测试用一个仅含 SqlExecutor 子集的薄适配器，生产代码只经 F3 `ctx.storage`。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log/api.ts';
import { resolveOsDirs } from '../paths/index.ts';
import { createSecretsService } from '../secrets/index.ts';
import type { SecureStore } from '../secrets/api.ts';
import type { SqlExecutor } from '../storage/api.ts';
import { createSettingsStore } from './index.ts';

type BetterSqlite = new (path: string) => {
  prepare(sql: string): { get(...p: unknown[]): any; all(...p: unknown[]): any[]; run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }; pluck(): { get(...p: unknown[]): any } };
  exec(sql: string): void;
  close(): void;
};
// 直接使用原生模块：加载或 ABI 失败会在收集阶段抛错，而不是把整个 suite 静默跳过。
const Database = BetterSqlite3 as unknown as BetterSqlite;

function executor(db: InstanceType<BetterSqlite>): SqlExecutor {
  const params = (p: unknown) => (Array.isArray(p) ? p : p === undefined ? [] : [p]);
  // 适配器只处理本文件用到的顺序编号参数：`?1 ?2 ?3` 按出现顺序绑定（F3 实现负责通用的 `?NNN`）。
  const prep = (sql: string) => db.prepare(sql.replace(/\?\d+/g, '?'));
  return {
    get: (sql: any, p?: any) => prep(sql).get(...params(p)),
    one: (sql: any, p?: any) => prep(sql).get(...params(p)),
    pluck: (sql: any, p?: any) => prep(sql).pluck().get(...params(p)),
    all: (sql: any, p?: any) => prep(sql).all(...params(p)),
    iterate: () => {
      throw new Error('not used');
    },
    run: (sql: any, p?: any) => prep(sql).run(...params(p)),
    exec: (sql: string) => db.exec(sql),
  } as unknown as SqlExecutor;
}

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const secrets = createSecretsService({ os: resolveOsDirs(process.platform === 'darwin' ? 'darwin' : 'linux', process.env), log: silent, keystore: null });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(withSecure = true) {
  const dir = mkdtempSync(join(tmpdir(), 'f4-settings-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'test.db'));
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);');
  const secure: SecureStore | null = withSecure ? secrets.openStore(dir) : null;
  let tick = 0;
  const store = createSettingsStore({
    db: () => executor(db),
    secureStore: () => secure,
    isSensitiveKey: secrets.isSensitiveKey,
    now: () => `2026-11-03T00:00:0${tick++}+00:00`,
  });
  return { dir, db, store, secure };
}

describe('settings', () => {
  it('save/get/delete 与 UPSERT 值不变时不更新 updated_at', () => {
    const { store, db } = setup();
    store.save('general.theme', 'dark');
    store.save('general.theme', 'dark');
    expect(db.prepare('SELECT updated_at FROM settings WHERE key = ?').pluck().get('general.theme')).toBe('2026-11-03T00:00:00+00:00');
    store.save('general.theme', 'light');
    expect(store.get('general.theme')).toBe('light');
    expect(db.prepare('SELECT updated_at FROM settings WHERE key = ?').pluck().get('general.theme')).toBe('2026-11-03T00:00:02+00:00');
    expect(store.delete('general.theme')).toBe(true);
    expect(store.delete('general.theme')).toBe(false);
    expect(store.get('general.theme')).toBeNull();
  });
  it('listByPrefix 按 updated_at DESC；deleteByPrefix 返回行数', () => {
    const { store } = setup();
    store.save('tool.a', '1');
    store.save('tool.b', '2');
    store.save('other', '3');
    expect(store.listByPrefix('tool.').map((r) => r.key)).toEqual(['tool.b', 'tool.a']);
    expect(store.deleteByPrefix('tool.')).toBe(2);
  });
  // secure_store_tests.rs::test_database_secure_integration
  it('test_database_secure_integration', async () => {
    const { store, dir, db } = setup();
    await store.saveSecret('web_search.api_key.test', 'secret_test_key');
    expect(await store.getSecret('web_search.api_key.test')).toBe('secret_test_key');
    expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);
    expect(existsSync(join(dir, '.secure', 'web_search.api_key.test.enc'))).toBe(true);
    expect(await store.deleteSecret('web_search.api_key.test')).toBe(true);
    expect(await store.getSecret('web_search.api_key.test')).toBeNull();
  });
  // secure_store_tests.rs::test_fallback_behavior
  it('test_fallback_behavior', async () => {
    const { store, db } = setup();
    await store.saveSecret('test.non_sensitive.key', 'test_value');
    expect(await store.getSecret('test.non_sensitive.key')).toBe('test_value');
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get('test.non_sensitive.key')).toBe('test_value');
  });
  it('遗留明文敏感行在读取时迁入安全存储并删除明文', async () => {
    const { store, db, dir } = setup();
    store.save('builtin-openai.api_key', 'legacy-plain');
    expect(await store.getSecret('builtin-openai.api_key')).toBe('legacy-plain');
    expect(store.get('builtin-openai.api_key')).toBeNull();
    expect(existsSync(join(dir, '.secure', 'builtin-openai.api_key.enc'))).toBe(true);
    expect(db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);
  });
  it('无安全存储时敏感键 fail-closed，绝不明文落库', async () => {
    const { store } = setup(false);
    await expect(store.saveSecret('x.api_key', 'v')).rejects.toThrow('安全存储不可用，拒绝以明文保存敏感设置: x.api_key');
    await expect(store.getSecret('x.api_key')).rejects.toThrow('安全存储不可用，拒绝读取数据库中的敏感设置: x.api_key');
    expect(store.get('x.api_key')).toBeNull();
    expect(await store.deleteSecret('x.api_key')).toBe(false);
  });
  // decisions.md D1：*WithConn 必须只使用调用方传入的 SqlExecutor。
  it('D1 *WithConn uses the caller transaction connection only', () => {
    const { store } = setup();
    const otherDir = mkdtempSync(join(tmpdir(), 'f4-settings-conn-'));
    dirs.push(otherDir);
    const otherDb = new Database!(join(otherDir, 'conn.db'));
    otherDb.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);');
    const conn = executor(otherDb);

    store.saveWithConn(conn, 'tool.x', '1');
    expect(store.getWithConn(conn, 'tool.x')).toBe('1');
    // 默认库没有被写入。
    expect(store.get('tool.x')).toBeNull();

    conn.exec('BEGIN');
    store.saveWithConn(conn, 'tool.x', '2');
    expect(store.getWithConn(conn, 'tool.x')).toBe('2');
    conn.exec('ROLLBACK');
    expect(store.getWithConn(conn, 'tool.x')).toBe('1');

    expect(store.listByPrefixWithConn(conn, 'tool.')).toHaveLength(1);
    expect(store.deleteWithConn(conn, 'tool.x')).toBe(true);
    expect(store.getWithConn(conn, 'tool.x')).toBeNull();

    store.saveWithConn(conn, 'tool.a', '1');
    store.saveWithConn(conn, 'tool.b', '2');
    expect(store.deleteByPrefixWithConn(conn, 'tool.')).toBe(2);
    otherDb.close();
  });
});
