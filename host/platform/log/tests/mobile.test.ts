import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createOpfsFiles, mobileRoots } from '../../files/opfs.ts';
import { createFakeOpfs } from '../../files/tests/__fixtures__/fake-opfs.ts';
import pathsMobile from '../../paths/mobile.ts';
import logMobile from '../mobile.ts';

describe('log mobile plugin', () => {
  it('registers all declared commands and implements OPFS debug logs, sentry pref, and diagnostics bundle', async () => {
    const savedSettings = new Map<string, string>();
    const host = await createTestHost({
      app: { dataDir: '/deep-student', platform: 'linux', version: '0.20.1' },
    });
    try {
      const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots('/deep-student') });
      host.ctx.reflect.provide('files', files);
      host.ctx.reflect.provide('settings', {
        get: (k: string) => savedSettings.get(k) ?? null,
        save: (k: string, v: string) => { savedSettings.set(k, v); },
      } as never);
      await host.install(pathsMobile);
      await host.install(logMobile);

      const coverage = host.coverage();
      expect(coverage.declaredNotRegistered).toEqual([]);
      expect(coverage.registeredNotDeclared).toEqual([]);

      const debugDir = await host.invoke<string>('ensure_debug_log_dir');
      expect(debugDir).toBe('/deep-student/logs/debug-logs');
      expect(await host.invoke('get_debug_logs_info')).toMatchObject({ count: 0, total_size_bytes: 0 });

      const reqPath = host.ctx.log.debugLogs.writeRequestEntry(debugDir, 'chat', 'deepseek-chat', 'https://api.example.com?api_key=sk-secret123456', 'delta', { prompt: 'hello', apiKey: 'sk-1234567890123456' });
      expect(reqPath).toContain('/deep-student/logs/debug-logs/');
      expect(await host.ctx.log.debugLogs.flushPending()).toBe(true);

      const info = await host.invoke<{ count: number; total_size_bytes: number; oldest_file: string | null }>('get_debug_logs_info');
      expect(info.count).toBe(1);
      expect(info.total_size_bytes).toBeGreaterThan(0);
      expect(info.oldest_file).not.toBeNull();

      const content = await host.invoke<string>('read_debug_log_file', { path: reqPath! });
      expect(content).toContain('[REDACTED]');
      expect(content).not.toContain('sk-secret123456');

      await expect(host.invoke('read_debug_log_file', { path: '/deep-student/logs/../secret.json' })).rejects.toBeTruthy();

      await host.invoke('write_debug_logs', {
        logs: [{ timestamp: '2026-01-01T00:00:00Z', level: 'INFO', module: 'ui', operation: 'render', message: 'token=abcdef123456', data: null }],
      });
      await host.invoke('log_debug_message', { message: 'diagnostic message' });
      await host.invoke('report_frontend_log', {
        payload: { level: 'ERROR', kind: 'IPC_FAILURE', message: 'Failed on /deep-student/secret.txt with sk-abcdefghij123456' },
      });
      await host.invoke('tauri_lab_frontend_log', { level: 'warn', message: 'lab message', stack: 'at test.ts:1' });

      expect(await host.invoke('set_backend_sentry_enabled', { enabled: true })).toBe(false);
      expect(savedSettings.get('sentry_error_reporting_enabled')).toBe('true');

      // Export ZIP diagnostics without debug logs first
      const zipDest = '/deep-student/tmp/diag.zip';
      const zipRes = await host.invoke<{ path: string; fileCount: number; skippedCount: number; sizeBytes: number }>('export_diagnostics_bundle', {
        options: { destination: zipDest, includeDebugLogs: false },
      });
      expect(zipRes.path).toBe(zipDest);
      const zip = await JSZip.loadAsync(await files.readBytes(zipDest));
      expect(zip.file('manifest.json')).not.toBeNull();
      expect(zip.file('system_info.json')).not.toBeNull();
      expect(zip.file('ring_entries.json')).not.toBeNull();
      expect(Object.keys(zip.files).some(name => name.includes('debug-logs/'))).toBe(false);

      // Export JSON diagnostics with debug logs
      const jsonDest = '/deep-student/tmp/diag.json';
      await host.invoke('export_diagnostics_bundle', {
        options: { destination: jsonDest, includeDebugLogs: true },
      });
      const jsonBundle = JSON.parse(await files.readText(jsonDest)) as { files: Array<{ name: string }> };
      expect(jsonBundle.files.some(f => f.name.includes('debug-logs/'))).toBe(true);

      await expect(host.invoke('export_diagnostics_bundle', { options: { destination: 'relative.zip' } }))
        .rejects.toContain('绝对路径');

      expect(await host.invoke('cleanup_old_debug_logs', { maxAgeDays: 7 })).toBe(0);
      expect(await host.invoke('clear_debug_logs')).toBe(1);
      expect(await host.invoke('get_debug_logs_info')).toMatchObject({ count: 0 });
    } finally {
      await host.dispose();
    }
  });
});
