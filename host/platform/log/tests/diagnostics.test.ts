import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../index.ts';

it('export_diagnostics_bundle redacts credentials and user content, excludes detailed logs by default', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform, env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    const root = host.ctx.log.logDir;
    await writeFile(join(root, 'sample.json'), JSON.stringify({ content: '中文内容', token: 'private-secret', url: 'https://example.com/path?private=1' }));
    await mkdir(join(root, 'debug-logs'), { recursive: true });
    await writeFile(join(root, 'debug-logs/request.json'), '{"prompt":"private prompt"}');
    const faultId = 'test-export-fault';
    await host.ctx.log.recordError({ source: 'host', operation: 'example_export', id: faultId,
      pluginId: 'example.plugin', error: "Cannot open '/tmp/private fixture/user document.txt'" });
    await host.invoke('report_frontend_log', { payload: { level: 'ERROR', kind: 'IPC_FAILURE', message: 'Operation failed',
      extra: { diagnosticId: faultId, operation: 'example_export' } } });
    const queried = await host.ctx.log.queryErrors({ id: faultId });
    expect(queried.records.map(r => r.source).sort()).toEqual(['frontend', 'host']);
    expect(queried.records.find(r => r.source === 'host')?.message).toContain('<local-path>');
    expect(JSON.stringify(queried)).not.toContain('user document.txt');
    const destination = join(host.app.dataDir, 'diagnostics.zip');
    const result = await host.invoke<{ path: string; fileCount: number; sizeBytes: number }>('export_diagnostics_bundle', { options: { destination } });
    expect(result.path).toBe(destination);
    const bytes = await readFile(destination);
    expect(result.sizeBytes).toBe(bytes.length);
    const zip = await JSZip.loadAsync(bytes);
    const incidentFile = Object.keys(zip.files).find(name => name.endsWith('_diagnostic.log'))!;
    const incidents = (await zip.file(incidentFile)!.async('string')).trim().split('\n')
      .map(line => JSON.parse(line)).filter(row => row.data.id === faultId);
    expect(incidents.map(row => row.data.source).sort()).toEqual(['frontend', 'host']);
    const sample = await zip.file('current/sample.json')!.async('string');
    expect(sample).toContain('[CONTENT REDACTED: 4 chars]');
    expect(sample).not.toContain('private-secret');
    expect(sample).not.toContain('?private');
    expect(zip.file('current/debug-logs/request.json')).toBe(null);
    expect(JSON.parse(await zip.file('manifest.json')!.async('string')).file_count).toBe(result.fileCount);
    await host.invoke('export_diagnostics_bundle', { options: { destination, includeDebugLogs: true } });
    const detailed = await JSZip.loadAsync(await readFile(destination));
    expect(await detailed.file('current/debug-logs/request.json')!.async('string')).toContain('private prompt');
    await expect(host.invoke('export_diagnostics_bundle', { options: { destination: 'relative.zip' } })).rejects.toBe('诊断包保存路径必须是绝对路径');
  } finally { await host.dispose(); }
});
