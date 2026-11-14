import { existsSync, mkdirSync, mkdtempSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import {
  INCREMENTAL_BACKUP_REMOVED_MESSAGE, INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE, MAX_MANIFEST_BYTES,
  loadManifest, saveManifest, validateForSlotRestore, type BackupManifest,
} from '../src/manifest.ts';
import { createBackup, listBackups, verifyDirectoryWithAssets } from '../src/backup-manager.ts';
import {
  createBackupHost, fullBackupFiles, fullManifest, hostBackupRoot, partialManifest, writeBackup,
} from './helpers.ts';

const hosts: Array<{ host: TestHost; secrets: unknown }> = [];
afterEach(async () => { for (const entry of hosts.splice(0)) await entry.host.dispose(); });

async function setup() {
  const created = await createBackupHost();
  hosts.push(created);
  return created;
}

function legacyIncrementalManifest(backupId: string): BackupManifest {
  const manifest = partialManifest(backupId, { files: { 'vfs_changes.json': '[]' } });
  manifest.version = '2.0.0';
  manifest.coverage = undefined;
  manifest.snapshot_kind = 'legacy_candidate';
  manifest.key_policy = 'legacy_unknown';
  manifest.is_incremental = true;
  manifest.incremental_base = '20260101_000000';
  return manifest;
}

it('backup_incremental_create_returns_removed_error', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const before = existsSync(root) ? readdirSync(root) : [];
  await expect(host.invoke('data_governance_run_backup', {
    backupType: 'incremental',
  })).rejects.toThrow(INCREMENTAL_BACKUP_REMOVED_MESSAGE);
  const after = existsSync(root) ? readdirSync(root) : [];
  expect(after).toEqual(before);
});

it('restore_rejects_legacy_incremental_manifest', () => {
  const manifest = legacyIncrementalManifest('incr_legacy');
  expect(() => validateForSlotRestore(manifest)).toThrow(INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE);
});

it('legacy_incremental_listed_as_incremental_and_restore_rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-legacy-incr-'));
  const full = partialManifest('20260701_full', { files: {} });
  full.version = '2.0.0';
  full.coverage = undefined;
  full.snapshot_kind = 'legacy_candidate';
  full.key_policy = 'legacy_unknown';
  mkdirSync(join(root, '20260701_full'), { recursive: true });
  saveManifest(join(root, '20260701_full', 'manifest.json'), full);
  const incr = legacyIncrementalManifest('20260702_incremental');
  incr.incremental_base = '20260701_full';
  mkdirSync(join(root, '20260702_incremental'), { recursive: true });
  saveManifest(join(root, '20260702_incremental', 'manifest.json'), incr);

  const listed = listBackups(root);
  expect(listed.length).toBeGreaterThanOrEqual(2);
  const listedIncr = listed.find(manifest => manifest.backup_id === '20260702_incremental');
  expect(listedIncr).toBeDefined();
  expect(listedIncr!.is_incremental).toBe(true);
  expect(listedIncr!.incremental_base).toBe('20260701_full');
  expect(() => validateForSlotRestore(listedIncr!)).toThrow(INCREMENTAL_RESTORE_NOT_SUPPORTED_MESSAGE);
});

it('test_manifest_loader_rejects_oversized_file_before_allocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-oversized-'));
  const path = join(dir, 'manifest.json');
  writeFileSync(path, '');
  truncateSync(path, MAX_MANIFEST_BYTES + 1);
  expect(() => loadManifest(path)).toThrow('清单文件过大');
});

it('test_verify_checksum_mismatch', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const manifest = fullManifest('checksum-mismatch');
  writeBackup(root, manifest, fullBackupFiles(manifest));
  const dir = join(root, 'checksum-mismatch');
  writeFileSync(join(dir, 'vfs.db'), 'corrupted!');
  const result = await verifyDirectoryWithAssets(host.ctx, dir, manifest);
  expect(result.isValid).toBe(false);
  expect(result.databaseErrors.join('; ')).toContain('校验和不匹配 vfs.db');
});


it('test_backup_full_rejects_missing_core_database', async () => {
  const { host } = await setup();
  const activeDir = join(host.app.dataDir, 'slots', 'slotA');
  mkdirSync(activeDir, { recursive: true });
  await expect(createBackup({
    ctx: host.ctx, backupRoot: hostBackupRoot(host), activeDir, baseDir: host.app.dataDir,
  }, { includeAssets: false })).rejects.toThrow('完整备份缺少核心数据库 vfs');
});
