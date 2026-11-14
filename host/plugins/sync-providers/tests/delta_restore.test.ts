import './local-fs-fixture.ts';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { BACKUP_V2_OBJECTS_PREFIX, publishVerifiedStaging, type DeltaInventory, type DeltaInventoryProvider } from '../src/delta_upload.ts';
import { restoreSnapshotToStaging } from '../src/delta_restore.ts';
import { ZipFileReader } from '../../../platform/zip/index.ts';
import { MemoryStorage } from './memory_storage.ts';

const backup = createBackupCrypto();
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix = 'delta-restore-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function stagingDir(files: Record<string, string>): Promise<string> {
  const dir = await tempDir('delta-restore-src-');
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

const provider: DeltaInventoryProvider = {
  async buildCrossChecked(root: string): Promise<DeltaInventory> {
    const entries: { logicalPath: string; size: number; plaintextSha256: string }[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const logicalPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full, logicalPath);
        else if (entry.isFile()) {
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
      Buffer.from(left.logicalPath, 'utf8'), Buffer.from(right.logicalPath, 'utf8'),
    ));
    return { entries, logicalSize: entries.reduce((sum, entry) => sum + entry.size, 0) };
  },
};

describe('delta_restore.rs', () => {
  it('materializes a published snapshot into an empty staging directory', async () => {
    const source = await stagingDir({ 'manifest.json': '{"v":1}', 'db/a.bin': 'alpha', 'assets/图片.bin': 'beta' });
    const storage = new MemoryStorage();
    const published = await publishVerifiedStaging(storage, source, { deviceId: 'device-1' }, provider);

    const dest = join(await tempDir(), 'restored');
    const result = await restoreSnapshotToStaging(
      storage, dest, { deviceId: 'device-1' }, provider,
    );
    expect(result.versionId).toBe(published.versionId);
    expect(result.snapshotKey).toBe(published.snapshotKey);
    expect(result.logicalSize).toBe(published.logicalSize);
    expect(result.fileCount).toBe(3);
    expect(result.zipPath).toBeNull();
    expect(await readFile(join(dest, 'manifest.json'), 'utf8')).toBe('{"v":1}');
    expect(await readFile(join(dest, 'db/a.bin'), 'utf8')).toBe('alpha');
    expect(await readFile(join(dest, 'assets/图片.bin'), 'utf8')).toBe('beta');
  });

  it('restores an explicitly selected older version', async () => {
    const source = await stagingDir({ 'manifest.json': '{"v":1}', 'db/a.bin': 'old' });
    const storage = new MemoryStorage();
    const first = await publishVerifiedStaging(storage, source, { deviceId: 'device-1' }, provider);
    await writeFile(join(source, 'manifest.json'), '{"v":2}');
    await writeFile(join(source, 'db/a.bin'), 'new');
    const second = await publishVerifiedStaging(storage, source, { deviceId: 'device-1' }, provider);

    const oldDest = join(await tempDir(), 'old');
    await restoreSnapshotToStaging(storage, oldDest, { deviceId: 'device-1', versionId: first.versionId }, provider);
    expect(await readFile(join(oldDest, 'db/a.bin'), 'utf8')).toBe('old');

    const latestDest = join(await tempDir(), 'latest');
    await restoreSnapshotToStaging(storage, latestDest, { deviceId: 'device-1' }, provider);
    expect(await readFile(join(latestDest, 'db/a.bin'), 'utf8')).toBe('new');
    expect(second.versionId).not.toBe(first.versionId);
  });

  it('round-trips an encrypted snapshot with the same session', async () => {
    const source = await stagingDir({ 'manifest.json': '{"v":1}', 'db/secret.bin': 'top-secret' });
    const storage = new MemoryStorage();
    const session = await backup.createFileCipherSession('delta-restore-pw', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      const published = await publishVerifiedStaging(
        storage, source, { deviceId: 'device-1', cipher: session }, provider,
      );
      const dest = join(await tempDir(), 'restored');
      await restoreSnapshotToStaging(storage, dest, { deviceId: 'device-1', cipher: session }, provider);
      expect(await readFile(join(dest, 'db/secret.bin'), 'utf8')).toBe('top-secret');
      expect(await readFile(join(dest, 'manifest.json'), 'utf8')).toBe('{"v":1}');
      expect(published.logicalSize).toBe(17);
    } finally {
      session.dispose();
    }
  });

  it('rejects a missing encryption session and leaves the destination empty', async () => {
    const source = await stagingDir({ 'manifest.json': '{}', 'db/a.bin': 'secret' });
    const storage = new MemoryStorage();
    const session = await backup.createFileCipherSession('delta-restore-pw', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      await publishVerifiedStaging(storage, source, { deviceId: 'device-1', cipher: session }, provider);
      const dest = join(await tempDir(), 'restored');
      await expect(restoreSnapshotToStaging(storage, dest, { deviceId: 'device-1' }, provider))
        .rejects.toThrow(/DSBK 密文/);
      expect(await readdir(dest)).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it('rejects a corrupt object and leaves the destination empty', async () => {
    const source = await stagingDir({ 'manifest.json': '{}', 'db/a.bin': 'alpha' });
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, source, { deviceId: 'device-1' }, provider);
    const objectKey = [...storage.files.keys()].find(key => key.startsWith(BACKUP_V2_OBJECTS_PREFIX))!;
    const original = (await storage.get(objectKey))!;
    original[0] = original[0]! ^ 0xff;
    await storage.put(objectKey, original);

    const dest = join(await tempDir(), 'restored');
    await expect(restoreSnapshotToStaging(storage, dest, { deviceId: 'device-1' }, provider))
      .rejects.toThrow(/SHA-256/);
    expect(await readdir(dest)).toEqual([]);
  });

  it('writes a v1-compatible ZIP only after staging verification', async () => {
    const source = await stagingDir({ 'manifest.json': '{"v":1}', 'db/a.bin': 'alpha' });
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, source, { deviceId: 'device-1' }, provider);

    const base = await tempDir();
    const dest = join(base, 'restored');
    const zip = join(base, 'compat.zip');
    const result = await restoreSnapshotToStaging(
      storage, dest, { deviceId: 'device-1', writeCompatibleZip: zip }, provider,
    );
    expect(result.zipPath).toBe(zip);
    expect((await stat(zip)).size).toBeGreaterThan(0);
    const head = await readFile(zip);
    expect(head.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');

    const existing = join(base, 'existing.zip');
    await writeFile(existing, 'x');
    const dest2 = join(base, 'restored2');
    await expect(restoreSnapshotToStaging(
      storage, dest2, { deviceId: 'device-1', writeCompatibleZip: existing }, provider,
    )).rejects.toThrow(/拒绝覆盖/);
  });

  it('compatible ZIP uses the Rust zip 0.6.6 start_file layout and round-trips through platform/zip', async () => {
    const files = { 'manifest.json': '{"v":1}', 'db/a.bin': 'alpha'.repeat(1000), '笔记/b.md': '# b' };
    const source = await stagingDir(files);
    const storage = new MemoryStorage();
    await publishVerifiedStaging(storage, source, { deviceId: 'device-1' }, provider);
    const base = await tempDir();
    const zip = join(base, 'compat.zip');
    await restoreSnapshotToStaging(storage, join(base, 'restored'), { deviceId: 'device-1', writeCompatibleZip: zip }, provider);
    const reader = await ZipFileReader.open(zip);
    try {
      expect(reader.entries.map(entry => entry.name)).toEqual(['db/a.bin', 'manifest.json', '笔记/b.md']);
      for (const entry of reader.entries) {
        expect(entry.method, entry.name).toBe(8);
        expect(entry.flags, entry.name).toBe(/[\u0080-\uffff]/.test(entry.name) ? 0x0800 : 0);
        expect(entry.dosTime, entry.name).toBe(0);
        expect(entry.dosDate, entry.name).toBe(0x21);
        expect(entry.versionMadeBy, entry.name).toBe(0x032e);
        expect(entry.externalAttributes >>> 16, entry.name).toBe(0o100644);
        expect((await reader.readEntry(entry)).toString(), entry.name).toBe(files[entry.name as keyof typeof files]);
      }
    } finally { await reader.close(); }
    expect((await readdir(base)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails closed when the L21 inventory provider is not published', async () => {
    const storage = new MemoryStorage();
    const dest = join(await tempDir(), 'restored');
    await expect(restoreSnapshotToStaging(storage, dest, { deviceId: 'device-1' }))
      .rejects.toThrow(/delta_inventory/);
  });
});
