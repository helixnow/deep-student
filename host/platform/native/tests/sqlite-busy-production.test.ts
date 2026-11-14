/**
 * 主代理决定（2026-11-07 W01 r5）：生产只用 `busy_timeout`，与 Rust 生产一致——dstu-sync
 * `sync/state.rs:33` 只设 `busy_timeout(5s)`、`:237` 用 `TransactionBehavior::Immediate`，`busy_handler` 只出现在
 * `#[cfg(test)]`（`:560` 之后）。`nativeSqliteBusy`（`sqlite-busy/`，只有 linux-x64 预编译，打包后 `loadExtension`
 * 也读不到 asar 内的路径）只给等价性测试用。这里守住两点：生产开库不需要它；生产源码不新增它的使用方。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nativePlugin from '../index.ts';
import { openStartupDatabase } from '../../storage/startup-database.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 生产源码里允许出现 `nativeSqliteBusy` / `setBusyHandler(` 的文件：模块自身、服务登记、存储层的可选开库参数。 */
const ALLOWED = [
  'host/platform/native/index.ts',
  'host/platform/native/sqlite-busy/api.ts',
  'host/platform/native/sqlite-busy/index.ts',
  'host/platform/storage/connection.ts',
  'host/platform/storage/startup-database.ts',
];
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', '__fixtures__', 'fixtures', 'equivalence', 'e2e', 'wp280']);
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) productionSources(path.join(dir, entry.name), out);
    } else if (CODE.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-sqlite-busy-prod-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('sqlite busy handling in production uses busy_timeout only (no native module)', () => {
  it('production code does not consume nativeSqliteBusy or call setBusyHandler outside the storage plumbing', () => {
    const users = ['host', 'electron']
      .flatMap(top => productionSources(path.join(ROOT, top)))
      .filter(file => /nativeSqliteBusy|sqlite-busy\/index|\.setBusyHandler\(/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(ROOT, file).split(path.sep).join('/'))
      .sort();
    expect(users, 'new production users of the test-only native busy handler (see host/platform/API.md "sqlite busy")').toEqual(ALLOWED);
  });

  it('a production connection waits on busy_timeout=5000 (Rust busy_timeout(5s)) and cannot install a busy handler', () => {
    const db = openStartupDatabase(path.join(dir, 'sync_state.db'));
    try {
      expect(db.pluck('PRAGMA busy_timeout')).toBe(5000);
      expect(() => db.setBusyHandler(() => true)).toThrow(expect.objectContaining({ code: 'INVALID_PARAM' }));
    } finally {
      db.close();
    }
  });

  it('loading the dstu.native plugin module does not load the f7-sqlite-busy binding (it is required lazily by setBusyHandler)', () => {
    expect(nativePlugin.meta.provides).toContain('nativeSqliteBusy');
    const cached = Object.keys(createRequire(import.meta.url).cache).filter(key => key.includes('f7-sqlite-busy'));
    expect(cached).toEqual([]);
  });
});
