import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

async function setup() {
  const host = await createTestHost();
  host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  return host;
}

it('F4-V2-23 save_test_log awaits asynchronous disk IO without blocking other Host commands', async () => {
  const host = await setup();
  const path = join(host.ctx.log.logDir, 'frontend', 'async-save.log');
  const content = '测试日志🙂\n'.repeat(8192);
  const debug = vi.spyOn(host.ctx.logger, 'debug');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = fs.writeFile;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === path) {
      // Explicit slow disk-completion injection; after release, write the real
      // payload to the OS. No fake filesystem or CPU sleep.
      entered();
      await held;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  let saving: Promise<unknown> | undefined;
  try {
    saving = host.invoke('save_test_log', { fileName: 'async-save.log', content, logType: 'frontend' });
    expect(await Promise.race([started.then(() => 'async-write'), saving.then(() => 'finished-without-async-write')]))
      .toBe('async-write');
    await expect(fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    let settled = false;
    void saving.then(() => { settled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(debug).not.toHaveBeenCalled();
    expect(await host.invoke('get_test_logs', { logType: 'frontend' })).toEqual([]);
    release();
    await saving;
    expect(await fs.readFile(path, 'utf8')).toBe(content);
    expect(debug).toHaveBeenCalledExactlyOnceWith(`测试日志已保存: ${JSON.stringify(path)}`);
  } finally {
    release();
    try { await saving; } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      debug.mockRestore();
      await host.dispose();
    }
  }
});

it('F4-V2-23 save_test_log keeps filename/type precedence and filesystem error wrapping', async () => {
  const host = await setup();
  const debug = vi.spyOn(host.ctx.logger, 'debug');
  try {
    await expect(host.invoke('save_test_log', { fileName: '../bad.log', content: '', logType: 'invalid' }))
      .rejects.toEqual({ error_type: 'Validation', message: '非法的日志文件名', details: null });
    await expect(host.invoke('save_test_log', { fileName: 'good.log', content: '', logType: 'invalid' }))
      .rejects.toEqual({ error_type: 'Validation', message: '不支持的日志类型', details: null });
    // A real directory at the output filename makes the actual write fail.
    const target = join(host.ctx.log.logDir, 'frontend', 'directory.log');
    await fs.mkdir(target);
    await expect(host.invoke('save_test_log', { fileName: 'directory.log', content: 'not written', logType: 'frontend' }))
      .rejects.toMatchObject({ error_type: 'FileSystem', message: expect.stringMatching(/^写入日志文件失败: /) });
    expect(await fs.readdir(target)).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
  } finally { debug.mockRestore(); await host.dispose(); }
});
