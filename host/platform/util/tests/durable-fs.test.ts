import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENAME_RETRY_DELAYS_MS } from '../../paths/rename-retry.ts';
import { fsyncDirectory, fsyncDirectorySync, renameWithRetry, renameWithRetrySync } from '../node.ts';

const ID = 'RF-W14-files-rename-retry';
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename`), { code });

let dir: string;
let platform: NodeJS.Platform;
let from: string;
let to: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-durable-fs-'));
  from = path.join(dir, 'from.tmp');
  to = path.join(dir, 'to.json');
  fs.writeFileSync(from, 'new');
  fs.writeFileSync(to, 'old');
  platform = process.platform;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the wrapper while recording the backoff delays it asked for, without actually sleeping. */
async function runRecordingDelays(kind: 'async' | 'sync'): Promise<{ delays: number[]; outcome: Promise<void> }> {
  const delays: number[] = [];
  if (kind === 'sync') {
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      delays.push(Number(timeout));
      return 'timed-out';
    });
    let outcome: Promise<void>;
    try {
      renameWithRetrySync(from, to, { platform });
      outcome = Promise.resolve();
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.catch(() => undefined);
    return { delays, outcome };
  }
  vi.useFakeTimers();
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(handler, ms);
  }) as typeof setTimeout);
  const outcome = renameWithRetry(from, to, { platform });
  outcome.catch(() => undefined);
  await vi.runAllTimersAsync();
  return { delays, outcome };
}

describe.each([
  ['renameWithRetry', 'async'],
  ['renameWithRetrySync', 'sync'],
] as const)('%s', (_name, kind) => {
  const spyRename = () => (kind === 'async' ? vi.spyOn(fs.promises, 'rename') : vi.spyOn(fs, 'renameSync'));
  const run = async (): Promise<void> => (kind === 'async' ? renameWithRetry(from, to, { platform }) : renameWithRetrySync(from, to, { platform }));

  it(`${ID}: on win32 retries EPERM, EACCES and EBUSY until the replace succeeds, passing both paths verbatim`, async () => {
    platform = 'win32';
    const spy = spyRename();
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) spy.mockImplementationOnce(() => { throw errno(code); });
    const { delays, outcome } = await runRecordingDelays(kind);
    await outcome;
    expect(spy.mock.calls.map(call => call.slice(0, 2))).toEqual(Array.from({ length: 4 }, () => [from, to]));
    expect(delays).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 3));
    expect(fs.readFileSync(to, 'utf8')).toBe('new');
    expect(fs.existsSync(from)).toBe(false);
  });

  it(`${ID}: on win32 a holder that never lets go exhausts the paths/rename-retry.ts table and throws the last original error`, async () => {
    platform = 'win32';
    const errors = RENAME_RETRY_DELAYS_MS.map((_, i) => errno(i % 2 === 0 ? 'EPERM' : 'EACCES')).concat(errno('EBUSY'));
    const spy = spyRename();
    for (const error of errors) spy.mockImplementationOnce(() => { throw error; });
    const { delays, outcome } = await runRecordingDelays(kind);
    await expect(outcome).rejects.toBe(errors.at(-1));
    expect(spy).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1);
    expect(delays).toEqual([...RENAME_RETRY_DELAYS_MS]);
    expect(fs.readFileSync(to, 'utf8')).toBe('old');
  });

  it(`${ID}: on win32 does not retry other codes`, async () => {
    platform = 'win32';
    const error = errno('EXDEV');
    const spy = spyRename().mockImplementationOnce(() => { throw error; });
    await expect(run()).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(['linux', 'darwin'] as const)(`${ID}: on %s throws the first EPERM without retrying, like Rust`, async (posix) => {
    platform = posix;
    const error = errno('EPERM');
    const spy = spyRename().mockImplementationOnce(() => { throw error; });
    await expect(run()).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

it(`${ID}: the synchronous wrapper really blocks for the first backoff step before retrying`, () => {
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw errno('EBUSY'); });
  const started = performance.now();
  renameWithRetrySync(from, to, { platform: 'win32' });
  expect(performance.now() - started).toBeGreaterThanOrEqual(RENAME_RETRY_DELAYS_MS[0]!);
  expect(fs.readFileSync(to, 'utf8')).toBe('new');
});

it.each([
  ['renameWithRetry', (): Promise<void> => renameWithRetry(from, to)],
  ['renameWithRetrySync', async (): Promise<void> => renameWithRetrySync(from, to)],
] as const)(`${ID}: %s without a platform option follows process.platform`, async (name, run) => {
  const error = errno('EBUSY');
  const once = () => { throw error; };
  const spy = name === 'renameWithRetry' ? vi.spyOn(fs.promises, 'rename').mockImplementationOnce(once) : vi.spyOn(fs, 'renameSync').mockImplementationOnce(once);
  if (process.platform === 'win32') {
    await run();
    expect(spy).toHaveBeenCalledTimes(2);
  } else {
    await expect(run()).rejects.toBe(error);
    expect(spy).toHaveBeenCalledTimes(1);
  }
});

describe('fsyncDirectory', () => {
  it('is a no-op on win32 (Rust #[cfg(not(unix))])', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    const openSync = vi.spyOn(fs, 'openSync');
    await fsyncDirectory(path.join(dir, 'missing'), { platform: 'win32' });
    fsyncDirectorySync(path.join(dir, 'missing'), { platform: 'win32' });
    expect(open).not.toHaveBeenCalled();
    expect(openSync).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('opens the directory read-only, fsyncs it and closes it on POSIX', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    const fsyncSync = vi.spyOn(fs, 'fsyncSync');
    const closeSync = vi.spyOn(fs, 'closeSync');
    await fsyncDirectory(dir, { platform: 'linux' });
    expect(open).toHaveBeenCalledWith(dir, 'r');
    fsyncDirectorySync(dir, { platform: 'linux' });
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    expect(closeSync).toHaveBeenCalledWith(fsyncSync.mock.calls[0]![0]);
  });

  it.skipIf(process.platform === 'win32')('propagates open failures on POSIX', async () => {
    await expect(fsyncDirectory(path.join(dir, 'missing'), { platform: 'linux' })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => fsyncDirectorySync(path.join(dir, 'missing'), { platform: 'linux' })).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});
