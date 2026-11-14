/**
 * 标记迁移完成前的落盘确认：从 Electron 自己的 `Local Storage/leveldb` 读回目标 origin 的键值，
 * 与 preload 读回的值逐键一致才算持久化（`flushStorageData()` 没有完成回调，只能轮询）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebviewMigrationError } from '../storage-migration/index.ts';
import { chromiumKey, chromiumString, encodeBatch, encodeLog, writeLevelDb } from '../storage-migration/tests/fixtures.ts';
import { waitForPersistedLocalStorage } from '../shell/webview-migration.ts';

const origin = 'tauri://localhost';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(entries: ReadonlyArray<readonly [string, string]>, otherOrigin: ReadonlyArray<readonly [string, string]> = []): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'dstu-persisted-')), 'leveldb');
  dirs.push(join(dir, '..'));
  writeDatabase(dir, entries, otherOrigin);
  return dir;
}

function writeDatabase(dir: string, entries: ReadonlyArray<readonly [string, string]>, otherOrigin: ReadonlyArray<readonly [string, string]> = []): void {
  const ops = [
    { put: Buffer.from('VERSION'), value: Buffer.from('1') },
    ...entries.map(([key, value]) => ({ put: chromiumKey(origin, key), value: chromiumString(value) })),
    ...otherOrigin.map(([key, value]) => ({ put: chromiumKey('https://example.com', key), value: chromiumString(value) })),
  ];
  writeLevelDb(dir, { manifest: 1, edits: [{ logNumber: 3, nextFile: 4, lastSeq: ops.length }], logs: { 3: encodeLog([encodeBatch(1n, ops)]) } });
}

const expected = new Map([['a', '1'], ['dstu-theme-mode', 'light'], ['empty', '']]);

describe('waitForPersistedLocalStorage', () => {
  it('resolves once every expected key is on disk with the same value (other keys and origins do not matter)', async () => {
    const dir = database([...expected, ['unrelated', 'x']], [['a', 'other origin']]);
    await expect(waitForPersistedLocalStorage({ dir, origin, expected, timeoutMs: 1000, intervalMs: 10 })).resolves.toBeUndefined();
  });

  it('keeps polling while the flush has not reached the disk yet', async () => {
    const dir = database([['a', '1']]);
    setTimeout(() => writeDatabase(dir, [...expected]), 100);
    await expect(waitForPersistedLocalStorage({ dir, origin, expected, timeoutMs: 3000, intervalMs: 20 })).resolves.toBeUndefined();
  });

  it('times out with TARGET_VERIFY_FAILED naming the missing or different keys', async () => {
    const dir = database([['a', '2'], ['dstu-theme-mode', 'light']]);
    const error = await waitForPersistedLocalStorage({ dir, origin, expected, timeoutMs: 100, intervalMs: 20 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebviewMigrationError);
    expect((error as WebviewMigrationError).code).toBe('TARGET_VERIFY_FAILED');
    expect((error as Error).message).toContain('"a"');
    expect((error as Error).message).toContain('"empty"');
    expect((error as Error).message).not.toContain('dstu-theme-mode');
  });

  it('an unreadable database is a failure after the timeout, with the read error as detail', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dstu-persisted-')), 'missing');
    dirs.push(join(dir, '..'));
    const error = await waitForPersistedLocalStorage({ dir, origin, expected, timeoutMs: 60, intervalMs: 20 }).catch((caught: unknown) => caught);
    expect((error as WebviewMigrationError).code).toBe('TARGET_VERIFY_FAILED');
    expect((error as Error).message).toContain('CURRENT');
  });
});
