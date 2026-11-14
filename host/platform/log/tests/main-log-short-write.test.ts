import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

// tauri-plugin-log2.8.0 RotatingFile::flush -> File::write_all.
it('F4-V2-18 main log preserves a complete record when the OS write consumes a prefix', async () => {
  const host = await createTestHost({ app: { debug: false } });
  let restore = () => {};
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const marker = 'f4-main-short-write';
    const message = `${marker}: ${'日志内容😀 '.repeat(50)}END`;
    const original = fs.writeSync;
    let partialWrites = 0;
    // Explicit IO fault injection. Matching buffers really reach the same OS fd,
    // but consume only half the requested bytes. Other writes are untouched.
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation((...args: unknown[]) => {
      const data = args[1];
      if (Buffer.isBuffer(data) && data.includes(marker)) {
        const offset = typeof args[2] === 'number' ? args[2] : 0;
        const length = typeof args[3] === 'number' ? args[3] : data.length - offset;
        partialWrites++;
        return original(args[0] as number, data, offset, Math.max(1, Math.floor(length / 2)), null);
      }
      return Reflect.apply(original, fs, args);
    });
    // Named node:fs imports and the default fs object must observe the same fault.
    syncBuiltinESMExports();
    restore = () => { spy.mockRestore(); syncBuiltinESMExports(); };
    host.ctx.log.logger('short-write').info(message);
    const text = fs.readFileSync(host.ctx.log.mainLogFile, 'utf8');
    expect(partialWrites).toBeGreaterThan(0);
    expect(text).toContain(message);
    expect(text.endsWith(`${message}\n`)).toBe(true);
    expect(text).not.toContain('\ufffd');
  } finally { restore(); await host.dispose(); }
});
