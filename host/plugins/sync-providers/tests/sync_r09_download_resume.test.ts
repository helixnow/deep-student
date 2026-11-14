import './local-fs-fixture.ts';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { RESUMABLE_DOWNLOAD_UNSUPPORTED } from '../src/traits.ts';
import { CloudSyncManager } from '../src/sync_manager.ts';
import { MemoryStorage, ResumableMemoryStorage } from './memory_storage.ts';

const backup = createBackupCrypto();
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix = 'sync-r09-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeBackupBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

async function uploadFixture(
  manager: CloudSyncManager,
  dir: string,
  bytes: Uint8Array,
): Promise<{ id: string }> {
  const zipPath = join(dir, 'source.zip');
  await writeFile(zipPath, bytes);
  const result = await manager.upload(zipPath, 'r09-test', null);
  return result.version;
}

function partialPath(dir: string, versionId: string): string {
  return join(dir, `.${versionId}.zip.part`);
}

describe('sync_r09_download_resume_tests.rs', () => {
  it('interrupted_download_keeps_partial_then_resume_completes', async () => {
    const storage = new ResumableMemoryStorage();
    const manager = new CloudSyncManager(storage, 'device-r09', { backup });
    const work = await tempDir();
    const payload = fakeBackupBytes(64 * 1024);
    const version = await uploadFixture(manager, work, payload);
    const downloadDir = await tempDir();

    storage.failAfterBytes = 10_000;
    await expect(manager.download(version.id, downloadDir)).rejects.toThrow(/中断/);

    const part = partialPath(downloadDir, version.id);
    const finalZip = join(downloadDir, `${version.id}.zip`);
    expect((await stat(part)).isFile()).toBe(true);
    expect((await stat(part)).size).toBe(10_000);
    await expect(stat(finalZip)).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await manager.download(version.id, downloadDir);
    expect(storage.resumeRequests).toEqual([0, 10_000]);
    await expect(stat(part)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.localPath).toBe(finalZip);
    expect(new Uint8Array(await readFile(finalZip))).toEqual(payload);
  });

  it('corrupted_partial_is_discarded_with_explicit_checksum_error', async () => {
    const storage = new ResumableMemoryStorage();
    const manager = new CloudSyncManager(storage, 'device-r09', { backup });
    const work = await tempDir();
    const payload = fakeBackupBytes(32 * 1024);
    const version = await uploadFixture(manager, work, payload);

    const downloadDir = await tempDir();
    const part = partialPath(downloadDir, version.id);
    await writeFile(part, new Uint8Array(8 * 1024).fill(0xaa));

    await expect(manager.download(version.id, downloadDir)).rejects.toThrow(/SHA256 校验失败/);
    await expect(stat(part)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(downloadDir, `${version.id}.zip`))).rejects.toMatchObject({ code: 'ENOENT' });

    await manager.download(version.id, downloadDir);
    expect(new Uint8Array(await readFile(join(downloadDir, `${version.id}.zip`)))).toEqual(payload);
  });

  it('server_ignoring_resume_restarts_from_zero_and_still_succeeds', async () => {
    const storage = new ResumableMemoryStorage();
    const manager = new CloudSyncManager(storage, 'device-r09', { backup });
    const work = await tempDir();
    const payload = fakeBackupBytes(16 * 1024);
    const version = await uploadFixture(manager, work, payload);

    const downloadDir = await tempDir();
    const part = partialPath(downloadDir, version.id);
    await writeFile(part, payload.subarray(0, 4 * 1024));
    storage.ignoreResume = true;

    await manager.download(version.id, downloadDir);
    expect(new Uint8Array(await readFile(join(downloadDir, `${version.id}.zip`)))).toEqual(payload);
  });

  it('oversized_partial_is_discarded_and_download_restarts_fresh', async () => {
    const storage = new ResumableMemoryStorage();
    const manager = new CloudSyncManager(storage, 'device-r09', { backup });
    const work = await tempDir();
    const payload = fakeBackupBytes(8 * 1024);
    const version = await uploadFixture(manager, work, payload);

    const downloadDir = await tempDir();
    await writeFile(partialPath(downloadDir, version.id), new Uint8Array(32 * 1024));
    await manager.download(version.id, downloadDir);
    expect(storage.resumeRequests).toEqual([0]);
    expect(new Uint8Array(await readFile(join(downloadDir, `${version.id}.zip`)))).toEqual(payload);
  });

  it('non_resumable_provider_downloads_whole_file_without_partial', async () => {
    const storage = new MemoryStorage();
    const manager = new CloudSyncManager(storage, 'device-r09', { backup });
    const work = await tempDir();
    const payload = fakeBackupBytes(8 * 1024);
    const version = await uploadFixture(manager, work, payload);

    const downloadDir = await tempDir();
    await manager.download(version.id, downloadDir);
    expect(new Uint8Array(await readFile(join(downloadDir, `${version.id}.zip`)))).toEqual(payload);
    await expect(stat(partialPath(downloadDir, version.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('symlink_partial_is_removed_without_resuming_into_its_target', async () => {
    // sync_manager.rs:1782-1800 uses symlink_metadata, not metadata/stat.
    const storage = new ResumableMemoryStorage();
    const manager = new CloudSyncManager(storage, 'device-r09', { backup });
    const work = await tempDir();
    const payload = fakeBackupBytes(8 * 1024);
    const version = await uploadFixture(manager, work, payload);

    const target = join(work, 'linked-target.bin');
    const original = payload.subarray(0, 2048);
    await writeFile(target, original);
    const downloadDir = await tempDir();
    const part = partialPath(downloadDir, version.id);
    await symlink(target, part);

    const result = await manager.download(version.id, downloadDir);
    expect(storage.resumeRequests).toEqual([0]);
    expect(new Uint8Array(await readFile(target))).toEqual(original);
    expect((await lstat(result.localPath)).isSymbolicLink()).toBe(false);
    expect(new Uint8Array(await readFile(result.localPath))).toEqual(payload);
    await expect(lstat(part)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('default_get_file_resumable_is_fail_closed', async () => {
    const storage = new MemoryStorage();
    await storage.put('backups/whatever.zip', Buffer.from('payload'));

    const dir = await tempDir();
    const out = join(dir, 'out.part');
    await expect(storage.getFileResumable('backups/whatever.zip', out, 0, null))
      .rejects.toThrow(RESUMABLE_DOWNLOAD_UNSUPPORTED);
    await expect(storage.getFileResumable('backups/whatever.zip', out, 0, null))
      .rejects.toThrow(/不支持断点续传/);
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
