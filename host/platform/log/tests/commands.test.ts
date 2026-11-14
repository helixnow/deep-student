import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

it('debug log commands validate paths, preserve structured logs and expose real file statistics', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform, env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const dir = await host.invoke<string>('ensure_debug_log_dir');
    expect(dir).toBe(join(host.ctx.log.logDir, 'debug-logs'));
    expect(await host.invoke('get_debug_logs_info')).toMatchObject({ count: 0, total_size_bytes: 0 });
    await host.invoke('save_test_log', { fileName: 'sample.log', content: 'hello', logType: 'frontend' });
    expect(await host.invoke('get_test_logs', { logType: 'frontend' })).toEqual(['frontend/sample.log']);
    expect(await readFile(join(host.ctx.log.logDir, 'frontend/sample.log'), 'utf8')).toBe('hello');
    await expect(host.invoke('save_test_log', { fileName: '../sample.log', content: '', logType: 'frontend' })).rejects.toEqual({ error_type: 'Validation', message: '非法的日志文件名', details: null });
    await expect(host.invoke('get_test_logs', { logType: 'all' })).rejects.toMatchObject({ message: '不支持的日志类型' });
    await expect(host.invoke('open_log_file', { logPath: '../secret' })).rejects.toMatchObject({ message: '非法的文件路径' });
    await expect(host.invoke('open_log_file', { logPath: 'absent.log' })).rejects.toMatchObject({ message: '日志文件不存在: absent.log' });
    await expect(host.invoke('open_logs_folder', { logType: 'invalid' })).rejects.toMatchObject({ message: '不支持的日志类型' });
    const path = host.ctx.log.debugLogs.writeResponseEntry(dir, 'tag', 'model', 'event', 'response');
    expect(await host.invoke('get_debug_logs_info')).toMatchObject({ count: 1 });
    expect(await host.invoke('read_debug_log_file', { path })).toContain('response');
    expect(await host.invoke('cleanup_old_debug_logs', { maxAgeDays: 7 })).toBe(0);
    expect(await host.invoke('clear_debug_logs')).toBe(1);
    await host.invoke('report_frontend_log', { payload: { message: 'frontend', url: 'https://example.com/?secret=1#token' } });
    await host.invoke('write_debug_logs', { logs: [] });
    await host.invoke('log_debug_message', { message: 'diagnostic' });
    await host.invoke('tauri_lab_frontend_log', { level: 'info', message: 'diagnostic' });
  } finally { await host.dispose(); }
});

it('log plugin registers every command declared in meta.commands', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform, env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const coverage = host.coverage();
    expect(coverage.declaredNotRegistered).toEqual([]);
    expect(coverage.registeredNotDeclared).toEqual([]);
    expect(log.meta.commands).toContain('export_diagnostics_bundle');
  } finally { await host.dispose(); }
});
