import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../host/kernel/testing.ts';
import { exportUnifiedBackupData } from '../backup-export.ts';
import { toRfc3339 as rfc3339Now } from '../../host/platform/time/index.ts';
import plugin from '../index.ts';
import { checkPdfStreamAccess, pathIsWithin, windowsComparablePathText } from '../pdfstream-access.ts';
import { loadWebviewSettings, saveWebviewSettings } from '../webview-settings.ts';

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-shell-'));
  roots.push(dir);
  return dir;
};
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('webview settings file', () => {
  it('save_webview_settings writes pretty JSON and returns UTF-8 byte size', async () => {
    const dir = temp();
    const settings = { theme: 'dark', labels: ['错题', '复习'] };
    const result = await saveWebviewSettings(settings, { dataDir: async () => dir, platform: 'darwin' });
    expect(result.path).toBe(join(dir, 'webview_settings.json'));
    expect(result.size).toBe(Buffer.byteLength(JSON.stringify(settings, null, 2), 'utf8'));
    await expect(loadWebviewSettings({ dataDir: async () => dir, platform: 'darwin' })).resolves.toEqual({ exists: true, settings });
  });

  it('load_webview_settings reports missing files and rejects malformed JSON', async () => {
    const dir = temp();
    await expect(loadWebviewSettings({ dataDir: async () => dir, platform: 'linux' })).resolves.toEqual({ exists: false, settings: null });
    writeFileSync(join(dir, 'webview_settings.json'), '{ nope', 'utf8');
    await expect(loadWebviewSettings({ dataDir: async () => dir, platform: 'linux' })).rejects.toMatchObject({
      value: { error_type: 'Validation' },
    });
  });
});

