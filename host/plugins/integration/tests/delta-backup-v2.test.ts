import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: 直接构造 L23 传输类的用例不经过插件入口，需自行装上桌面本地文件端口
import '../../sync-providers/tests/local-fs-fixture.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import {
  BACKUP_V2_CONFIG_KEY,
  BACKUP_V2_GC_CANDIDATES_PREFIX,
  BACKUP_V2_MANIFESTS_PREFIX,
  BACKUP_V2_OBJECTS_PREFIX,
  BACKUP_V2_SNAPSHOTS_PREFIX,
  DEFAULT_GC_GRACE_MS,
  DELTA_FORMAT_VERSION,
  GC_CANDIDATE_FORMAT,
  GC_CANDIDATE_FORMAT_VERSION,
  BackupV2DeviceIndex,
  GcCandidateV2,
  MAX_SNAPSHOT_FILES,
  SNAPSHOT_V2_FORMAT,
  acquireBackupRepoLease,
  collectGcCandidates,
  decodeSnapshotDescriptor,
  deviceIndexKey,
  encodeSnapshotDescriptor,
  publishVerifiedStaging,
  restoreSnapshotToStaging,
  sweepGcCandidates,
  type DeltaInventory,
  type DeltaInventoryProvider,
  type SnapshotDescriptorV2,
  type SnapshotFileRefV2,
} from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: L23 time.ts 的 chrono to_rfc3339()（+00:00）是 GC candidate firstSeen 的生产编码器
import { chronoAutoSiUtc as formatChronoRfc3339 } from '../../sync-providers/src/time.ts';
// boundary-allow cross-plugin-impl: L23 的内存 CloudStorage 是双方共用的测试夹具
import { MemoryStorage } from '../../sync-providers/tests/memory_storage.ts';

const backup = createBackupCrypto();
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix = 'delta-v2-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function stagingDir(files: Record<string, string>): Promise<string> {
  const dir = await tempDir('delta-v2-src-');
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

function stagingFiles(version: number): Record<string, string> {
  return {
    'manifest.json': `{"version":${version}}`,
    'db/chat_v2.db': `db-bytes-${version}`,
    'assets/image.bin': 'asset-bytes',
    'crypto/e2ee.bin': 'crypto-bytes',
  };
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

function objectKeyOf(descriptor: SnapshotDescriptorV2, logicalPath: string): string {
  const file = descriptor.files.find(candidate => candidate.logicalPath === logicalPath);
  if (file === undefined) throw new Error(`descriptor 缺少 ${logicalPath}`);
  return file.objectKey;
}

async function descriptorOf(storage: MemoryStorage, snapshotKey: string): Promise<SnapshotDescriptorV2> {
  const bytes = await storage.get(snapshotKey);
  if (bytes === null) throw new Error(`缺少 snapshot ${snapshotKey}`);
  return decodeSnapshotDescriptor(bytes);
}

async function expectTreeEquals(source: string, dest: string): Promise<void> {
  const expected: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const logicalPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, logicalPath);
      else if (entry.isFile()) expected[logicalPath] = (await readFile(full)).toString('base64');
    }
  }
  await walk(source, '');
  const actual: Record<string, string> = {};
  async function walkDest(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const logicalPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walkDest(full, logicalPath);
      else if (entry.isFile()) actual[logicalPath] = (await readFile(full)).toString('base64');
    }
  }
  await walkDest(dest, '');
  expect(actual).toEqual(expected);
}

function storageSnapshot(storage: MemoryStorage): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, entry] of [...storage.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    snapshot[key] = Buffer.from(entry.data).toString('hex');
  }
  return snapshot;
}

function storageKeys(storage: MemoryStorage): string[] {
  return [...storage.files.keys()].sort();
}

async function expectDestEmpty(path: string): Promise<void> {
  const entries = await readdir(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  expect(entries).toEqual([]);
}

async function candidateKeys(storage: MemoryStorage): Promise<string[]> {
  return [...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_GC_CANDIDATES_PREFIX));
}

class FailingPutStorage extends MemoryStorage {
  private readonly failPrefix: string;

