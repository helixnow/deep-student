import './local-fs-fixture.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { CloudSyncManager } from '../src/sync_manager.ts';
import { MemoryStorage } from './memory_storage.ts';
import { createNativeBackupHost, type NativeBackupHost } from './native_backup_host.ts';

let fixture: NativeBackupHost | undefined;
let backup: BackupCrypto;
const tempDirs: string[] = [];

beforeAll(async () => {
  fixture = await createNativeBackupHost();
  backup = fixture.backup;
});

afterAll(async () => {
  await fixture?.host.dispose();
});

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sync-r07-e2ee-'));
  tempDirs.push(dir);
  return dir;
}

function snapshot(storage: MemoryStorage): Map<string, Buffer> {
  return new Map([...storage.files.entries()].map(([key, entry]) => [key, Buffer.from(entry.data)]));
}

function keysWithPrefix(storage: MemoryStorage, prefix: string): string[] {
  return storage.keys().filter(key => key.startsWith(prefix));
}

function zipManager(storage: MemoryStorage, deviceId: string): CloudSyncManager {
  return new CloudSyncManager(storage, deviceId, { backup });
}

describe('sync_r07_e2ee_wrong_password_tests.rs (ZIP path)', () => {
  it('r07_zip_wrong_password_rejection_leaves_root_clean_and_recoverable', async () => {
    const storage = new MemoryStorage();
    const deviceA = zipManager(storage, 'device-a');
    await deviceA.enforceEncryptionPolicyBeforeUploadWithPassword('r07-correct-pw');
    const markerSnapshot = snapshot(storage);

    const deviceB = zipManager(storage, 'device-b');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(deviceB.enforceEncryptionPolicyBeforeUploadWithPassword('r07-wrong-pw'))
        .rejects.toThrow(/不一致/);
    }
    expect(snapshot(storage)).toEqual(markerSnapshot);
    expect(keysWithPrefix(storage, 'backups/')).toEqual([]);

    await deviceA.enforceEncryptionPolicyBeforeUploadWithPassword('r07-correct-pw');
    const dir = await tempDir();
    const zip = join(dir, 'backup.dsbk');
    await writeFile(zip, 'DSBK pretend-encrypted payload r07');
    const result = await deviceA.upload(zip, 'r07-test', null);
    expect(result.version.deviceId).toBe('device-a');
    expect(keysWithPrefix(storage, 'backups/')).toHaveLength(1);
  });

  it('r07_zip_near_miss_password_variants_all_rejected', async () => {
    const storage = new MemoryStorage();
    const correct = 'caf\u00e9-R07-pw';
    const deviceA = zipManager(storage, 'device-a');
    await deviceA.enforceEncryptionPolicyBeforeUploadWithPassword(correct);
    const markerSnapshot = snapshot(storage);

    const nearMisses: Array<[string, string]> = [
      ['NFD 分解形式', 'cafe\u0301-R07-pw'],
      ['大小写差异', correct.toLowerCase()],
      ['尾部空格', `${correct} `],
      ['头部空格', ` ${correct}`],
      ['零宽空格后缀', `${correct}\u200b`],
    ];
    const deviceB = zipManager(storage, 'device-b');
    for (const [label, candidate] of nearMisses) {
      expect(candidate, label).not.toBe(correct);
      await expect(deviceB.enforceEncryptionPolicyBeforeUploadWithPassword(candidate), label)
        .rejects.toThrow(/不一致/);
    }

    await expect(deviceB.enforceEncryptionPolicyBeforeUploadWithPassword(null))
      .rejects.toThrow(/加密/);

    expect(snapshot(storage)).toEqual(markerSnapshot);
    await deviceA.enforceEncryptionPolicyBeforeUploadWithPassword(correct);
  });
});