describe('pdfstream_check_access', () => {
  it('accepts a PDF inside an allowed directory and reports its size', () => {
    const allowed = temp();
    const outside = temp();
    const pdf = join(allowed, '讲义.PDF');
    writeFileSync(pdf, 'abc');
    expect(checkPdfStreamAccess(pdf, [allowed], 'darwin')).toEqual({ available: true, size: 3, reason: null });

    const outsidePdf = join(outside, 'x.pdf');
    writeFileSync(outsidePdf, 'abc');
    expect(checkPdfStreamAccess(outsidePdf, [allowed], 'darwin')).toEqual({
      available: false, size: null, reason: '路径不在 pdfstream 白名单目录内',
    });
  });

  it('rejects missing files, non-PDF files and directories with Rust reason texts', () => {
    const allowed = temp();
    expect(checkPdfStreamAccess(join(allowed, 'missing.pdf'), [allowed], 'linux')).toMatchObject({
      available: false, size: null, reason: expect.stringMatching(/^文件不存在或不可读: /),
    });
    const text = join(allowed, 'note.txt');
    writeFileSync(text, 'x');
    expect(checkPdfStreamAccess(text, [allowed], 'linux').reason).toBe('非 PDF 文件');
    const directory = join(allowed, 'folder.pdf');
    mkdirSync(directory);
    expect(checkPdfStreamAccess(directory, [allowed], 'linux').reason).toBe('路径不是常规文件');
  });

  it('windows path comparison normalizes verbatim prefixes and enforces component boundaries', () => {
    expect(windowsComparablePathText('\\\\?\\D:\\Docs\\')).toBe('d:\\docs');
    expect(windowsComparablePathText('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\srv\\share\\x');
    expect(pathIsWithin('D:\\Docs\\a.pdf', '\\\\?\\D:\\Docs', 'win32')).toBe(true);
    expect(pathIsWithin('D:\\Docs2\\a.pdf', 'D:\\Docs', 'win32')).toBe(false);
  });
});

describe('export_unified_backup_data', () => {
  it('exports settings, API configurations and model assignments', async () => {
    const result = await exportUnifiedBackupData({ include_settings: true, include_images: false }, {
      settings: { listByPrefix: () => [{ key: 'theme', value: 'dark' }, { key: 'lang', value: 'zh' }] },
      llm: {
        getApiConfigs: async () => [{ id: 'cfg-1' }],
        getModelAssignments: async () => ({ model2_config_id: 'cfg-1' }),
      },
      now: () => '2026-11-03T02:09:00.123456+00:00',
    });
    expect(result).toEqual({
      version: '3.0',
      timestamp: '2026-11-03T02:09:00.123456+00:00',
      backup_type: 'unified',
      traditional_data: {
        reviews: [],
        settings: {
          system_settings: { theme: 'dark', lang: 'zh' },
          api_configurations: [{ id: 'cfg-1' }],
          model_assignments: { model2_config_id: 'cfg-1' },
        },
      },
      metadata: { export_options: { include_settings: true, include_images: false } },
    });
  });

  it('skips settings and LLM lookups when include_settings is false', async () => {
    let touched = false;
    const result = await exportUnifiedBackupData({ include_settings: false }, {
      settings: { listByPrefix: () => { touched = true; return []; } },
      llm: { getApiConfigs: async () => { touched = true; return []; }, getModelAssignments: async () => { touched = true; return null; } },
      now: () => '2026-11-03T02:09:00+00:00',
    });
    expect(touched).toBe(false);
    expect(result.traditional_data.settings).toEqual({ system_settings: {}, api_configurations: [], model_assignments: null });
  });

  it('formats chrono AutoSi timestamps with UTC offset', () => {
    const base = BigInt(Date.UTC(2026, 10, 3, 2, 9, 0)) * 1_000_000n;
    expect(rfc3339Now(base)).toBe('2026-11-03T02:09:00+00:00');
    expect(rfc3339Now(base + 123_000_000n)).toBe('2026-11-03T02:09:00.123+00:00');
    expect(rfc3339Now(base + 123_456_000n)).toBe('2026-11-03T02:09:00.123456+00:00');
    expect(rfc3339Now(base + 123_456_789n)).toBe('2026-11-03T02:09:00.123456789+00:00');
  });
});

describe('F2 shell commands through the Host', () => {
  it('registers and serves pdfstream_check_access with main-provided whitelist dirs', async () => {
    const allowed = temp();
    const pdf = join(allowed, 'a.pdf');
    writeFileSync(pdf, 'pdf');
    const host = await createTestHost({
      plugins: [plugin],
      app: { platform: 'darwin' },
      shell: (op) => op === 'app.pdfStreamAllowedDirs' ? [allowed] : null,
    });
    try {
      await expect(host.invoke('pdfstream_check_access', { path: pdf })).resolves.toEqual({ available: true, size: 3, reason: null });
      expect(host.shellRequests.at(-1)).toMatchObject({ op: 'app.pdfStreamAllowedDirs' });
    } finally { await host.dispose(); }
  });

  it('reads the saved backend Sentry consent once the settings service is provided', async () => {
    const reads: string[] = [];
    const host = await createTestHost({
      plugins: [plugin],
      app: { platform: 'linux' },
      provide: { settings: { get: (key: string) => { reads.push(key); return 'false'; }, save: () => undefined } },
      shell: () => null,
    });
    try {
      await vi.waitFor(() => expect(reads).toEqual(['sentry_error_reporting_enabled']));
    } finally { await host.dispose(); }
  });

  it('registers export_unified_backup_data and set_backend_sentry_enabled with injected services', async () => {
    const saved: Array<[string, string]> = [];
    const host = await createTestHost({
      plugins: [plugin],
      app: { platform: 'linux' },
      provide: {
        settings: { save: (key: string, value: string) => { saved.push([key, value]); }, listByPrefix: () => [{ key: 'theme', value: 'dark' }] },
        llm: { getApiConfigs: async () => [], getModelAssignments: async () => ({ model2_config_id: null }) },
      },
      shell: () => null,
    });
    try {
      const result = await host.invoke('export_unified_backup_data', { options: { include_settings: true } }) as Record<string, unknown>;
      expect(result.version).toBe('3.0');
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,9})?\+00:00$/);
      await expect(host.invoke('set_backend_sentry_enabled', { enabled: true })).resolves.toBe(false);
      // 初始化失败（未配置 DSN）时授权必须回滚，持久化状态不能停在 'true'。
      expect(saved).toEqual([
        ['sentry_error_reporting_enabled', 'true'],
        ['sentry_error_reporting_enabled', 'false'],
      ]);
    } finally { await host.dispose(); }
  });
});
