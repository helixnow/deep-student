/**
 * V10 P2-4：Windows 上 libuv 的 rename 没有 Rust 的 POSIX 替换语义，目标被短暂占用时返回 EPERM/EACCES/EBUSY。
 * 本机不是 Windows：用 `process.platform = 'win32'` 加注入的 fs 错误验证退避重试，以及 W07 路径内调用点的接线。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSpace } from '../../storage/locations.ts';
import { atomicWriteBytes } from '../../storage/data-space-files.ts';
import { atomicWriteFile, renameSyncWithRetry, renameWithRetry } from '../../util/durable-fs.ts';
import { RENAME_RETRY_DELAYS_MS } from '../rename-retry.ts';

const ID = 'RF-W07-windows-rename-retry';
const REAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true, writable: false });
}

function errno(code: string, syscall = 'rename'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, ${syscall}`), { code, errno: -1, syscall });
}

/** 前 `failures` 次抛 `code`，之后调用真实 rename。 */
function flakySync(code: string, failures: number): { calls: () => number } {
  const real = fs.renameSync;
  let calls = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    calls += 1;
    if (calls <= failures) throw errno(code);
    real(from, to);
  });
  return { calls: () => calls };
}

function flakyAsync(code: string, failures: number): { calls: () => number } {
  const real = fs.promises.rename;
  let calls = 0;
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    calls += 1;
    if (calls <= failures) throw errno(code);
    await real(from, to);
  });
  return { calls: () => calls };
}

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-rename-retry-'));
});
afterEach(() => {
  setPlatform(REAL_PLATFORM);
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('renameWithRetry / renameSyncWithRetry', () => {
  it(`${ID}: on win32 a briefly held target (EPERM, EACCES, EBUSY) is replaced once the holder lets go`, async () => {
    setPlatform('win32');
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const target = path.join(base, `${code}.json`);
      fs.writeFileSync(target, 'old');
      fs.writeFileSync(`${target}.tmp`, 'sync');
      const sync = flakySync(code, 2);
      renameSyncWithRetry(`${target}.tmp`, target);
      expect(sync.calls()).toBe(3);
      expect(fs.readFileSync(target, 'utf8')).toBe('sync');

      fs.writeFileSync(`${target}.tmp`, 'async');
      const async = flakyAsync(code, 2);
      await renameWithRetry(`${target}.tmp`, target);
      expect(async.calls()).toBe(3);
      expect(fs.readFileSync(target, 'utf8')).toBe('async');
      vi.restoreAllMocks();
    }
  });

  it(`${ID}: win32 paths (drive letter, non-ASCII user name) reach rename verbatim`, () => {
    setPlatform('win32');
    const from = path.win32.join('C:\\Users\\张三\\AppData\\Roaming\\com.deepstudent.app', 'slots', '.state-x.tmp');
    const to = path.win32.join('C:\\Users\\张三\\AppData\\Roaming\\com.deepstudent.app', 'slots', 'state.json');
    const seen: Array<[fs.PathLike, fs.PathLike]> = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      seen.push([a, b]);
      if (seen.length === 1) throw errno('EPERM');
    });
    renameSyncWithRetry(from, to);
    expect(seen).toEqual([[from, to], [from, to]]);
  });

  it(`${ID}: a holder that never lets go fails after the backoff budget with the last error`, async () => {
    setPlatform('win32');
    let sync = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { sync += 1; throw errno(sync === 8 ? 'EBUSY' : 'EPERM'); });
    const started = Date.now();
    expect(() => renameSyncWithRetry(path.join(base, 'a'), path.join(base, 'b'))).toThrow(expect.objectContaining({ code: 'EBUSY' }));
    expect(sync).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) - 50);

    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async () => { calls += 1; throw errno('EACCES'); });
      const pending = renameWithRetry(path.join(base, 'a'), path.join(base, 'b'));
      const settled = expect(pending).rejects.toMatchObject({ code: 'EACCES' });
      await vi.runAllTimersAsync();
      await settled;
      expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`${ID}: other platforms and non-transient codes fail on the first attempt, like Rust`, async () => {
    setPlatform('linux');
    const linux = flakySync('EPERM', 1);
    expect(() => renameSyncWithRetry(path.join(base, 'a'), path.join(base, 'b'))).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(linux.calls()).toBe(1);
    vi.restoreAllMocks();

    setPlatform('win32');
    for (const code of ['ENOENT', 'EXDEV', 'ENOTEMPTY']) {
      const sync = flakySync(code, 1);
      expect(() => renameSyncWithRetry(path.join(base, 'a'), path.join(base, 'b'))).toThrow(expect.objectContaining({ code }));
      expect(sync.calls()).toBe(1);
      const async = flakyAsync(code, 1);
      await expect(renameWithRetry(path.join(base, 'a'), path.join(base, 'b'))).rejects.toMatchObject({ code });
      expect(async.calls()).toBe(1);
      vi.restoreAllMocks();
    }
  });
});