  constructor(failPrefix: string) {
    super();
    this.failPrefix = failPrefix;
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    if (key.startsWith(this.failPrefix)) throw new Error(`injected PUT failure: ${key}`);
    await super.put(key, data);
  }
}

function fileRef(path: string): SnapshotFileRefV2 {
  return {
    logicalPath: path,
    size: 1,
    plaintextSha256: 'a'.repeat(64),
    objectKey: `backup-v2/objects/device-1/${path.replaceAll('/', '-')}.dsbk`,
    objectCipherSha256: 'b'.repeat(64),
  };
}

describe('sync_r12_delta_format.rs', () => {
  it('r12_file_count_over_limit_is_rejected', () => {
    const files: SnapshotFileRefV2[] = [];
    for (let index = 0; index <= MAX_SNAPSHOT_FILES; index += 1) files.push(fileRef(`f/${index}.bin`));
    const over: SnapshotDescriptorV2 = {
      format: SNAPSHOT_V2_FORMAT,
      formatVersion: DELTA_FORMAT_VERSION,
      versionId: '20260824-140000-000-abc123-deadbeef',
      deviceId: 'device-1',
      createdAt: '2026-08-24T14:00:00+00:00',
      files,
      logicalSize: MAX_SNAPSHOT_FILES + 1,
    };
    expect(over.files).toHaveLength(MAX_SNAPSHOT_FILES + 1);
    expect(() => encodeSnapshotDescriptor(over)).toThrow(String(MAX_SNAPSHOT_FILES));

    // 恰好等于上限时合法（校验是 ≤，不是 <）。
    const atLimit: SnapshotDescriptorV2 = { ...over, files: files.slice(0, MAX_SNAPSHOT_FILES), logicalSize: MAX_SNAPSHOT_FILES };
    expect(() => encodeSnapshotDescriptor(atLimit)).not.toThrow();
  });
});

describe('sync_r12_delta_upload.rs', () => {
  it('r12_blank_device_id_fails_closed_with_zero_writes', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    await expect(publishVerifiedStaging(storage, root, { deviceId: '   ' }, provider))
      .rejects.toThrow(/设备 ID/);
    expect(storage.files.size).toBe(0);
  });

  it('r12_zero_change_second_version_reuses_all_data_objects', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const first = await publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider);
    const firstDescriptor = await descriptorOf(storage, first.snapshotKey);

    await writeFile(join(root, 'manifest.json'), '{"version":2}');
    const second = await publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider);

    expect(second.uploadedFileCount).toBe(1);
    expect(second.reusedFileCount).toBe(3);
    expect(second.reusedSize).toBeGreaterThan(0);
    expect(second.reusedSize + second.newlyUploadedSize).toBe(second.logicalSize);

    const secondDescriptor = await descriptorOf(storage, second.snapshotKey);
    for (const path of ['db/chat_v2.db', 'assets/image.bin', 'crypto/e2ee.bin']) {
      expect(objectKeyOf(secondDescriptor, path)).toBe(objectKeyOf(firstDescriptor, path));
    }
    expect(objectKeyOf(secondDescriptor, 'manifest.json'))
      .not.toBe(objectKeyOf(firstDescriptor, 'manifest.json'));
    expect(secondDescriptor.files).toHaveLength(4);
    const raw = Buffer.from((await storage.get(second.snapshotKey))!).toString('utf8');
    expect(raw).not.toContain('"parent"');

    expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))).toHaveLength(5);
    const index = BackupV2DeviceIndex.decode((await storage.get(deviceIndexKey('device-1')))!);
    expect(index.versions).toHaveLength(2);
    expect(index.latest).toBe(second.versionId);
  });

  it('r12_cross_device_never_reuses_other_devices_objects', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const a = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const b = await publishVerifiedStaging(storage, root, { deviceId: 'device-b' }, provider);

    expect(b.uploadedFileCount).toBe(4);
    expect(b.reusedFileCount).toBe(0);
    expect(b.newlyUploadedSize).toBe(b.logicalSize);

    const descriptorA = await descriptorOf(storage, a.snapshotKey);
    const descriptorB = await descriptorOf(storage, b.snapshotKey);
    const aKeys = new Set(descriptorA.files.map(file => file.objectKey));
    for (const file of descriptorB.files) {
      expect(file.objectKey.startsWith(`${BACKUP_V2_OBJECTS_PREFIX}device-b/`)).toBe(true);
      expect(aKeys.has(file.objectKey)).toBe(false);
    }
    expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))).toHaveLength(8);
  });

  it('r12_index_put_failure_leaves_orphans_but_no_new_version', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new FailingPutStorage(BACKUP_V2_MANIFESTS_PREFIX);
    await expect(publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider))
      .rejects.toThrow(/injected PUT failure/);

    expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))).toHaveLength(4);
    expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_SNAPSHOTS_PREFIX))).toHaveLength(1);
    expect(storage.files.has(deviceIndexKey('device-a'))).toBe(false);
  });

  it('r12_descriptor_put_failure_leaves_objects_but_no_new_version', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new FailingPutStorage(BACKUP_V2_SNAPSHOTS_PREFIX);
    await expect(publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider))
      .rejects.toThrow(/injected PUT failure/);

    expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))).toHaveLength(4);
    expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_SNAPSHOTS_PREFIX))).toHaveLength(0);
    expect(storage.files.has(deviceIndexKey('device-a'))).toBe(false);
  });

  it('r12_held_lease_blocks_publish_with_zero_object_writes', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const guard = await acquireBackupRepoLease(storage, 'other-device');
    try {
      const error = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider)
        .then(() => '', (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
      expect(error).toContain('E_BACKUP_LEASE_HELD');
      expect(error).not.toContain('E_SYNC_LEASE_HELD');
      expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))).toHaveLength(0);
      expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_SNAPSHOTS_PREFIX))).toHaveLength(0);
      expect([...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_MANIFESTS_PREFIX))).toHaveLength(0);
    } finally {
      await guard.release();
    }
  });
});

