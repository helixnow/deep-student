import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

it('F4-V2-21 crash log writes the entire scrubbed report before fsync under short writes', async () => {
  const host = await createTestHost({ app: { debug: false } });
  let restore = () => {};
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const marker = 'f4-crash-short-write';
    const error = new Error(`${marker}: ${'崩溃记录😀 '.repeat(50)}END`);
    const expectedTail = host.ctx.log.scrubPii(`${error.stack}\n`);
    const original = fs.writeSync;
    const originalSync = fs.fsyncSync;
    let partialWrites = 0;
    let crashFd: number | undefined;
    let syncedBytes: number | undefined;
    // Explicit native IO fault: both old string and new Buffer writes reach the
    // same OS fd, but consume a prefix. No simulated process crash or Sentry call.
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation((...args: unknown[]) => {
      const data = args[1];
      if (typeof data === 'string' && data.includes(marker)) {
        crashFd = args[0] as number;
        const bytes = Buffer.from(data);
        partialWrites++;
        return original(args[0] as number, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), null);
      }
      if (Buffer.isBuffer(data) && data.includes(marker)) {
        crashFd = args[0] as number;
        const offset = typeof args[2] === 'number' ? args[2] : 0;
        const length = typeof args[3] === 'number' ? args[3] : data.length - offset;
        partialWrites++;
        return original(args[0] as number, data, offset, Math.max(1, Math.floor(length / 2)), null);
      }
      return Reflect.apply(original, fs, args);
    });
    const syncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fd === crashFd) syncedBytes = fs.fstatSync(fd).size;
      originalSync(fd);
    });
    syncBuiltinESMExports();
    restore = () => { spy.mockRestore(); syncSpy.mockRestore(); syncBuiltinESMExports(); };
    const path = host.ctx.log.writeCrashLog(error);
    const text = fs.readFileSync(path, 'utf8');
    expect(partialWrites).toBeGreaterThan(0);
    expect(text).toContain('=== Deep Student 崩溃日志 ===');
    expect(text).toContain(error.message);
    expect(text.endsWith(expectedTail)).toBe(true);
    expect(syncedBytes).toBe(fs.statSync(path).size);
    expect(text).not.toContain('\ufffd');
  } finally { restore(); await host.dispose(); }
});