describe('W07 call sites', () => {
  it(`${ID}: slots/state.json, data-space atomic files and paths atomicWriteFile survive a briefly held target on win32`, async () => {
    const space = new DataSpace(base);
    space.writeState({ active: 'slotA', pending: null });
    setPlatform('win32');

    const state = flakySync('EPERM', 2);
    space.writeState({ active: 'slotB', pending: 'slotA' });
    expect(state.calls()).toBe(3);
    vi.restoreAllMocks();
    expect(space.readState()).toEqual({ active: 'slotB', pending: 'slotA' });

    const journal = path.join(base, 'recovery', 'journal.json');
    const bytes = flakySync('EBUSY', 1);
    atomicWriteBytes(journal, '["a"]');
    expect(bytes.calls()).toBe(2);
    expect(fs.readFileSync(journal, 'utf8')).toBe('["a"]');
    vi.restoreAllMocks();

    const deviceId = path.join(base, '.device_id');
    fs.writeFileSync(deviceId, 'old');
    const file = flakyAsync('EACCES', 2);
    await atomicWriteFile(deviceId, 'box-1234abcd');
    expect(file.calls()).toBe(3);
    expect(fs.readFileSync(deviceId, 'utf8')).toBe('box-1234abcd');
    expect(fs.readdirSync(base).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it(`${ID}: no rename in the W07 call-site files bypasses the retrying helper`, () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    const files = [
      'host/platform/paths/rename-retry.ts',
      'host/platform/util/durable-fs.ts',
      'host/platform/secrets/backup-crypto.ts',
      'host/platform/secrets/crypto-publication.ts',
      'host/platform/storage/data-space-files.ts',
      'host/platform/storage/data-space.ts',
      'host/platform/storage/file-deletion-queue.ts',
      'host/platform/storage/locations.ts',
      'host/platform/storage/recovery-export.ts',
      'host/platform/storage/unified-file-manager.ts',
    ];
    const delegation = /^\s*(return )?retryRename(Sync)?\((options\.platform \?\? )?process\.platform, \(\) => fs\.(renameSync|promises\.rename)\(from, to\)\);$/;
    const lines = files.flatMap((file) => fs.readFileSync(path.join(root, file), 'utf8').split('\n')
      .map((line, index) => ({ file, line: index + 1, text: line })));
    const delegations = lines.filter(({ text }) => delegation.test(text));
    const direct = lines
      .filter(({ text }) => !delegation.test(text))
      .filter(({ text }) => /\bfsp?\.(promises\.)?rename(Sync)?\(|(^|[^.\w])rename\(|import\s*\{[^}]*\brename\b[^}]*\}\s*from\s*'node:fs/.test(text));
    expect(direct).toEqual([]);
    expect(delegations.map(({ file }) => file)).toEqual([
      'host/platform/util/durable-fs.ts',
      'host/platform/util/durable-fs.ts',
      'host/platform/storage/data-space-files.ts',
    ]);
  });
});
