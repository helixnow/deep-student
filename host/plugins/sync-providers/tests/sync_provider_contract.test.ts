/**
 * Ports of the provider-level contracts from `sync_provider_contract_tests.rs`.
 *
 * Rust marks every case `#[ignore = "requires ... docker-compose ..."]` and only
 * runs them with `DS_SYNC_TEST_DOCKER=1`. The same gate is preserved here; CI
 * without the compose services skips these cases instead of pretending to have
 * exercised a real provider.
 *
 * The remaining cases in that Rust file exercise `SyncManager` (L20) and are
 * tracked as cross-lane blockers in ACCEPTANCE.md.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { CloudStorage, RuntimeCloudStorageConfig } from '../api.ts';
import { createStorageWithCapabilities } from '../index.ts';
import { CloudSyncManager } from '../src/sync_manager.ts';
import { DESKTOP_CAPABILITIES } from '../src/config.ts';

const ENABLED = process.env.DS_SYNC_TEST_DOCKER === '1';
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

function uniqueRoot(provider: string): string {
  return `deep-student-sync-contract/${provider}/${randomUUID()}`;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function webdavConfig(password?: string): RuntimeCloudStorageConfig {
  return {
    provider: 'webdav',
    webdav: {
      endpoint: process.env.DS_SYNC_WEBDAV_ENDPOINT ?? 'http://127.0.0.1:8080/',
      username: process.env.DS_SYNC_WEBDAV_USERNAME ?? 'webdav',
      password: password ?? process.env.DS_SYNC_WEBDAV_PASSWORD ?? 'webdav123',
    },
    root: uniqueRoot(password === undefined ? 'webdav' : 'webdav-bad-auth'),
  };
}

function s3Config(secret?: string): RuntimeCloudStorageConfig {
  return {
    provider: 's3',
    s3: {
      endpoint: process.env.DS_SYNC_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      bucket: process.env.DS_SYNC_S3_BUCKET ?? 'deep-student',
      accessKeyId: process.env.DS_SYNC_S3_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: secret ?? process.env.DS_SYNC_S3_SECRET_KEY ?? 'minioadmin123',
      region: process.env.DS_SYNC_S3_REGION ?? 'us-east-1',
      pathStyle: true,
    },
    root: uniqueRoot(secret === undefined ? 's3' : 's3-bad-auth'),
  };
}

function ftpConfig(password?: string): RuntimeCloudStorageConfig {
  return {
    provider: 'ftp',
    ftp: {
      host: process.env.DS_SYNC_FTP_HOST ?? '127.0.0.1',
      port: Number(process.env.DS_SYNC_FTP_PORT ?? '2121'),
      username: process.env.DS_SYNC_FTP_USERNAME ?? 'ftpuser',
      password: password ?? process.env.DS_SYNC_FTP_PASSWORD ?? 'ftpuser123',
      useTls: false,
    },
    root: uniqueRoot(password === undefined ? 'ftp' : 'ftp-bad-auth'),
  };
}

async function storageFor(config: RuntimeCloudStorageConfig): Promise<CloudStorage> {
  return createStorageWithCapabilities(config, DESKTOP_CAPABILITIES);
}

function deterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 31 + Math.floor(index / 7)) & 0xff;
  }
  return bytes;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sha256ZeroesHex(length: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  let remaining = length;
  while (remaining > 0) {
    const take = Math.min(remaining, chunk.byteLength);
    hash.update(take === chunk.byteLength ? chunk : chunk.subarray(0, take));
    remaining -= take;
  }
  return hash.digest('hex');
}

async function runBasicObjectContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();

  const smallKey = 'objects/basic/hello.txt';
  const nestedKey = 'objects/中文 空格/nested.txt';
  const missingKey = 'objects/missing/nope.txt';

  expect(await storage.get(missingKey)).toBeNull();
  await storage.put(smallKey, Buffer.from('hello cloud sync'));
  await storage.put(nestedKey, Buffer.from('路径编码', 'utf8'));

  expect(Buffer.from((await storage.get(smallKey))!).toString('utf8')).toBe('hello cloud sync');
  expect(Buffer.from((await storage.get(nestedKey))!).toString('utf8')).toBe('路径编码');

  const info = await storage.stat(smallKey);
  expect(info).not.toBeNull();
  expect(info!.key).toBe(smallKey);
  expect(info!.size).toBe(Buffer.byteLength('hello cloud sync'));

  const listed = await storage.list('objects/');
  const keys = listed.map(entry => entry.key);
  expect(keys).toContain(smallKey);
  expect(keys).toContain(nestedKey);

  await storage.delete(smallKey);
  expect(await storage.get(smallKey)).toBeNull();
}

async function runObjectSemanticsContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();

  const base = `objects/semantics-${randomUUID().replace(/-/g, '')}/`;
  expect(await storage.list(`${base}empty/`)).toHaveLength(0);

  const primaryKey = `${base}prefix/item.txt`;
  const nestedKey = `${base}prefix/deep/nested.bin`;
  const siblingKey = `${base}prefixish/item.txt`;
  const specialKey = `${base}special/空格 & plus+ percent% hash# question?/quote'.txt`;

  expect(await storage.stat(primaryKey)).toBeNull();

  await storage.put(primaryKey, Buffer.from('first payload'));
  await storage.put(nestedKey, deterministicPayload(4099));
  await storage.put(siblingKey, Buffer.from('sibling payload'));
  await storage.put(specialKey, Buffer.from('特殊路径内容', 'utf8'));

  await storage.put(primaryKey, Buffer.from('overwritten payload with a different length'));
  const info = await storage.stat(primaryKey);
  expect(info).not.toBeNull();
  expect(info!.key).toBe(primaryKey);
  expect(info!.size).toBe(Buffer.byteLength('overwritten payload with a different length'));
  expect(Buffer.from((await storage.get(primaryKey))!).toString('utf8'))
    .toBe('overwritten payload with a different length');
  expect(Buffer.from((await storage.get(specialKey))!).toString('utf8')).toBe('特殊路径内容');

  const listed = await storage.list(`${base}prefix/`);
  const keys = listed.map(entry => entry.key);
  expect(keys).toContain(primaryKey);
  expect(keys).toContain(nestedKey);
  expect(keys).not.toContain(siblingKey);

  await storage.delete(primaryKey);
  await storage.delete(primaryKey);
  expect(await storage.stat(primaryKey)).toBeNull();

  await storage.delete(`${base}never-created/deep/nested/ghost.bin`);
}

async function runFileChecksumContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();
  const dir = await tempDir('contract-checksum-');
  const source = join(dir, 'source.bin');
  const target = join(dir, 'target.bin');
  const payload = deterministicPayload(2 * 1024 * 1024 + 17);
  await writeFile(source, payload);
  const expectedHash = sha256Hex(payload);

  const remoteKey = 'files/payload.bin';
  expect(await storage.putFile(remoteKey, source, null)).toBe(expectedHash);
  expect(await storage.getFile(remoteKey, target, expectedHash, null)).toBe(expectedHash);
  expect((await readFile(target)).equals(payload)).toBe(true);
}

async function runFileChecksumMismatchPreservesLocalTargetContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();
  const dir = await tempDir('contract-checksum-mismatch-');
  const source = join(dir, 'source.bin');
  const target = join(dir, 'target.bin');
  const payload = deterministicPayload(512 * 1024 + 29);
  await writeFile(source, payload);
  const expectedHash = sha256Hex(payload);

  const different = new Uint8Array(payload);
  for (let index = 0; index < different.length; index++) different[index] = (different[index] ?? 0) ^ 0x5a;
  const wrongSameSizeHash = sha256Hex(different);
  expect(different.byteLength).toBe(payload.byteLength);
  expect(wrongSameSizeHash).not.toBe(expectedHash);

  const remoteKey = 'files/checksum-mismatch.bin';
  expect(await storage.putFile(remoteKey, source, null)).toBe(expectedHash);

  const sentinel = Buffer.from('existing local file should remain untouched');
  await writeFile(target, sentinel);

  let thrown: unknown;
  try {
    await storage.getFile(remoteKey, target, wrongSameSizeHash, null);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(String((thrown as Error).message)).toContain('校验');
  expect((await readFile(target)).equals(sentinel)).toBe(true);
}

async function runEncryptedBackupPayloadContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();
  const backup = createBackupCrypto();
  const plaintext = Buffer.concat([
    Buffer.from('PK\x03\x04deep-student backup fixture\n', 'binary'),
    deterministicPayload(32 * 1024 + 37),
  ]);
  const password = 'provider-contract-password';
  const encrypted = Buffer.from(await backup.encryptBackup(plaintext, password));
  expect(backup.isEncryptedBackup(encrypted)).toBe(true);
  expect(encrypted.includes(plaintext.subarray(0, Math.min(plaintext.byteLength, 256)))).toBe(false);

  const dir = await tempDir('contract-encrypted-backup-');
  const encryptedFile = join(dir, 'encrypted.dsbk');
  await writeFile(encryptedFile, encrypted);

  const manager = new CloudSyncManager(storage, `device-backup-${randomUUID().replace(/-/g, '')}`, { backup });
  const upload = await manager.upload(encryptedFile, 'provider-contract', 'encrypted backup contract');
  expect(upload.version.size).toBe(encrypted.byteLength);
  expect(upload.version.checksum).toBe(sha256Hex(encrypted));

  const versions = await manager.listVersions();
  expect(versions.some(version => version.id === upload.version.id)).toBe(true);

  const downloadDir = await tempDir('contract-encrypted-download-');
  const downloaded = await manager.download(upload.version.id, downloadDir);
  const downloadedBytes = await readFile(downloaded.localPath);
  expect(downloadedBytes.equals(encrypted)).toBe(true);
  expect(backup.isEncryptedBackup(downloadedBytes)).toBe(true);
  expect(Buffer.from(await backup.decryptBackup(downloadedBytes, password)).equals(plaintext)).toBe(true);

  let wrongPasswordFailed = false;
  try { await backup.decryptBackup(downloadedBytes, 'wrong-password'); }
  catch { wrongPasswordFailed = true; }
  expect(wrongPasswordFailed).toBe(true);
}

async function runS3ListPaginationContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();
  const objectCount = 1105;
  for (let index = 0; index < objectCount; index++) {
    await storage.put(`pagination/page/object-${String(index).padStart(4, '0')}.txt`, Buffer.from(`payload-${index}`));
  }
  const listed = await storage.list('pagination/page/');
  expect(listed).toHaveLength(objectCount);
}

async function runS3MultipartFileContract(storage: CloudStorage): Promise<void> {
  await storage.checkConnection();
  const dir = await tempDir('contract-multipart-');
  const source = join(dir, 'large-zeroes.bin');
  const target = join(dir, 'large-zeroes.download.bin');
  const fileSize = 101 * 1024 * 1024;
  await writeFile(source, '');
  await truncate(source, fileSize);
  const expectedHash = sha256ZeroesHex(fileSize);

  const events: Array<[number, number]> = [];
  expect(await storage.putFile('multipart/large-zeroes.bin', source, (done, total) => {
    events.push([done, total]);
  })).toBe(expectedHash);
  expect(events.some(([done, total]) => done === fileSize && total === fileSize)).toBe(true);

  expect(await storage.getFile('multipart/large-zeroes.bin', target, expectedHash, null)).toBe(expectedHash);
  expect((await stat(target)).size).toBe(fileSize);
}

describe.skipIf(!ENABLED)('sync_provider_contract_tests.rs (DS_SYNC_TEST_DOCKER=1)', () => {
  it('webdav_basic_object_contract', async () => {
    await runBasicObjectContract(await storageFor(webdavConfig()));
  });

  it('webdav_object_semantics_contract', async () => {
    await runObjectSemanticsContract(await storageFor(webdavConfig()));
  });

  it('webdav_file_checksum_contract', async () => {
    await runFileChecksumContract(await storageFor(webdavConfig()));
  });

  it('webdav_encrypted_backup_payload_contract', async () => {
    await runEncryptedBackupPayloadContract(await storageFor(webdavConfig()));
  });

  it('webdav_file_checksum_mismatch_preserves_local_target_contract', async () => {
    await runFileChecksumMismatchPreservesLocalTargetContract(await storageFor(webdavConfig()));
  });

  it('webdav_bad_credentials_rejected', async () => {
    const storage = await storageFor(webdavConfig('definitely-wrong-password'));
    await expect(storage.checkConnection()).rejects.toBeInstanceOf(Error);
  });

  it('s3_basic_object_contract', async () => {
    await runBasicObjectContract(await storageFor(s3Config()));
  });

  it('s3_object_semantics_contract', async () => {
    await runObjectSemanticsContract(await storageFor(s3Config()));
  });

  it('s3_file_checksum_contract', async () => {
    await runFileChecksumContract(await storageFor(s3Config()));
  });

  it('s3_encrypted_backup_payload_contract', async () => {
    await runEncryptedBackupPayloadContract(await storageFor(s3Config()));
  });

  it('s3_file_checksum_mismatch_preserves_local_target_contract', async () => {
    await runFileChecksumMismatchPreservesLocalTargetContract(await storageFor(s3Config()));
  });

  it('s3_bad_credentials_rejected', async () => {
    const storage = await storageFor(s3Config('definitely-wrong-secret'));
    await expect(storage.checkConnection()).rejects.toBeInstanceOf(Error);
  });

  it('s3_list_pagination_contract', async () => {
    await runS3ListPaginationContract(await storageFor(s3Config()));
  });

  it('s3_multipart_file_contract', async () => {
    await runS3MultipartFileContract(await storageFor(s3Config()));
  });

  it('ftp_basic_object_contract', async () => {
    await runBasicObjectContract(await storageFor(ftpConfig()));
  });

  it('ftp_object_semantics_contract', async () => {
    await runObjectSemanticsContract(await storageFor(ftpConfig()));
  });

  it('ftp_file_checksum_contract', async () => {
    await runFileChecksumContract(await storageFor(ftpConfig()));
  });

  it('ftp_encrypted_backup_payload_contract', async () => {
    await runEncryptedBackupPayloadContract(await storageFor(ftpConfig()));
  });

  it('ftp_file_checksum_mismatch_preserves_local_target_contract', async () => {
    await runFileChecksumMismatchPreservesLocalTargetContract(await storageFor(ftpConfig()));
  });

  it('ftp_bad_credentials_rejected', async () => {
    const storage = await storageFor(ftpConfig('definitely-wrong-password'));
    await expect(storage.checkConnection()).rejects.toBeInstanceOf(Error);
  });
});
