/**
 * Port of `sync_android_restart.rs::webdav_only_device_switch_upload_download_roundtrip`.
 *
 * Old device uploads a backup through the real `WebDavStorage` protocol stack
 * (MKCOL / streaming PUT / PROPFIND / GET), a new device with a different
 * device id discovers the version through the same root and downloads
 * byte-identical content.
 */

import './local-fs-fixture.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { CloudSyncManager } from '../src/sync_manager.ts';
import { WebDavStorage } from '../src/webdav.ts';
import { spawnStatefulDav } from './fake_dav_store.ts';

const ROOT = 'phone-move';

const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempFile(content: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'android-restart-'));
  tempDirs.push(dir);
  const path = join(dir, 'device-switch.zip');
  await writeFile(path, content);
  return path;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('sync_android_restart.rs', () => {
  it('webdav_only_device_switch_upload_download_roundtrip', async () => {
    const server = await spawnStatefulDav({ root: ROOT });
    const payload = Buffer.alloc(4096);
    for (let index = 0; index < 1024; index++) payload.writeUInt32LE(index, index * 4);
    const zipPath = await tempFile(payload);
    const backup = createBackupCrypto();

    const oldManager = new CloudSyncManager(
      new WebDavStorage({ endpoint: server.endpoint, username: 'student', password: 'secret' }, ROOT),
      'old-phone',
      { backup },
    );
    const uploaded = await oldManager.upload(zipPath, '9.9.9', '换机备份');
    expect(uploaded.version.deviceId).toBe('old-phone');
    expect(uploaded.version.size).toBe(payload.byteLength);

    const newManager = new CloudSyncManager(
      new WebDavStorage({ endpoint: server.endpoint, username: 'student', password: 'secret' }, ROOT),
      'new-phone',
      { backup },
    );
    const versions = await newManager.listVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(uploaded.version.id);
    expect(versions[0]!.deviceId).toBe('old-phone');

    const downloadDir = await tempDir('android-restart-download-');
    const downloaded = await newManager.download(null, downloadDir);
    expect(downloaded.version.id).toBe(uploaded.version.id);
    const downloadedBytes = await readFile(downloaded.localPath);
    expect(downloadedBytes.equals(payload)).toBe(true);
    await server.close();
  });
});
