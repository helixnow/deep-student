import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { exportBackupToZip } from '../src/zip.ts';
import { createBackupHost, hostBackupRoot, partialManifest, waitForJob, writeBackup } from './helpers.ts';

const hosts: Array<{ host: TestHost; secrets: unknown }> = [];
afterEach(async () => { for (const entry of hosts.splice(0)) await entry.host.dispose(); });

async function setup(shell?: (op: string, args: unknown) => unknown) {
  const created = await createBackupHost({ secrets: true, ...(shell ? { shell } : {}) });
  hosts.push(created);
  return created;
}

it('data_governance_get_backup_list returns sorted partial archive info', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const first = partialManifest('backup-old', {
    createdAt: '2026-01-01T00:00:00.000Z', files: { 'persistent/a.json': 'a' },
  });
  const second = partialManifest('backup-new', {
    createdAt: '2026-02-01T00:00:00.000Z', files: { 'persistent/b.json': 'bb' },
  });
  writeBackup(root, first, { 'persistent/a.json': 'a' });
  writeBackup(root, second, { 'persistent/b.json': 'bb' });
  const list = await host.invoke('data_governance_get_backup_list') as Array<Record<string, unknown>>;
  expect(list.map(item => item.path)).toEqual(['backup-new', 'backup-old']);
  expect(list[0]).toMatchObject({
    size: 2, backup_type: 'partial_overlay', recovery_kind: 'partial_archive', restorable: false,
  });
});

it('data_governance_delete_backup removes only the requested backup', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  writeBackup(root, partialManifest('backup-keep'), {});
  writeBackup(root, partialManifest('backup-delete'), {});
  expect(await host.invoke('data_governance_delete_backup', { backupId: 'backup-delete' })).toBe(true);
  expect(existsSync(join(root, 'backup-delete'))).toBe(false);
  expect(existsSync(join(root, 'backup-keep'))).toBe(true);
  await expect(host.invoke('data_governance_delete_backup', { backupId: 'backup-delete' })).rejects.toThrow('备份不存在');
});

it('data_governance_verify_backup reports checksum mismatches', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  writeBackup(root, partialManifest('backup-verify', { files: { 'persistent/a.json': 'hello' } }), {
    'persistent/a.json': 'hello',
  });
  const valid = await host.invoke('data_governance_verify_backup', { backupId: 'backup-verify' }) as Record<string, unknown>;
  expect(valid).toMatchObject({ is_valid: true, checksum_match: true, errors: [] });

  writeFileSync(join(root, 'backup-verify', 'persistent', 'a.json'), 'HELLO');
  const invalid = await host.invoke('data_governance_verify_backup', { backupId: 'backup-verify' }) as Record<string, unknown>;
  expect(invalid.is_valid).toBe(false);
  expect(invalid.checksum_match).toBe(false);
  expect((invalid.errors as string[]).join('; ')).toContain('校验和不匹配');
});

it('data_governance_auto_verify_latest_backup verifies the newest backup', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  writeBackup(root, partialManifest('older', {
    createdAt: '2026-01-01T00:00:00.000Z', files: { 'persistent/a.json': 'a' },
  }), { 'persistent/a.json': 'a' });
  writeBackup(root, partialManifest('newer', {
    createdAt: '2026-02-01T00:00:00.000Z', files: { 'persistent/b.json': 'b' },
  }), { 'persistent/b.json': 'b' });
  const response = await host.invoke('data_governance_auto_verify_latest_backup') as Record<string, unknown>;
  expect(response.backup_id).toBe('newer');
  expect(response.is_valid).toBe(true);
  expect(response.duration_ms).toBeGreaterThanOrEqual(0);
});

