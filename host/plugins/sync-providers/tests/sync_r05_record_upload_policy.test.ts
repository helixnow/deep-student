import { describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { deviceIdShortHash } from '../src/device_id.ts';
import { CloudSyncManager } from '../src/sync_manager.ts';
import { MemoryStorage } from './memory_storage.ts';

const backup = createBackupCrypto();

function managerOn(storage: MemoryStorage, deviceId: string): CloudSyncManager {
  return new CloudSyncManager(storage, deviceId, { backup });
}

describe('sync_r05_regression_tests.rs (record upload policy)', () => {
  it('r05_record_upload_with_marker_but_no_password_is_rejected', async () => {
    const storage = new MemoryStorage();
    const deviceA = managerOn(storage, 'device-a');
    await deviceA.enforceEncryptionPolicyBeforeUpload(true);
    const marker = await deviceA.readEncryptionMarker();
    expect(marker).not.toBeNull();
    expect(marker!.createdByDevice).toBe(deviceIdShortHash('device-a'));

    const deviceB = managerOn(storage, 'device-b');
    await expect(deviceB.enforceEncryptionPolicyBeforeUpload(false))
      .rejects.toThrow(/已存在端到端加密备份/);
    await expect(deviceB.enforceEncryptionPolicyBeforeUpload(false))
      .rejects.toThrow(/加密密码/);

    const markerAfter = await deviceB.readEncryptionMarker();
    expect(markerAfter).not.toBeNull();
    expect(markerAfter!.createdByDevice).toBe(deviceIdShortHash('device-a'));
  });

  it('r05_record_upload_without_marker_and_no_password_is_allowed', async () => {
    const storage = new MemoryStorage();
    const manager = managerOn(storage, 'device-plain');
    await manager.enforceEncryptionPolicyBeforeUpload(false);
    expect(await manager.readEncryptionMarker()).toBeNull();
  });

  it('r05_corrupted_marker_still_blocks_plaintext_record_upload', async () => {
    const storage = new MemoryStorage();
    await storage.put('.encryption-marker', Buffer.from('definitely-not-json'));

    const manager = managerOn(storage, 'device-b');
    await expect(manager.enforceEncryptionPolicyBeforeUpload(false))
      .rejects.toThrow(/加密/);
  });
});
