/**
 * 迁移 runner 的可移植核心：运行时闭包不含 Node 依赖，且与桌面目录加载结果逐条一致
 * （移动端外壳按文件原文注入 SQL，`refinery_schema_history` 的 version/name/checksum 必须相同）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { loadSqlMigrations } from '../../storage/migration/refinery.ts';
import { Connection } from '../../storage/connection.ts';
import { MigrationError } from '../../storage/migration/errors.ts';
import { MigrationVerifier } from '../../storage/migration/verifier.ts';
import { PROFILES } from '../../storage/profiles.ts';
import { migrationsFromSources } from '../migrations.ts';

const REPO = join(import.meta.dirname, '../../../..');
const MIGRATIONS = join(REPO, 'resources/app/migrations');

describe('portable migration core', () => {
  it('reaches no Node-specific module at runtime from the mobile storage entry points', () => {
    const entries = [
      'host/platform/storage/errors.ts',
      'host/platform/storage/migration/refinery-core.ts',
      'host/platform/storage/migration/verifier.ts',
      'host/platform/storage/migration/helpers.ts',
      'host/platform/storage-mobile/index.ts',
    ];
    expect(checkModulesClosure(REPO, entries)).toEqual([]);
  });

  it.each(['vfs', 'chat_v2', 'mistakes', 'llm_usage', 'browser'])('%s: injected SQL sources yield the same migrations as the desktop directory loader', (db) => {
    const dir = join(MIGRATIONS, db);
    const sources = Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
    const shape = (list: ReturnType<typeof loadSqlMigrations>) => list.map(m => [m.version, m.name, m.prefix, m.checksum.toString()]);
    const desktop = loadSqlMigrations(dir);
    expect(desktop.length).toBeGreaterThan(0);
    expect(shape(migrationsFromSources(sources))).toEqual(shape(desktop));
  });

  it('ignores files whose names are not refinery migrations, like the desktop loader', () => {
    expect(migrationsFromSources({ 'README.sql': 'SELECT 1', 'V1__init.sql': 'CREATE TABLE t(x)', 'notes.txt': '' }).map(String)).toEqual(['V1__init']);
  });

  it('RF-W14-shorten-query-char-boundary: shortenQuery truncates on a UTF-8 character boundary (Rust panics) without Buffer', () => {
    const ascii = `SELECT ${'x'.repeat(100)}`;
    expect(MigrationVerifier.shortenQuery(ascii)).toBe(`${ascii.slice(0, 96)}...`);
    const cjk = `SELECT '${'汉'.repeat(40)}'`;
    // 8 字节前缀 + 每字 3 字节：第 96 字节落在第 30 个字中间，退回到 29 个完整字符。
    expect(MigrationVerifier.shortenQuery(cjk)).toBe(`SELECT '${'汉'.repeat(29)}...`);
    expect(MigrationVerifier.shortenQuery('SELECT 1')).toBe('SELECT 1');
  });

  it('RF-W14-shorten-query-char-boundary: a failing non-ASCII smoke query yields VerificationFailed instead of crashing', () => {
    const conn = new Connection(':memory:', { label: 'rf', profile: PROFILES.plain });
    const query = `SELECT * FROM 缺失的表${'汉'.repeat(40)}`;
    let caught: unknown;
    try {
      MigrationVerifier.verify(conn, {
        refineryVersion: 20260130, name: 'init', sql: '', idempotent: false,
        expectedTables: [], expectedColumns: [], expectedIndexes: [], expectedQueries: [query],
      });
    } catch (error) {
      caught = error;
    } finally {
      conn.close();
    }
    expect(caught).toBeInstanceOf(MigrationError);
    // "SELECT * FROM " 14 字节 + 每字 3 字节：第 96 字节落在第 28 个字中间，退回到 27 个完整字符。
    expect((caught as Error).message).toContain(`Query smoke test failed '${query.slice(0, 14 + 27)}...':`);
  });
});
