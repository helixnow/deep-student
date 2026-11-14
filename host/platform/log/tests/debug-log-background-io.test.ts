import { open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

it('F4-V2-14 background disk sync yields to other Host commands until atomic publication', async () => {
  const host = await createTestHost();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let restore = () => {};
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const dir = await host.invoke<string>('ensure_debug_log_dir');
    const probe = await open(host.ctx.log.mainLogFile, 'r');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.sync;
    // Explicit slow-IO completion injection, not a fake filesystem: fsync really
    // runs, then its completion is held before rename. No artificial CPU sleep.
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      await Reflect.apply(original, this, []);
      entered();
      await held;
    });
    restore = () => spy.mockRestore();
    const path = host.ctx.log.debugLogs.writeResponseEntry(dir, 'tag', 'model', 'event', 'response')!;
    const flushed = host.ctx.log.debugLogs.flushPending();
    const first = await Promise.race([started.then(() => 'async-sync'), flushed.then(() => 'finished-without-async-sync')]);
    expect(first).toBe('async-sync');
    expect(existsSync(path)).toBe(false); // still temporary, before the held sync completes
    let ticked = false;
    await new Promise<void>(resolve => setTimeout(() => { ticked = true; resolve(); }, 0));
    expect(ticked).toBe(true);
    expect(await host.invoke('get_test_logs', { logType: 'frontend' })).toEqual([]);
    // A delayed IO completion must not starve the 10s flush deadline either.
    // Advance only the timer logic; do not add a real ten-second sleep.
    vi.useFakeTimers();
    const timedFlush = host.ctx.log.debugLogs.flushPending();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await timedFlush).toBe(false);
    vi.useRealTimers();
    release();
    expect(await flushed).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).raw_response).toBe('response');
  } finally {
    vi.useRealTimers();
    release();
    await host.ctx.log?.debugLogs.flushPending();
    restore();
    await host.dispose();
  }
});

it('F4-V2-14 failed background writes still warn and settle pending even if temp cleanup fails', async () => {
  const host = await createTestHost();
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const notDirectory = join(host.app.dataDir, 'regular-file');
    await writeFile(notDirectory, 'unchanged');
    const path = host.ctx.log.debugLogs.writeResponseEntry(notDirectory, 'tag', 'model', 'event', 'response')!;
    expect(await host.ctx.log.debugLogs.flushPending()).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await readFile(notDirectory, 'utf8')).toBe('unchanged');
    expect(await readFile(host.ctx.log.mainLogFile, 'utf8')).toContain('[DebugLog] Write failed');
  } finally { await host.dispose(); }
});

it('F4-V2-14 flush waits for asynchronous auto-cleanup and preserves the original 500-file/10% rule', async () => {
  const host = await createTestHost();
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const dir = await host.invoke<string>('ensure_debug_log_dir');
    await Promise.all(Array.from({ length: 500 }, (_, i) =>
      writeFile(join(dir, `0000-${String(i).padStart(6, '0')}.json`), '{}')));
    const path = host.ctx.log.debugLogs.writeResponseEntry(dir, 'tag', 'model', 'event', 'response')!;
    expect(await host.ctx.log.debugLogs.flushPending()).toBe(true);
    expect(await host.invoke('get_debug_logs_info')).toMatchObject({ count: 451, oldest_file: '0000-000050.json' });
    expect(JSON.parse(await readFile(path, 'utf8')).raw_response).toBe('response');
    await expect(readFile(join(dir, '0000-000000.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await host.dispose(); }
});
