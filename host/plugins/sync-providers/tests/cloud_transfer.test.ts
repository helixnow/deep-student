/**
 * [R4-P07] Upload/download failure branches match `cloud/mod.rs`.
 *
 * - temp-file creation failure is FileSystem "创建加密临时文件失败";
 * - download open failure is FileSystem;
 * - a short head keeps the file and reports `read_exact` context;
 * - decrypt temp-file creation failure is FileSystem, not a password error;
 * - `nonBlank` was replaced by Rust's `!is_empty()` password filter.
 */

import './local-fs-fixture.ts';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { finishDownloadedObject, nonEmptyPassword, prepareEncryptedUpload } from '../src/cloud_transfer.ts';
import { runUploadCommand, type CloudProgress } from '../src/cloud_commands.ts';
import { CloudStorageError } from '../src/errors.ts';
import type { CloudSyncManager } from '../src/sync_manager.ts';
import { SYNC_E2EE_PASSWORD_REQUIRED_CODE, SYNC_E2EE_WRONG_PASSWORD_CODE } from '../src/mod.ts';

const backup = createBackupCrypto();
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function failure(run: Promise<unknown>): Promise<CloudStorageError> {
  try { await run; }
  catch (error) {
    if (error instanceof CloudStorageError) return error;
    throw error;
  }
  throw new Error('expected the production helper to reject');
}

function policy(downloadedPath: string, overrides: Partial<Parameters<typeof finishDownloadedObject>[0]> = {}): Parameters<typeof finishDownloadedObject>[0] {
  return {
    backup,
    downloadedPath,
    cloudMarkerPresent: false,
    locallyRememberedEncrypted: false,
    plaintextHistoryOptIn: false,
    encryptionPassword: null,
    ...overrides,
  };
}

