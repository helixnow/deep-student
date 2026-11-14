import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

async function setup() {
  const host = await createTestHost();
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  const directory = await host.invoke<string>('ensure_debug_log_dir');
  return { host, directory };
}

// debug_log_service.rs:694-709: Path::starts_with, extension check, then fs::read_to_string.
it('F4-V2-09 read_debug_log_file rejects invalid UTF-8 with Rust read_to_string Display', async () => {
  const { host, directory } = await setup();
  try {
    const path = join(directory, 'bad.json');
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8])]) {
      await writeFile(path, bytes);
      await expect(host.invoke('read_debug_log_file', { path })).rejects.toEqual({
        error_type: 'Unknown', message: '读取调试日志失败: stream did not contain valid UTF-8', details: null,
      });
    }
    // Valid replacement characters and UTF-8 BOM must not be mistaken for malformed bytes.
    const valid = '\ufeff{"text":"中文😀\ufffd"}';
    await writeFile(path, valid);
    expect(await host.invoke('read_debug_log_file', { path })).toBe(valid);
  } finally { await host.dispose(); }
});

it.skipIf(process.platform === 'win32')('F4-V2-09 Unix backslashes are filename characters, not debug-root components', async () => {
  const { host, directory } = await setup();
  try {
    const outside = join(host.ctx.log.logDir, 'debug-logs\\outside.json');
    await writeFile(outside, '{"outside":true}');
    await expect(host.invoke('read_debug_log_file', { path: outside })).rejects.toEqual({
      error_type: 'Unknown', message: '非法路径：不在 debug-logs 目录中', details: null,
    });
    const inside = join(directory, 'literal\\name.json');
    await writeFile(inside, '{"inside":true}');
    expect(await host.invoke('read_debug_log_file', { path: inside })).toBe('{"inside":true}');
  } finally { await host.dispose(); }
});

it.skipIf(process.platform === 'win32')('F4-V2-17 debug log ordering compares literal Unix filename bytes rather than splitting backslashes', async () => {
  const { host, directory } = await setup();
  try {
    await writeFile(join(directory, 'a\\b.json'), 'backslash');
    await writeFile(join(directory, 'a-b.json'), 'dash');
    // Both are one Normal path component on Unix; '-' sorts before '\\'.
    expect(await host.invoke('get_debug_logs_info')).toMatchObject({
      count: 2, oldest_file: 'a-b.json', newest_file: 'a\\b.json',
    });
  } finally { await host.dispose(); }
});
