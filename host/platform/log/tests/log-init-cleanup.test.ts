import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

it('F4-V2-20 failed log plugin initialization closes its opened main-log descriptor', async () => {
  const host = await createTestHost({ app: { debug: false } });
  let restore = () => {};
  let opened: number | undefined;
  try {
    const paths = createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } });
    host.ctx.provide('paths', paths);
    fs.mkdirSync(paths.appLogDir, { recursive: true });
    const archives = new Set(Array.from({ length: 6 }, (_, i) => join(paths.appLogDir, `deep-student_2020-01-0${i + 1}_00-00-00.log`)));
    for (const path of archives) fs.writeFileSync(path, 'archive');
    const originalOpen = fs.openSync, originalUnlink = fs.unlinkSync;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((...args: unknown[]) => {
      const fd: number = Reflect.apply(originalOpen, fs, args);
      if (args[0] === paths.mainLogFile) opened = fd;
      return fd;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((...args: unknown[]) => {
      // Explicit archive-cleanup IO failure; files and descriptor are real.
      if (archives.has(String(args[0]))) throw new Error('archive cleanup denied');
      return Reflect.apply(originalUnlink, fs, args);
    });
    syncBuiltinESMExports();
    restore = () => { openSpy.mockRestore(); unlinkSpy.mockRestore(); syncBuiltinESMExports(); };
    await expect(host.install(log)).rejects.toThrow();
    expect(opened).toBeTypeOf('number');
    // Rust RotatingFile::new drops the partially initialized inner File on Err.
    expect(() => fs.fstatSync(opened!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(fs.readdirSync(paths.appLogDir).filter(name => archives.has(join(paths.appLogDir, name)))).toHaveLength(6);
  } finally {
    restore();
    // Fixture cleanup also closes the intentionally exposed old-implementation leak on a red run.
    if (opened !== undefined) { try { fs.closeSync(opened); } catch { /* fixed implementation already closed it */ } }
    await host.dispose();
  }
});