describe('cloud/mod.rs upload temp-file branches', () => {
  it('filters only the empty password (Rust !is_empty, not trim)', () => {
    expect(nonEmptyPassword(null)).toBeNull();
    expect(nonEmptyPassword(undefined)).toBeNull();
    expect(nonEmptyPassword('')).toBeNull();
    expect(nonEmptyPassword(' ')).toBe(' ');
    expect(nonEmptyPassword('pw')).toBe('pw');
  });

  it('creates the encrypted temp file next to the source and cleans it up', async () => {
    const dir = await tempDir('upload-temp-');
    const source = join(dir, 'backup.zip');
    await writeFile(source, Buffer.from('PK\x03\x04payload'));
    const prepared = await prepareEncryptedUpload(backup, source, 'password');
    try {
      expect(prepared.path.startsWith(join(dir, '.cloud-upload-'))).toBe(true);
      const encrypted = await readFile(prepared.path);
      expect(backup.isEncryptedBackup(encrypted.subarray(0, 4))).toBe(true);
    } finally {
      await prepared.dispose();
    }
    await expect(stat(prepared.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports FileSystem when the encrypted temp file cannot be created', async () => {
    const dir = await tempDir('upload-missing-parent-');
    const error = await failure(prepareEncryptedUpload(backup, join(dir, 'missing', 'backup.zip'), 'password'));
    expect(error.value.error_type).toBe('FileSystem');
    expect(error.message).toContain('创建加密临时文件失败');
  });

  it('keeps encryption failures in the Unknown bucket', async () => {
    const dir = await tempDir('upload-encrypt-failure-');
    const sourceDir = join(dir, 'source-is-a-directory');
    await mkdir(sourceDir);
    // encrypt_backup_file cannot read a directory as the plaintext input.
    const error = await failure(prepareEncryptedUpload(backup, sourceDir, 'password'));
    expect(error.value.error_type).toBe('Unknown');
    expect(error.message).toContain('加密备份失败');
  });
});

describe('cloud/mod.rs download post-processing branches', () => {
  it('reports FileSystem when the downloaded file cannot be opened', async () => {
    const dir = await tempDir('download-open-failure-');
    const error = await failure(finishDownloadedObject(policy(join(dir, 'absent.zip'))));
    expect(error.value.error_type).toBe('FileSystem');
    expect(error.message).toContain('打开已下载备份进行格式识别失败');
  });

  it('keeps the file and includes read_exact context when the head is short', async () => {
    const dir = await tempDir('download-short-head-');
    const path = join(dir, 'short.zip');
    await writeFile(path, Buffer.from('PK'));
    const error = await failure(finishDownloadedObject(policy(path)));
    expect(error.value.error_type).toBe('Validation');
    expect(error.message).toContain('failed to fill whole buffer');
    expect((await stat(path)).size).toBe(2);
  });

  it('removes a plaintext object rejected by the anti-downgrade gate', async () => {
    const dir = await tempDir('download-downgrade-');
    const path = join(dir, 'plain.zip');
    await writeFile(path, Buffer.from('PK\x03\x04plaintext'));
    const error = await failure(finishDownloadedObject(policy(path, { cloudMarkerPresent: true })));
    expect(error.value.error_type).toBe('Validation');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a password-required Configuration error without deleting the ciphertext', async () => {
    const dir = await tempDir('download-no-password-');
    const path = join(dir, 'encrypted.zip');
    await writeFile(path, Buffer.from(await backup.encryptBackup(Buffer.from('PK\x03\x04payload'), 'pw')));
    const error = await failure(finishDownloadedObject(policy(path)));
    expect(error.value.error_type).toBe('Configuration');
    expect(error.message).toContain(SYNC_E2EE_PASSWORD_REQUIRED_CODE);
    expect((await stat(path)).size).toBeGreaterThan(0);
  });

  it('reports FileSystem when the decrypt temp file cannot be created', async () => {
    const dir = await tempDir('download-decrypt-temp-');
    const path = join(dir, 'encrypted.zip');
    await writeFile(path, Buffer.from(await backup.encryptBackup(Buffer.from('PK\x03\x04payload'), 'pw')));
    await chmod(dir, 0o500);
    try {
      const error = await failure(finishDownloadedObject(policy(path, { encryptionPassword: 'pw' })));
      expect(error.value.error_type).toBe('FileSystem');
      expect(error.message).toContain('创建解密临时文件失败');
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('reports Validation with the wrong-password code when decryption fails', async () => {
    const dir = await tempDir('download-wrong-password-');
    const path = join(dir, 'encrypted.zip');
    await writeFile(path, Buffer.from(await backup.encryptBackup(Buffer.from('PK\x03\x04payload'), 'right')));
    const error = await failure(finishDownloadedObject(policy(path, { encryptionPassword: 'wrong' })));
    expect(error.value.error_type).toBe('Validation');
    expect(error.message).toContain(SYNC_E2EE_WRONG_PASSWORD_CODE);
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('atomically replaces the downloaded ciphertext with the decrypted ZIP', async () => {
    const dir = await tempDir('download-decrypt-success-');
    const path = join(dir, 'encrypted.zip');
    const plaintext = Buffer.from('PK\x03\x04decrypted payload');
    await writeFile(path, Buffer.from(await backup.encryptBackup(plaintext, 'pw')));
    await finishDownloadedObject(policy(path, { encryptionPassword: 'pw' }));
    expect((await readFile(path)).equals(plaintext)).toBe(true);
  });
});

describe('cloud_sync_upload command workflow (P07 cleanup order)', () => {
  function tempEntryCount(dir: string): number {
    return readdirSync(dir).filter(name => name.startsWith('.cloud-upload-')).length;
  }

  function progressRecorder(dir: string, events: string[]): CloudProgress {
    return {
      transferring(_operationId, _operation, _stageLabel, done, total) {
        events.push(`transferring:${done}/${total}`);
      },
      done(_operationId, _operation, _stageLabel, bytes) {
        // Snapshot the directory exactly when the success event is emitted.
        events.push(`done:${bytes}:temp=${tempEntryCount(dir)}`);
      },
    };
  }

  function uploadResult(): Awaited<ReturnType<CloudSyncManager['uploadWithProgress']>> {
    return {
      version: {
        id: 'v1', timestamp: '2026-01-01T00:00:00Z', size: 4,
        checksum: 'a'.repeat(64), deviceId: 'device-a',
      },
      prunedVersions: [],
    };
  }

  it('removes the encrypted temp file before emitting done', async () => {
    const dir = await tempDir('upload-workflow-success-');
    const source = join(dir, 'backup.zip');
    await writeFile(source, Buffer.from('PK\x03\x04payload'));
    const events: string[] = [];
    let tempDuringUpload = -1;
    const manager = {
      async enforceEncryptionPolicyBeforeUploadWithPassword(): Promise<void> {},
      async uploadWithProgress(
        _path: string, _appVersion: string | null, _note: string | null, _recoveryKind: string | null,
        callback: ((done: number, total: number) => void) | null,
      ) {
        tempDuringUpload = tempEntryCount(dir);
        callback?.(4, 4);
        return uploadResult();
      },
    } as unknown as CloudSyncManager;

    const result = await runUploadCommand({
      manager,
      backup,
      sourcePath: source,
      appVersion: null,
      note: null,
      recoveryKind: null,
      encryptionPassword: 'pw',
      operationId: 'op-1',
      progress: progressRecorder(dir, events),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    expect(result.version.id).toBe('v1');
    expect(tempDuringUpload).toBe(1);
    expect(events.at(-1)).toMatch(/^done:\d+:temp=0$/);
    expect(tempEntryCount(dir)).toBe(0);
  });

  it('removes the encrypted temp file and emits no done event on upload failure', async () => {
    const dir = await tempDir('upload-workflow-failure-');
    const source = join(dir, 'backup.zip');
    await writeFile(source, Buffer.from('PK\x03\x04payload'));
    const events: string[] = [];
    const manager = {
      async enforceEncryptionPolicyBeforeUploadWithPassword(): Promise<void> {},
      async uploadWithProgress(): Promise<never> {
        throw new CloudStorageError('Network', 'upload failed');
      },
    } as unknown as CloudSyncManager;

    await expect(runUploadCommand({
      manager,
      backup,
      sourcePath: source,
      appVersion: null,
      note: null,
      recoveryKind: null,
      encryptionPassword: 'pw',
      operationId: 'op-1',
      progress: progressRecorder(dir, events),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    })).rejects.toBeInstanceOf(CloudStorageError);

    expect(events.some(event => event.startsWith('done:'))).toBe(false);
    expect(tempEntryCount(dir)).toBe(0);
  });
});