it('data_governance_check_disk_space_for_restore uses the inactive slot volume', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  writeBackup(root, partialManifest('backup-disk', { files: { 'persistent/a.json': '0123456789' } }), {
    'persistent/a.json': '0123456789',
  });
  const response = await host.invoke('data_governance_check_disk_space_for_restore', {
    backupId: 'backup-disk',
  }) as Record<string, unknown>;
  expect(response.backup_size).toBe(10);
  expect(response.required_bytes).toBe(20);
  expect(response.available_bytes).toBeGreaterThan(0);
  expect(typeof response.has_enough_space).toBe('boolean');
});

it('data_governance_verify_backup_with_assets keeps the Rust boundary-root behavior', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  writeBackup(root, partialManifest('backup-assets', { files: { 'persistent/a.json': 'a' } }), {
    'persistent/a.json': 'a',
  });
  await expect(host.invoke('data_governance_verify_backup_with_assets', {
    backupId: 'backup-assets',
  })).rejects.toThrow('解析备份根目录失败');

  mkdirSync(join(host.app.dataDir, 'backups', 'backup-assets'), { recursive: true });
  const response = await host.invoke('data_governance_verify_backup_with_assets', {
    backupId: 'backup-assets',
  }) as Record<string, unknown>;
  expect(response.is_valid).toBe(true);
  expect(response.has_assets).toBe(false);
});

it('data_governance_restore_backup fail-closes partial archives before writing data', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  writeBackup(root, partialManifest('backup-restore', { files: { 'persistent/a.json': 'a' } }), {
    'persistent/a.json': 'a',
  });
  const started = await host.invoke('data_governance_restore_backup', {
    backupId: 'backup-restore',
  }) as Record<string, unknown>;
  const job = await waitForJob(host, String(started.job_id));
  expect(job.status).toBe('failed');
  expect(String(job.message)).toContain('E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE');
  expect(readFileSync(join(root, 'backup-restore', 'persistent', 'a.json'), 'utf8')).toBe('a');
});

it('data_governance_purge_all_data writes the marker and requests a full restart', async () => {
  const requests: Array<{ op: string; args: unknown }> = [];
  const { host } = await setup((op, args) => { requests.push({ op, args }); return null; });
  await expect(host.invoke('data_governance_purge_all_data')).rejects.toThrow('应用重启未生效：进程仍在运行');
  expect(requests.map(request => request.op)).toContain('process:restart');
  const marker = join(host.app.dataDir, '.purge_on_next_start');
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('1');
});

it('list_resumable_jobs marks sealed imports as password-protected', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { 'persistent/a.json': 'a', 'crypto/.secure/.key_seed': 'seed-value' };
  const manifest = partialManifest('backup-resumable', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const plain = await exportBackupToZip(host.ctx, join(root, 'backup-resumable'), {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, 'plain-resumable.zip'),
  }, () => undefined, () => false);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'backup-resumable'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-resumable.zip'),
  }, () => undefined, () => false);

  const jobsDir = join(host.app.dataDir, 'backup_jobs');
  mkdirSync(jobsDir, { recursive: true });
  const persisted = (jobId: string, zipPath: string) => ({
    job_id: jobId, kind: 'import', status: 'failed', phase: 'extract', progress: 20,
    created_at: '2026-01-01T00:00:00.000Z',
    params: { zip_path: zipPath, backup_id: 'restored', include_assets: false, include_checksums: false },
    checkpoint: {
      processed_items: ['persistent/a.json'], last_updated: '2026-01-01T00:00:01.000Z',
      current_index: 1, total_items: 4, partial_output: join(root, 'restored'),
    },
  });
  writeFileSync(join(jobsDir, 'plain.json'), JSON.stringify(persisted('plain', plain.zipPath)));
  writeFileSync(join(jobsDir, 'sealed.json'), JSON.stringify(persisted('sealed', sealed.zipPath)));

  const jobs = await host.invoke('data_governance_list_resumable_jobs') as Array<Record<string, unknown>>;
  expect(jobs).toHaveLength(2);
  expect(jobs.find(job => job.job_id === 'plain')?.requires_password).toBe(false);
  expect(jobs.find(job => job.job_id === 'sealed')?.requires_password).toBe(true);
});
