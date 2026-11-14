// boundary-allow cross-plugin-impl: reuse sync-providers local-fs test fixture
import '../../sync-providers/tests/local-fs-fixture.ts';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import {
  deviceIdShortHash,
  runRepoCheck,
  type RepoCheckProblemKind,
} from '../../sync-providers/api.ts';
import { FlakyResumableCloud, MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r11_repo_check.rs` 的 TS 行为级移植：云端仓库只读巡检。
 *
 * 直接调用 L23 发布的生产实现 `runRepoCheck`，用内存云存储构造真实
 * manifest / DSBK 产物；不复制巡检算法，也不替身被测函数。
 */
const backup = createBackupCrypto();

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ManifestVersion {
  id: string;
  checksum: string;
  size: number;
}

function manifestKey(deviceId: string): string {
  return `manifests/${deviceIdShortHash(deviceId)}.json`;
}

function putObject(storage: MemoryCloud, id: string, data: Uint8Array): string {
  const checksum = sha256(data);
  storage.putAt(`backups/${id}.zip`, data);
  return checksum;
}

function writeManifest(storage: MemoryCloud, deviceId: string, versions: ManifestVersion[]): void {
  const timestamp = new Date().toISOString();
  storage.insertRaw(manifestKey(deviceId), JSON.stringify({
    version: 1,
    latest: versions[0]?.id ?? null,
    updatedAt: timestamp,
    versions: versions.map(version => ({
      id: version.id,
      timestamp,
      size: version.size,
      checksum: version.checksum,
      deviceId,
    })),
  }));
}

function kinds(report: Awaited<ReturnType<typeof runRepoCheck>>): RepoCheckProblemKind[] {
  return report.problems.map(problem => problem.kind);
}

async function dsbkObject(plaintext: Uint8Array): Promise<Uint8Array> {
  const session = await backup.createFileCipherSession('repo-check-pw', { mCost: 8, tCost: 1, pCost: 1 });
  try {
    return await session.encryptBytes(plaintext);
  } finally {
    session.dispose();
  }
}

function encryptionMarker(): string {
  return JSON.stringify({
    version: 2,
    createdByDevice: deviceIdShortHash('device-a'),
    createdAt: new Date().toISOString(),
    keyVerifier: { kdf: 'argon2id', mCost: 65536, tCost: 3, pCost: 4, salt: '00'.repeat(16), digest: '00'.repeat(32) },
  });
}

it('healthy_plaintext_repo_reports_all_green', async () => {
  const storage = new MemoryCloud();
  const first = putObject(storage, 'version-one', Buffer.from('PK\u0003\u0004 plain zip payload one'));
  const second = putObject(storage, 'version-two', Buffer.from('PK\u0003\u0004 plain zip payload two'));
  writeManifest(storage, 'device-a', [
    { id: 'version-one', checksum: first, size: 29 },
    { id: 'version-two', checksum: second, size: 29 },
  ]);

  const report = await runRepoCheck(storage);

  expect(report.status, JSON.stringify(report.problems)).toBe('ok');
  expect(report.problems).toEqual([]);
  expect(report.listingTruncated).toBe(false);
  expect(report.encryptionMarkerPresent).toBe(false);
  expect(report.versionsReferenced).toBe(2);
  expect(report.objectsChecked).toBe(2);
  expect(report.orphanObjects).toBe(0);
  expect(report.bytesVerified).toBeGreaterThan(0);
});

it('healthy_encrypted_repo_reports_all_green', async () => {
  const storage = new MemoryCloud();
  storage.insertRaw('.encryption-marker', encryptionMarker());
  const object = await dsbkObject(Buffer.alloc(1024, 0x5a));
  const checksum = putObject(storage, 'encrypted-version', object);
  writeManifest(storage, 'device-a', [
    { id: 'encrypted-version', checksum, size: object.byteLength },
  ]);

  const report = await runRepoCheck(storage);

  expect(report.status, JSON.stringify(report.problems)).toBe('ok');
  expect(kinds(report)).not.toContain('undecodableDsbkHeader');
  expect(report.problems).toEqual([]);
  expect(report.encryptionMarkerPresent).toBe(true);
  expect(report.versionsReferenced).toBe(1);
  expect(report.objectsChecked).toBe(1);
});

it('missing_object_is_reported_with_version_id', async () => {
  const storage = new MemoryCloud();
  const keep = putObject(storage, 'version-keep', Buffer.from('PK\u0003\u0004 healthy'));
  const lost = putObject(storage, 'version-lost', Buffer.from('PK\u0003\u0004 will vanish'));
  writeManifest(storage, 'device-a', [
    { id: 'version-keep', checksum: keep, size: 14 },
    { id: 'version-lost', checksum: lost, size: 19 },
  ]);
  storage.removeRaw('backups/version-lost.zip');

  const report = await runRepoCheck(storage);

  expect(report.status).toBe('problemsFound');
  const missing = report.problems.filter(problem => problem.kind === 'missingObject');
  expect(missing).toHaveLength(1);
  expect(missing[0]?.versionId).toBe('version-lost');
  expect(missing[0]?.objectKey).toBe('backups/version-lost.zip');
  expect(report.objectsChecked).toBe(1);
  expect(report.problems.every(problem => problem.versionId !== 'version-keep')).toBe(true);
});

it('corrupted_ciphertext_reports_checksum_and_header_problems', async () => {
  const storage = new MemoryCloud();
  storage.insertRaw('.encryption-marker', encryptionMarker());
  const object = await dsbkObject(Buffer.alloc(1024, 0x11));
  const checksum = putObject(storage, 'encrypted-corrupt', object);
  writeManifest(storage, 'device-a', [
    { id: 'encrypted-corrupt', checksum, size: object.byteLength },
  ]);
  storage.insertRaw('backups/encrypted-corrupt.zip', 'DSBK\u0009 corrupted');

  const report = await runRepoCheck(storage);

  expect(report.status).toBe('problemsFound');
  const found = kinds(report);
  expect(found).toContain('checksumMismatch');
  expect(found).toContain('undecodableDsbkHeader');
});

it('plaintext_object_in_encrypted_repo_is_reported', async () => {
  const storage = new MemoryCloud();
  storage.insertRaw('.encryption-marker', encryptionMarker());
  const object = await dsbkObject(Buffer.alloc(512, 0x22));
  const checksum = putObject(storage, 'encrypted-plaintext', object);
  writeManifest(storage, 'device-a', [
    { id: 'encrypted-plaintext', checksum, size: object.byteLength },
  ]);
  storage.insertRaw('backups/encrypted-plaintext.zip', 'PK\u0003\u0004 plaintext leaked into encrypted repo');

  const report = await runRepoCheck(storage);

  expect(report.status).toBe('problemsFound');
  expect(kinds(report)).toContain('plaintextInEncryptedRepo');
});

it('orphan_object_is_reported_and_check_stays_read_only', async () => {
  const storage = new MemoryCloud();
  const checksum = putObject(storage, 'version-referenced', Buffer.from('PK\u0003\u0004 referenced'));
  writeManifest(storage, 'device-a', [
    { id: 'version-referenced', checksum, size: 17 },
  ]);
  storage.insertRaw('backups/20990101-000000-000-zzzzzz-orphan01.zip', 'orphaned bytes');
  storage.insertRaw('manifests/device-a.json.deadbeef.tmp', '{"leftover":true}');

  const before = storage.snapshot();
  const report = await runRepoCheck(storage);
  const after = storage.snapshot();

  expect(report.status).toBe('problemsFound');
  expect(report.orphanObjects).toBe(1);
  const found = kinds(report);
  expect(found).toContain('orphanObject');
  expect(found).toContain('tempLeftover');
  const orphan = report.problems.find(problem => problem.kind === 'orphanObject');
  expect(orphan?.objectKey).toBe('backups/20990101-000000-000-zzzzzz-orphan01.zip');
  expect(after).toEqual(before);
});

it('corrupt_manifest_is_reported_without_aborting_check', async () => {
  const storage = new MemoryCloud();
  const checksum = putObject(storage, 'version-healthy', Buffer.from('PK\u0003\u0004 healthy'));
  writeManifest(storage, 'device-a', [
    { id: 'version-healthy', checksum, size: 14 },
  ]);
  storage.insertRaw('manifests/rogue-device.json', 'not-json at all');

  const report = await runRepoCheck(storage);

  expect(report.status).toBe('problemsFound');
  expect(kinds(report)).toContain('corruptManifest');
  expect(report.objectsChecked).toBe(1);
});

it('truncated_listing_never_reports_all_green', async () => {
  const storage = new MemoryCloud();
  const checksum = putObject(storage, 'version-healthy', Buffer.from('PK\u0003\u0004 healthy payload'));
  writeManifest(storage, 'device-a', [
    { id: 'version-healthy', checksum, size: 22 },
  ]);
  storage.truncatedPrefixes.add('manifests/');
  storage.truncatedPrefixes.add('backups/');

  const report = await runRepoCheck(storage);

  expect(report.status).not.toBe('ok');
  expect(report.status).toBe('incomplete');
  expect(report.listingTruncated).toBe(true);
  expect(report.objectsChecked).toBe(1);
  expect(report.problems).toEqual([]);
});

it('truncated_manifests_listing_suppresses_orphan_false_positives', async () => {
  const storage = new MemoryCloud();
  const checksum = putObject(storage, 'version-healthy', Buffer.from('PK\u0003\u0004 healthy payload'));
  writeManifest(storage, 'device-a', [
    { id: 'version-healthy', checksum, size: 22 },
  ]);
  storage.insertRaw('backups/20990101-000000-000-zzzzzz-orphan01.zip', 'bytes');
  storage.truncatedPrefixes.add('manifests/');

  const report = await runRepoCheck(storage);

  expect(report.status).toBe('incomplete');
  expect(report.orphanObjects).toBe(0);
  expect(kinds(report)).not.toContain('orphanObject');
});

it('resumable_provider_retries_from_partial_and_reports_green', async () => {
  const storage = new FlakyResumableCloud(8, 1);
  const payload = Buffer.from('PK\u0003\u0004 resumable repo-check payload');
  const checksum = putObject(storage, 'version-resumable', payload);
  writeManifest(storage, 'device-a', [
    { id: 'version-resumable', checksum, size: payload.byteLength },
  ]);

  const report = await runRepoCheck(storage);

  expect(report.status, JSON.stringify(report.problems)).toBe('ok');
  expect(report.objectsChecked).toBe(1);
  expect(storage.resumeStarts).toEqual([0, 8]);
});

it('exhausted_resumable_retries_stay_incomplete', async () => {
  const storage = new FlakyResumableCloud(4, 10);
  const payload = Buffer.from('PK\u0003\u0004 never finishes');
  const checksum = putObject(storage, 'version-never', payload);
  writeManifest(storage, 'device-a', [
    { id: 'version-never', checksum, size: payload.byteLength },
  ]);

  const report = await runRepoCheck(storage);

  expect(report.status).toBe('incomplete');
  expect(kinds(report)).toContain('objectReadFailed');
  expect(report.status).not.toBe('ok');
  expect(storage.resumeStarts).toEqual([0, 4, 8]);
});
