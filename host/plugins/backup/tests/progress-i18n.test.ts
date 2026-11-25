import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { exportBackupToZip, importBackupFromZip } from '../src/zip.ts';
import {
  formatBackupProgressMessage,
  inferBackupProgressMessageKey,
  resolveBackupLocale,
} from '../src/progress-messages.ts';
import {
  createBackupHost, fullBackupFiles, fullManifest, hostBackupRoot, waitForJob, writeBackup,
} from './helpers.ts';

const CJK_RE = /[\u4e00-\u9fff]/;

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setup() {
  const created = await createBackupHost({ secrets: true });
  hosts.push(created.host);
  return created;
}

describe('backup progress localization and structured stage metadata', () => {
  it('resolves locale from host settings and formats zero-CJK English progress messages', async () => {
    const { host } = await setup();
    expect(resolveBackupLocale(host.ctx)).toBe('zh-CN');
    host.ctx.settings.save('language', 'en-US');
    expect(resolveBackupLocale(host.ctx)).toBe('en-US');

    const enPrecheck = formatBackupProgressMessage('en-US', 'zip.export.precheck_portable');
    const zhPrecheck = formatBackupProgressMessage('zh-CN', 'zip.export.precheck_portable');
    expect(enPrecheck).toBe('Generating portable manifest and pre-checking export sources...');
    expect(enPrecheck).not.toMatch(CJK_RE);
    expect(zhPrecheck).toBe('正在生成便携清单并预检导出源...');
    expect(inferBackupProgressMessageKey('scan', enPrecheck)).toBe('zip.export.precheck_portable');
    expect(inferBackupProgressMessageKey('scan', zhPrecheck)).toBe('zip.export.precheck_portable');
  });

  it('emits English progress messages and structured stage/message_key during en-US ZIP export & import', async () => {
    const { host } = await setup();
    host.ctx.settings.save('language', 'en-US');

    const root = hostBackupRoot(host);
    const manifest = fullManifest('backup_i18n_en');
    writeBackup(root, manifest, fullBackupFiles(manifest));
    const zipPath = join(host.app.dataDir, 'exports', 'i18n-en.zip');

    const exportStart = await host.invoke<{ job_id: string; message: string }>('data_governance_export_zip', {
      backupId: manifest.backup_id,
      outputPath: zipPath,
      compressionLevel: 6,
      includeChecksums: true,
    });
    expect(exportStart.message).not.toMatch(CJK_RE);
    const exportedJob = await waitForJob(host, exportStart.job_id);
    expect(exportedJob.status).toBe('completed');

    const exportEvents = (host.eventsNamed('backup-job-progress') as Array<Record<string, unknown>>)
      .filter(event => event.job_id === exportStart.job_id);
    expect(exportEvents.length).toBeGreaterThanOrEqual(4);
    for (const event of exportEvents) {
      expect(typeof event.stage).toBe('string');
      expect(event.stage).toBe(event.phase);
      if (typeof event.message === 'string') {
        expect(event.message).not.toMatch(CJK_RE);
      }
    }
    expect(exportEvents.some(event => event.message_key === 'zip.export.precheck_portable')).toBe(true);
    expect(exportEvents.some(event => event.message_key === 'zip.export.compressing_entry')).toBe(true);

    const importStart = await host.invoke<{ job_id: string; message: string }>('data_governance_import_zip', {
      zipPath,
      backupId: 'backup_i18n_en_imported',
    });
    expect(importStart.message).not.toMatch(CJK_RE);
    const importedJob = await waitForJob(host, importStart.job_id);
    expect(importedJob.status).toBe('completed');

    const importEvents = (host.eventsNamed('backup-job-progress') as Array<Record<string, unknown>>)
      .filter(event => event.job_id === importStart.job_id);
    expect(importEvents.length).toBeGreaterThanOrEqual(4);
    for (const event of importEvents) {
      expect(typeof event.stage).toBe('string');
      expect(event.stage).toBe(event.phase);
      if (typeof event.message === 'string') {
        expect(event.message).not.toMatch(CJK_RE);
      }
    }
    expect(importEvents.some(event => event.message_key === 'zip.import.validating')).toBe(true);
    expect(importEvents.some(event => event.message_key === 'zip.import.extracting_entry')).toBe(true);
  });

  it('preserves zh-CN progress messages when locale is default or zh-CN', async () => {
    const { host } = await setup();
    const root = hostBackupRoot(host);
    const manifest = fullManifest('backup_i18n_zh');
    writeBackup(root, manifest, fullBackupFiles(manifest));
    const zipPath = join(host.app.dataDir, 'exports', 'i18n-zh.zip');
    const seenMessages: string[] = [];

    await exportBackupToZip(
      host.ctx,
      join(root, manifest.backup_id),
      { compressionLevel: 6, outputPath: zipPath, includeChecksums: true },
      progress => seenMessages.push(progress.message),
      () => false,
    );
    expect(seenMessages).toContain('正在生成便携清单并预检导出源...');

    const importMessages: string[] = [];
    await importBackupFromZip(host.ctx, zipPath, join(root, 'backup_i18n_zh_imported'), {
      password: null,
      skipExisting: false,
      onProgress: progress => importMessages.push(progress.message),
      isCancelled: () => false,
    });
    expect(importMessages).toContain('正在验证 ZIP 文件...');
  });
});