describe('sync_r12_delta_restore.rs', () => {
  it('r12_blank_device_id_or_unknown_version_fails_closed', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);

    const base = await tempDir();
    const blankDest = join(base, 'restored-blank');
    await expect(restoreSnapshotToStaging(storage, blankDest, { deviceId: '   ' }, provider))
      .rejects.toThrow(/设备 ID/);
    await expectDestEmpty(blankDest);

    const unknownDest = join(base, 'restored-unknown');
    await expect(restoreSnapshotToStaging(
      storage, unknownDest, { deviceId: 'device-a', versionId: 'no-such-version' }, provider,
    )).rejects.toThrow(/no-such-version/);
    await expectDestEmpty(unknownDest);

    const missingDest = join(base, 'restored-nodevice');
    await expect(restoreSnapshotToStaging(storage, missingDest, { deviceId: 'device-x' }, provider))
      .rejects.toThrow(/索引/);
    await expectDestEmpty(missingDest);
  });

  it('r12_reused_object_version_restores_correctly', async () => {
    const prevRoot = await stagingDir(stagingFiles(1));
    const currRoot = await stagingDir(stagingFiles(1));
    await writeFile(join(currRoot, 'manifest.json'), '{"version":2}');
    const storage = new MemoryStorage();
    const v1 = await publishVerifiedStaging(storage, prevRoot, { deviceId: 'device-a' }, provider);
    const v2 = await publishVerifiedStaging(storage, currRoot, { deviceId: 'device-a' }, provider);
    expect(v2.reusedFileCount).toBe(3);

    const base = await tempDir();
    const latestDest = join(base, 'restored-latest');
    const latest = await restoreSnapshotToStaging(storage, latestDest, { deviceId: 'device-a' }, provider);
    expect(latest.versionId).toBe(v2.versionId);
    await expectTreeEquals(currRoot, latestDest);

    const oldDest = join(base, 'restored-v1');
    const old = await restoreSnapshotToStaging(
      storage, oldDest, { deviceId: 'device-a', versionId: v1.versionId }, provider,
    );
    expect(old.versionId).toBe(v1.versionId);
    await expectTreeEquals(prevRoot, oldDest);

    const thirdRoot = await stagingDir(stagingFiles(3));
    const v3 = await publishVerifiedStaging(storage, thirdRoot, { deviceId: 'device-a' }, provider);
    expect(v3.reusedFileCount).toBe(2);
    const thirdDest = join(base, 'restored-v3');
    await restoreSnapshotToStaging(storage, thirdDest, { deviceId: 'device-a' }, provider);
    await expectTreeEquals(thirdRoot, thirdDest);
  });

  it('r12_e2ee_roundtrip_and_wrong_password_fails_closed', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const session = await backup.createFileCipherSession('test-password', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      const published = await publishVerifiedStaging(
        storage, root, { deviceId: 'device-a', cipher: session }, provider,
      );
      const base = await tempDir();
      const dest = join(base, 'restored');
      const result = await restoreSnapshotToStaging(
        storage, dest, { deviceId: 'device-a', cipher: session }, provider,
      );
      expect(result.versionId).toBe(published.versionId);
      await expectTreeEquals(root, dest);

      const wrong = await backup.createFileCipherSession('wrong-password', { mCost: 8, tCost: 1, pCost: 1 });
      try {
        const wrongDest = join(base, 'restored-wrong');
        await expect(restoreSnapshotToStaging(
          storage, wrongDest, { deviceId: 'device-a', cipher: wrong }, provider,
        )).rejects.toThrow(/fail-closed/);
        await expectDestEmpty(wrongDest);
      } finally {
        wrong.dispose();
      }

      const plainDest = join(base, 'restored-plain');
      await expect(restoreSnapshotToStaging(storage, plainDest, { deviceId: 'device-a' }, provider))
        .rejects.toThrow(/加密/);
      await expectDestEmpty(plainDest);
    } finally {
      session.dispose();
    }
  });

  it('r12_cipher_on_plaintext_repo_fails_closed', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);

    const session = await backup.createFileCipherSession('test-password', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      const dest = join(await tempDir(), 'restored');
      await expect(restoreSnapshotToStaging(
        storage, dest, { deviceId: 'device-a', cipher: session }, provider,
      )).rejects.toThrow(/不一致/);
      await expectDestEmpty(dest);
    } finally {
      session.dispose();
    }
  });

  it('r12_missing_object_fails_closed_with_empty_dest', async () => {
    const source = { ...stagingFiles(1), 'assets/image.bin': 'asset-to-missing' };
    const root = await stagingDir(source);
    const storage = new MemoryStorage();
    const published = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const descriptor = await descriptorOf(storage, published.snapshotKey);
    const missingKey = objectKeyOf(descriptor, 'assets/image.bin');
    await storage.delete(missingKey);

    const dest = join(await tempDir(), 'restored');
    const error = await restoreSnapshotToStaging(storage, dest, { deviceId: 'device-a' }, provider)
      .then(() => '', (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
    expect(error).toContain(published.versionId);
    expect(error).toContain(missingKey);
    expect(error).toContain('assets/image.bin');
    await expectDestEmpty(dest);
  });

  it('r12_corrupted_descriptor_or_index_fails_closed', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const published = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const indexKey = deviceIndexKey('device-a');
    const goodIndex = (await storage.get(indexKey))!;
    const goodDescriptor = (await storage.get(published.snapshotKey))!;
    const base = await tempDir();

    storage.putAt(indexKey, Buffer.from('{ definitely not a valid index'), Date.now());
    const badIndexDest = join(base, 'restored-badindex');
    await expect(restoreSnapshotToStaging(storage, badIndexDest, { deviceId: 'device-a' }, provider))
      .rejects.toThrow(/fail-closed/);
    await expectDestEmpty(badIndexDest);

    storage.putAt(indexKey, goodIndex, Date.now());
    storage.putAt(published.snapshotKey, Buffer.from('garbage-descriptor-bytes'), Date.now());
    const badDescDest = join(base, 'restored-baddesc');
    await expect(restoreSnapshotToStaging(storage, badDescDest, { deviceId: 'device-a' }, provider))
      .rejects.toThrow(/fail-closed/);
    await expectDestEmpty(badDescDest);

    storage.putAt(published.snapshotKey, goodDescriptor, Date.now());
    const repairedDest = join(base, 'restored-repaired');
    await restoreSnapshotToStaging(storage, repairedDest, { deviceId: 'device-a' }, provider);
    await expectTreeEquals(root, repairedDest);
  });

  it('r12_held_lease_blocks_restore_with_zero_storage_writes', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const guard = await acquireBackupRepoLease(storage, 'other-device');
    try {
      const before = storageSnapshot(storage);
      const dest = join(await tempDir(), 'restored');
      const error = await restoreSnapshotToStaging(storage, dest, { deviceId: 'device-a' }, provider)
        .then(() => '', (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
      expect(error).toContain('E_BACKUP_LEASE_HELD');
      expect(error).not.toContain('E_SYNC_LEASE_HELD');
      await expectDestEmpty(dest);
      expect(storageSnapshot(storage)).toEqual(before);
    } finally {
      await guard.release();
    }
  });

  it('r12_compatible_zip_failure_leaves_no_partial_zip', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const published = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const descriptor = await descriptorOf(storage, published.snapshotKey);
    const missingKey = objectKeyOf(descriptor, 'db/chat_v2.db');
    const original = (await storage.get(missingKey))!;
    await storage.delete(missingKey);

    const base = await tempDir();
    const midDest = join(base, 'restored-midfail');
    const midZip = join(base, 'midfail.zip');
    await expect(restoreSnapshotToStaging(
      storage, midDest, { deviceId: 'device-a', writeCompatibleZip: midZip }, provider,
    )).rejects.toThrow();
    expect(await stat(midZip).then(() => true, () => false)).toBe(false);
    await expectDestEmpty(midDest);
    await storage.put(missingKey, original);

    const existing = join(base, 'existing.zip');
    await writeFile(existing, 'pre-existing bytes');
    const clobberDest = join(base, 'restored-clobber');
    await expect(restoreSnapshotToStaging(
      storage, clobberDest, { deviceId: 'device-a', writeCompatibleZip: existing }, provider,
    )).rejects.toThrow(/已存在/);
    expect(await readFile(existing, 'utf8')).toBe('pre-existing bytes');
    await expectDestEmpty(clobberDest);

    const noParentDest = join(base, 'restored-noparent');
    const badTarget = join(base, 'no-such-dir', 'out.zip');
    await expect(restoreSnapshotToStaging(
      storage, noParentDest, { deviceId: 'device-a', writeCompatibleZip: badTarget }, provider,
    )).rejects.toThrow();
    expect(await stat(badTarget).then(() => true, () => false)).toBe(false);
    await expectDestEmpty(noParentDest);

    const leftovers = (await readdir(base)).filter(name => name.startsWith('.delta-restore-zip-'));
    expect(leftovers).toEqual([]);
  });
});

