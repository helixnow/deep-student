import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { exportBackupToZip, importBackupFromZip } from '../src/zip.ts';
import { ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_DECRYPT_FAILED_CODE, SEALED_BACKUP_PASSWORD_REQUIRED_CODE } from '../src/zip-codes.ts';
import {
  createBackupHost, fullBackupFiles, fullManifest, hostBackupRoot, writeBackup,
} from './helpers.ts';

const TEST_PASSWORD = 'precheck-secret-1';
const hosts: Array<{ host: TestHost; secrets: unknown }> = [];
afterEach(async () => { for (const entry of hosts.splice(0)) await entry.host.dispose(); });

async function setup() {
  const created = await createBackupHost({ secrets: true });
  hosts.push(created);
  return created;
}

async function exportPlain(host: TestHost, id = 'precheck-plain') {
  const root = hostBackupRoot(host);
  const manifest = fullManifest(id);
  writeBackup(root, manifest, fullBackupFiles(manifest));
  return exportBackupToZip(host.ctx, join(root, id), {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, `${id}.zip`),
  }, () => undefined, () => false);
}

async function exportSealed(host: TestHost, id = 'precheck-sealed') {
  const root = hostBackupRoot(host);
  const manifest = fullManifest(id);
  writeBackup(root, manifest, fullBackupFiles(manifest));
  return exportBackupToZip(host.ctx, join(root, id), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: TEST_PASSWORD,
    outputPath: join(host.app.dataDir, `${id}.zip`),
  }, () => undefined, () => false);
}

it('no_password_is_left_to_existing_missing_password_gate', async () => {
  const { host } = await setup();
  const portable = await exportPlain(host, 'gate-plain');
  const sealed = await exportSealed(host, 'gate-sealed');
  const portableTarget = join(host.app.dataDir, 'gate-plain-target');
  const fileCount = await importBackupFromZip(host.ctx, portable.zipPath, portableTarget, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(fileCount).toBeGreaterThan(0);

  for (const resumable of [false, true]) {
    const target = join(host.app.dataDir, `gate-sealed-target-${String(resumable)}`);
    await expect(importBackupFromZip(host.ctx, sealed.zipPath, target, {
      password: null, skipExisting: resumable, onProgress: () => undefined, isCancelled: () => false,
    })).rejects.toThrow(SEALED_BACKUP_PASSWORD_REQUIRED_CODE);
    expect(existsSync(target)).toBe(false);
  }
});

it('explicit_password_on_portable_zip_fails_fast_in_both_modes', async () => {
  const { host } = await setup();
  const portable = await exportPlain(host, 'explicit-plain');
  for (const resumable of [false, true]) {
    const target = join(host.app.dataDir, `explicit-plain-target-${String(resumable)}`);
    await expect(importBackupFromZip(host.ctx, portable.zipPath, target, {
      password: TEST_PASSWORD, skipExisting: resumable, onProgress: () => undefined, isCancelled: () => false,
    })).rejects.toThrow('不是加密全保真备份');
    expect(existsSync(target)).toBe(false);
  }
});

it('wrong_password_on_sealed_zip_fails_fast_without_resume', async () => {
  const { host } = await setup();
  const sealed = await exportSealed(host, 'wrong-fast');
  const target = join(host.app.dataDir, 'wrong-fast-target');
  await expect(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'definitely-wrong-password', skipExisting: false,
    onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  await expect(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'definitely-wrong-password', skipExisting: false,
    onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow('解封加密备份失败');
  expect(existsSync(target)).toBe(false);
});

it('correct_password_on_sealed_zip_passes_precheck', async () => {
  const { host } = await setup();
  const sealed = await exportSealed(host, 'correct-precheck');
  const target = join(host.app.dataDir, 'correct-precheck-target');
  const fileCount = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: TEST_PASSWORD, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(fileCount).toBeGreaterThan(0);
});

it('resumable_sealed_zip_defers_wrong_password_to_unseal_layer', async () => {
  const { host } = await setup();
  const sealed = await exportSealed(host, 'deferred-wrong');
  const target = join(host.app.dataDir, 'deferred-wrong-target');
  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'definitely-wrong-password', skipExisting: true,
    onProgress: () => undefined, isCancelled: () => false,
  }).catch((cause: unknown) => cause as Error) as Error;
  expect(error.message).toContain(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  expect(existsSync(target)).toBe(true);
  expect(existsSync(join(target, ENCRYPTED_SECRETS_ENTRY))).toBe(true);
});

it('corrupted_sealed_payload_fails_fast_with_any_password', async () => {
  const { host } = await setup();
  const zip = new JSZip();
  zip.file('manifest.json', '{}');
  zip.file(ENCRYPTED_SECRETS_ENTRY, 'not-a-dsbk-container-at-all');
  const archivePath = join(host.app.dataDir, 'corrupted.zip');
  writeFileSync(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const target = join(host.app.dataDir, 'corrupted-target');
  await expect(importBackupFromZip(host.ctx, archivePath, target, {
    password: TEST_PASSWORD, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  expect(existsSync(target)).toBe(false);
});

it('import_portable_zip_with_explicit_password_fails_before_touching_target', async () => {
  const { host } = await setup();
  const portable = await exportPlain(host, 'touch-plain');
  const target = join(host.app.dataDir, 'touch-plain-target');
  await expect(importBackupFromZip(host.ctx, portable.zipPath, target, {
    password: TEST_PASSWORD, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow('不是加密全保真备份');
  expect(existsSync(target)).toBe(false);
});

it('import_sealed_zip_with_wrong_password_fails_before_touching_target', async () => {
  const { host } = await setup();
  const sealed = await exportSealed(host, 'touch-sealed');
  const target = join(host.app.dataDir, 'touch-sealed-target');
  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'definitely-wrong-password', skipExisting: false,
    onProgress: () => undefined, isCancelled: () => false,
  }).then(() => null, (caught: unknown) => caught as Error);
  expect(error).not.toBeNull();
  expect(error!.message).toContain(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  // Rust portable_precheck.rs:463-467：同一错误同时带解封层文案。
  expect(error!.message).toContain('解封加密备份失败');
  expect(existsSync(target)).toBe(false);
});

it('progress_import_sealed_zip_wrong_password_never_reaches_extract_phase', async () => {
  const { host } = await setup();
  const sealed = await exportSealed(host, 'progress-wrong');
  const target = join(host.app.dataDir, 'progress-wrong-target');
  const phases: string[] = [];
  await expect(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'definitely-wrong-password', skipExisting: false,
    onProgress: progress => phases.push(progress.phase), isCancelled: () => false,
  })).rejects.toThrow(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  expect(phases).not.toContain('extract');
  expect(existsSync(target)).toBe(false);
});
