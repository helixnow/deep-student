import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: 直接构造 L23 传输类的用例不经过插件入口，需自行装上桌面本地文件端口
import '../../sync-providers/tests/local-fs-fixture.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L23 已接入真实云同步命令的 manager 行为
import { CloudSyncManager } from '../../sync-providers/src/sync_manager.ts';
// boundary-allow cross-plugin-impl: L23 错误码用于断言拒绝分类
import { SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE } from '../../sync-providers/src/mod.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r12_neutral_names.rs` 与 `sync_r10_verifier.rs` 中尚未覆盖的 manager 行为。
 *
 * 直接调用 L23 生产 `CloudSyncManager`，用内存 `CloudStorage` 验证新旧清单混布、
 * 裁剪/删除，以及加密标记被删后 bool 明文入口仍然 fail-closed。
 */
const backup = createBackupCrypto();
const dirs: string[] = [];
const LEGACY_VERSION_ID = '20260115-120000-123-device-abcd1234';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `l22-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function manager(storage: MemoryCloud, deviceId: string, maxVersions?: number): CloudSyncManager {
  return new CloudSyncManager(storage, deviceId, {
    backup,
    encryptionMemoryPath: null,
    ...(maxVersions === undefined ? {} : { maxVersions }),
  });
}

function seedLegacyBackup(
  storage: MemoryCloud,
  deviceId: string,
  versionId: string,
  payload: Uint8Array,
): void {
  storage.insertRaw(`backups/${versionId}.zip`, payload);
  storage.insertRaw(`manifests/${deviceId}.json`, JSON.stringify({
    version: 1,
    latest: versionId,
    updatedAt: '2026-01-15T12:00:00Z',
    versions: [{
      id: versionId,
      timestamp: '2026-01-15T12:00:00Z',
      size: payload.byteLength,
      checksum: sha256(payload),
      deviceId,
    }],
  }));
}

async function uploadZip(managerInstance: CloudSyncManager, payload: Uint8Array): Promise<string> {
  const zipPath = join(tempDir('upload'), 'backup.zip');
  writeFileSync(zipPath, payload);
  const result = await managerInstance.upload(zipPath, '1.2.3', null);
  return result.version.id;
}

it('mixed_directory_upload_download_prune_and_delete', async () => {
  const storage = new MemoryCloud('memory-neutral-names');
  seedLegacyBackup(storage, 'device-a', LEGACY_VERSION_ID, Buffer.from('keep-or-drop'));

  const writer = manager(storage, 'device-a', 10);
  const newId = await uploadZip(writer, Buffer.from('newer-neutral'));
  expect(newId).toHaveLength(22);
  expect(newId).toMatch(/^[0-9a-f]+$/);
  expect(newId).not.toContain('-');
  expect(newId).not.toContain('device');

  const listed = await writer.listVersions();
  const ids = listed.map(version => version.id);
  expect(ids).toContain(LEGACY_VERSION_ID);
  expect(ids).toContain(newId);

  const downloadDir = tempDir('download');
  const old = await writer.download(LEGACY_VERSION_ID, downloadDir);
  const current = await writer.download(newId, downloadDir);
  expect(new Uint8Array(readFileSync(old.localPath))).toEqual(new Uint8Array(Buffer.from('keep-or-drop')));
  expect(new Uint8Array(readFileSync(current.localPath))).toEqual(new Uint8Array(Buffer.from('newer-neutral')));

  await writer.deleteVersion(LEGACY_VERSION_ID);
  const afterDelete = await writer.listVersions();
  expect(afterDelete.map(version => version.id)).toEqual([newId]);
  expect(storage.bytes(`backups/${LEGACY_VERSION_ID}.zip`)).toBeNull();

  const pruner = manager(storage, 'device-a', 1);
  seedLegacyBackup(storage, 'device-a', LEGACY_VERSION_ID, Buffer.from('prune-me'));
  const kept = await uploadZip(pruner, Buffer.from('surviving-neutral'));
  const remaining = (await pruner.listVersions()).map(version => version.id);
  expect(remaining).toEqual([kept]);
  expect(storage.bytes(`backups/${LEGACY_VERSION_ID}.zip`)).toBeNull();
  expect(storage.bytes(`backups/${kept}.zip`)).not.toBeNull();
});

it('deleted_marker_bool_policy_entry_also_rejected', async () => {
  const storage = new MemoryCloud('memory-bool-entry');
  const memoryPath = join(tempDir('memory'), 'roots.json');
  const encrypted = new CloudSyncManager(storage, 'device-a', {
    backup,
    encryptionMemoryPath: memoryPath,
  });

  await encrypted.enforceEncryptionPolicyBeforeUpload(true);
  storage.removeRaw('.encryption-marker');

  const plaintext = new CloudSyncManager(storage, 'device-a', {
    backup,
    encryptionMemoryPath: memoryPath,
  });
  const error = await plaintext.enforceEncryptionPolicyBeforeUpload(false)
    .then(() => null, (cause: unknown) => cause as Error);
  expect(error).not.toBeNull();
  expect(error!.message).toContain(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE);
});