describe('sync_r12_delta_gc.rs', () => {
  it('r12_gc_keeps_shared_objects_and_reclaims_pruned_snapshot_after_grace', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const v1 = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    await writeFile(join(root, 'manifest.json'), '{"version":2}');
    const v2 = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);

    const indexKey = deviceIndexKey('device-a');
    const index = BackupV2DeviceIndex.decode((await storage.get(indexKey))!);
    const pruned = new BackupV2DeviceIndex({
      format: index.format,
      formatVersion: index.formatVersion,
      deviceId: index.deviceId,
      latest: v2.versionId,
      updatedAt: index.updatedAt,
      versions: index.versions.filter(entry => entry.id === v2.versionId),
    });
    storage.putAt(indexKey, pruned.encode(), Date.now());

    const v1Descriptor = await descriptorOf(storage, v1.snapshotKey);
    const v2Descriptor = await descriptorOf(storage, v2.snapshotKey);
    const sharedKeys = v2Descriptor.files
      .filter(file => v1Descriptor.files.some(old => old.objectKey === file.objectKey))
      .map(file => file.objectKey);
    expect(sharedKeys).toHaveLength(3);

    const t0 = Date.now();
    const collect = await collectGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(collect.newCandidateKeys).toHaveLength(2);
    expect(collect.retainedCandidates).toBe(0);
    expect(collect.unreferencedKeys).toContain(v1.snapshotKey);
    for (const key of sharedKeys) expect(collect.unreferencedKeys).not.toContain(key);

    const sweep = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(sweep.deletedObjectKeys).toHaveLength(2);
    expect(sweep.deletedObjectKeys).toContain(v1.snapshotKey);
    expect(sweep.droppedCandidateKeys).toEqual([]);
    expect(sweep.pendingCandidates).toBe(0);

    for (const file of v2Descriptor.files) expect(await storage.get(file.objectKey)).not.toBeNull();
    expect(await storage.get(v2.snapshotKey)).not.toBeNull();
    expect(await storage.get(BACKUP_V2_CONFIG_KEY)).not.toBeNull();
    expect(await storage.get(indexKey)).not.toBeNull();
    expect(await storage.get(v1.snapshotKey)).toBeNull();
    expect(await candidateKeys(storage)).toEqual([]);
  });

  it('r12_gc_orphan_needs_grace_and_first_seen_is_not_refreshed', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const orphanKey = `${BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000001.dsbk`;
    await storage.put(orphanKey, Buffer.from('orphan-bytes-from-failed-upload'));

    const t0 = 1_780_000_000_000;
    const collect = await collectGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(collect.newCandidateKeys).toHaveLength(1);
    expect(collect.unreferencedKeys).toEqual([orphanKey]);
    const keys = await candidateKeys(storage);
    expect(keys).toHaveLength(1);
    const body = GcCandidateV2.decode((await storage.get(keys[0]!))!);
    expect(body.format).toBe(GC_CANDIDATE_FORMAT);
    expect(body.formatVersion).toBe(GC_CANDIDATE_FORMAT_VERSION);
    expect(body.objectKey).toBe(orphanKey);
    expect(body.firstSeen).toBe(formatChronoRfc3339(t0));
    expect(body.sweepGeneration).toBe(1);

    const recollect = await collectGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0 + 10 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(recollect.newCandidateKeys).toEqual([]);
    expect(recollect.retainedCandidates).toBe(1);
    expect(GcCandidateV2.decode((await storage.get(keys[0]!))!).firstSeen).toBe(formatChronoRfc3339(t0));

    const early = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0 + 30 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(early.deletedObjectKeys).toEqual([]);
    expect(early.pendingCandidates).toBe(1);
    expect(await storage.get(orphanKey)).not.toBeNull();
    expect(await candidateKeys(storage)).toHaveLength(1);

    const late = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(late.deletedObjectKeys).toEqual([orphanKey]);
    expect(late.deletedCandidateKeys).toHaveLength(1);
    expect(await storage.get(orphanKey)).toBeNull();
    expect(await candidateKeys(storage)).toEqual([]);
  });

  it('r12_gc_corrupt_descriptor_means_zero_deletes_and_zero_candidates', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const v1 = await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const orphanKey = `${BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000003.dsbk`;
    await storage.put(orphanKey, Buffer.from('orphan'));
    const t0 = Date.now();
    await collectGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0, graceMs: DEFAULT_GC_GRACE_MS,
    });
    const goodDescriptor = (await storage.get(v1.snapshotKey))!;
    const before = storageKeys(storage);

    storage.putAt(v1.snapshotKey, Buffer.from('garbage-descriptor-bytes'), Date.now());
    await expect(collectGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0, graceMs: DEFAULT_GC_GRACE_MS,
    })).rejects.toThrow(/fail-closed/);
    await expect(sweepGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
    })).rejects.toThrow(/fail-closed/);
    expect(storageKeys(storage)).toEqual(before);

    storage.putAt(v1.snapshotKey, goodDescriptor, Date.now());
    const sweep = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
    });
    expect(sweep.deletedObjectKeys).toEqual([orphanKey]);
  });

  it('r12_gc_wrong_password_or_policy_mismatch_means_zero_deletes', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    const sessionA = await backup.createFileCipherSession('correct-password', { mCost: 8, tCost: 1, pCost: 1 });
    const sessionB = await backup.createFileCipherSession('wrong-password', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      await publishVerifiedStaging(storage, root, { deviceId: 'device-a', cipher: sessionA }, provider);
      const orphanKey = `${BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000004.dsbk`;
      await storage.put(orphanKey, Buffer.from('orphan'));
      const t0 = Date.now();
      await collectGcCandidates(storage, {
        holderDeviceId: 'device-a', nowMs: t0, graceMs: DEFAULT_GC_GRACE_MS, cipher: sessionA,
      });
      const before = storageSnapshot(storage);

      await expect(sweepGcCandidates(storage, {
        holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000,
        graceMs: DEFAULT_GC_GRACE_MS, cipher: sessionB,
      })).rejects.toThrow(/fail-closed/);
      expect(storageSnapshot(storage)).toEqual(before);

      await expect(sweepGcCandidates(storage, {
        holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000,
        graceMs: DEFAULT_GC_GRACE_MS,
      })).rejects.toThrow(/fail-closed/);
      expect(storageSnapshot(storage)).toEqual(before);

      const sweep = await sweepGcCandidates(storage, {
        holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000,
        graceMs: DEFAULT_GC_GRACE_MS, cipher: sessionA,
      });
      expect(sweep.deletedObjectKeys).toEqual([orphanKey]);
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('r12_gc_held_lease_blocks_both_passes_with_zero_writes', async () => {
    const root = await stagingDir(stagingFiles(1));
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, root, { deviceId: 'device-a' }, provider);
    const orphanKey = `${BACKUP_V2_OBJECTS_PREFIX}device-a/00000000-dead-4000-8000-000000000005.dsbk`;
    await storage.put(orphanKey, Buffer.from('orphan'));
    const guard = await acquireBackupRepoLease(storage, 'other-device');
    try {
      const before = storageSnapshot(storage);
      const t0 = Date.now();
      const collectError = await collectGcCandidates(storage, {
        holderDeviceId: 'device-a', nowMs: t0, graceMs: DEFAULT_GC_GRACE_MS,
      }).then(() => '', (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
      expect(collectError).toContain('E_BACKUP_LEASE_HELD');
      expect(collectError).not.toContain('E_SYNC_LEASE_HELD');

      const sweepError = await sweepGcCandidates(storage, {
        holderDeviceId: 'device-a', nowMs: t0 + 2 * 60 * 60 * 1000, graceMs: DEFAULT_GC_GRACE_MS,
      }).then(() => '', (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
      expect(sweepError).toContain('E_BACKUP_LEASE_HELD');

      expect(storageSnapshot(storage)).toEqual(before);
      expect(await candidateKeys(storage)).toEqual([]);
    } finally {
      await guard.release();
    }
  });

  it('r12_gc_candidate_codec_rejects_unknown_fields_and_out_of_scope_keys', () => {
    expect(DEFAULT_GC_GRACE_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);

    const good = new GcCandidateV2({
      format: GC_CANDIDATE_FORMAT,
      formatVersion: GC_CANDIDATE_FORMAT_VERSION,
      objectKey: `${BACKUP_V2_OBJECTS_PREFIX}device-a/x.dsbk`,
      firstSeen: formatChronoRfc3339(Date.now()),
      sweepGeneration: 1,
    });
    const bytes = good.encode();
    expect(GcCandidateV2.decode(bytes)).toEqual(good);

    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    value.surprise = true;
    expect(() => GcCandidateV2.decode(Buffer.from(JSON.stringify(value)))).toThrow(/unknown field/);

    expect(() => new GcCandidateV2({ ...good, formatVersion: 3 }).validate()).toThrow();

    for (const badKey of [
      BACKUP_V2_CONFIG_KEY,
      'backups/20250101-000000.zip',
      `${BACKUP_V2_MANIFESTS_PREFIX}device-a.json`,
      `${BACKUP_V2_OBJECTS_PREFIX}device-a/../../config.dsbk`,
    ]) {
      expect(() => new GcCandidateV2({ ...good, objectKey: badKey }).validate(), badKey).toThrow();
    }
  });
});
