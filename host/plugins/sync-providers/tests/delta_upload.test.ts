import './local-fs-fixture.ts';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import {
  BACKUP_V2_CONFIG_KEY,
  BACKUP_V2_INDEX_FORMAT,
  BACKUP_V2_MANIFESTS_PREFIX,
  BACKUP_V2_OBJECTS_PREFIX,
  BACKUP_V2_SNAPSHOTS_PREFIX,
  BackupV2DeviceIndex,
  deviceIndexKey,
  publishVerifiedStaging,
  type DeltaInventory,
  type DeltaInventoryProvider,
} from '../src/delta_upload.ts';
import { decodeSnapshotDescriptor } from '../src/delta_format.ts';
import { MemoryStorage } from './memory_storage.ts';

const backup = createBackupCrypto();
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function stagingDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'delta-upload-test-'));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** Test double for L21's `build_inventory_cross_checked` (disk hashes win). */
const provider: DeltaInventoryProvider = {
  async buildCrossChecked(root: string): Promise<DeltaInventory> {
    const entries: { logicalPath: string; size: number; plaintextSha256: string }[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const logicalPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full, logicalPath);
        } else if (entry.isFile()) {
          const data = await readFile(full);
          entries.push({
            logicalPath,
            size: data.byteLength,
            plaintextSha256: createHash('sha256').update(data).digest('hex'),
          });
        }
      }
    }
    await walk(root, '');
    entries.sort((left, right) => Buffer.compare(
      Buffer.from(left.logicalPath, 'utf8'),
      Buffer.from(right.logicalPath, 'utf8'),
    ));
    return { entries, logicalSize: entries.reduce((sum, entry) => sum + entry.size, 0) };
  },
};

describe('delta_upload.rs', () => {
  it('publishes a first snapshot and commits the per-device index last', async () => {
    const root = await stagingDir({ 'manifest.json': '{"v":1}', 'db/chat.db': 'chat-data' });
    const storage = new MemoryStorage();
    const result = await publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider);

    expect(result.logicalSize).toBe(16);
    expect(result.uploadedFileCount).toBe(2);
    expect(result.reusedFileCount).toBe(0);
    expect(result.snapshotKey.startsWith(`${BACKUP_V2_SNAPSHOTS_PREFIX}device-1/`)).toBe(true);
    expect(storage.files.has(BACKUP_V2_CONFIG_KEY)).toBe(true);
    expect(storage.files.size).toBe(5); // config + 2 objects + snapshot + index + lease released

    const index = BackupV2DeviceIndex.decode((await storage.get(deviceIndexKey('device-1')))!);
    expect(index.format).toBe(BACKUP_V2_INDEX_FORMAT);
    expect(index.latest).toBe(result.versionId);
    expect(index.versions).toHaveLength(1);
    expect(index.versions[0]!.snapshotKey).toBe(result.snapshotKey);
    expect(index.versions[0]!.logicalSize).toBe(16);
    expect(index.versions[0]!.newlyUploadedSize).toBe(16);

    const descriptor = decodeSnapshotDescriptor((await storage.get(result.snapshotKey))!);
    expect(descriptor.versionId).toBe(result.versionId);
    expect(descriptor.files.map(file => file.logicalPath)).toEqual(['db/chat.db', 'manifest.json']);
    expect(descriptor.logicalSize).toBe(16);
    for (const file of descriptor.files) {
      expect(file.objectKey.startsWith(`${BACKUP_V2_OBJECTS_PREFIX}device-1/`)).toBe(true);
    }
  });

  it('reuses unchanged objects and always re-uploads manifest.json', async () => {
    const root = await stagingDir({ 'manifest.json': '{"v":1}', 'db/a.bin': 'same', 'db/b.bin': 'old' });
    const storage = new MemoryStorage();
    const first = await publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider);
    const firstDescriptor = decodeSnapshotDescriptor((await storage.get(first.snapshotKey))!);
    const sameRef = firstDescriptor.files.find(file => file.logicalPath === 'db/a.bin')!;

    await writeFile(join(root, 'manifest.json'), '{"v":2}');
    await writeFile(join(root, 'db/b.bin'), 'new');
    const second = await publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider);
    expect(second.reusedFileCount).toBe(1);
    expect(second.uploadedFileCount).toBe(2);
    expect(second.reusedSize).toBe(4);

    const secondDescriptor = decodeSnapshotDescriptor((await storage.get(second.snapshotKey))!);
    const reused = secondDescriptor.files.find(file => file.logicalPath === 'db/a.bin')!;
    expect(reused.objectKey).toBe(sameRef.objectKey);
    expect(secondDescriptor.files.find(file => file.logicalPath === 'db/b.bin')!.objectKey)
      .not.toBe(firstDescriptor.files.find(file => file.logicalPath === 'db/b.bin')!.objectKey);

    const index = BackupV2DeviceIndex.decode((await storage.get(deviceIndexKey('device-1')))!);
    expect(index.versions).toHaveLength(2);
    expect(index.latest).toBe(second.versionId);
  });

  it('encrypts objects, config and descriptor with one session', async () => {
    const root = await stagingDir({ 'manifest.json': '{"v":1}', 'db/a.bin': 'secret' });
    const storage = new MemoryStorage();
    const session = await backup.createFileCipherSession('delta-upload-pw', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      const result = await publishVerifiedStaging(
        storage, root, { deviceId: 'device-1', cipher: session }, provider,
      );
      const config = (await storage.get(BACKUP_V2_CONFIG_KEY))!;
      expect(Buffer.from(config.subarray(0, 4)).toString('latin1')).toBe('DSBK');
      const snapshot = (await storage.get(result.snapshotKey))!;
      expect(Buffer.from(snapshot.subarray(0, 4)).toString('latin1')).toBe('DSBK');
      const plaintext = await session.decryptBytes(snapshot);
      expect(decodeSnapshotDescriptor(plaintext).versionId).toBe(result.versionId);
      for (const key of storage.files.keys()) {
        if (key.startsWith(BACKUP_V2_OBJECTS_PREFIX)) {
          const data = (await storage.get(key))!;
          expect(Buffer.from(data.subarray(0, 4)).toString('latin1')).toBe('DSBK');
        }
      }
    } finally {
      session.dispose();
    }
  });

  it('fails closed when the L21 inventory provider is not published', async () => {
    const root = await stagingDir({ 'manifest.json': '{}' });
    const storage = new MemoryStorage();
    await expect(publishVerifiedStaging(storage, root, { deviceId: 'device-1' }))
      .rejects.toThrow(/delta_inventory/);
    expect(storage.files.size).toBe(0);
  });

  it('fails closed on a corrupt existing index before writing any object', async () => {
    const root = await stagingDir({ 'manifest.json': '{}' });
    const storage = new MemoryStorage();
    storage.putAt(deviceIndexKey('device-1'), Buffer.from('{broken'), Date.now());
    await expect(publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider))
      .rejects.toThrow(/备份索引解析失败/);
    expect([...storage.files.keys()].some(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))).toBe(false);
  });
});
