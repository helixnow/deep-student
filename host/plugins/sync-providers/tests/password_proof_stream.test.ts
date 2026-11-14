import './local-fs-fixture.ts';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import type { CloudStorageError } from '../src/errors.ts';
import { filesService, setFilesLookup } from '../src/files.ts';
import { provePasswordAgainstExistingBackups, type PasswordProofPorts } from '../src/password_proof.ts';
import { createSyncHost } from './host_fixture.ts';
import { MemoryStorage } from './memory_storage.ts';
import { createNativeBackupHost, type NativeBackupHost } from './native_backup_host.ts';

const PASSWORD = 'team-pw-2026';
const VERSION_ID = 'v-legacy';
const asRoot = process.getuid?.() === 0;

let fixture: NativeBackupHost | undefined;
let backup: BackupCrypto;
let sealedV1: Uint8Array;
const dirs: string[] = [];

beforeAll(async () => {
  fixture = await createNativeBackupHost();
  backup = fixture.backup;
  sealedV1 = await backup.encryptBackup(Buffer.from('legacy v1 payload'), PASSWORD);
});
afterAll(async () => { await fixture?.host.dispose(); });
afterEach(async () => {
  setFilesLookup(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

interface Run { crypto: BackupCrypto; downloaded: string[] }

/** Whole-file path only: `MemoryStorage` has no prefix read. `afterDownload` runs once the object is on disk. */
function ports(afterDownload?: (localDir: string, localPath: string) => Promise<void>): PasswordProofPorts & Run {
  const version = { id: VERSION_ID, timestamp: '2026-01-01T00:00:00Z', size: BigInt(sealedV1.byteLength), checksum: '', deviceId: 'd' };
  const downloaded: string[] = [];
  const crypto: BackupCrypto = {
    ...backup,
    decryptBackupFile: vi.fn(backup.decryptBackupFile),
    decryptBackupStream: vi.fn(backup.decryptBackupStream),
  };
  return {
    crypto,
    downloaded,
    storage: new MemoryStorage(),
    backup: crypto,
    backupObjectKey: id => `backups/${id}.zip`,
    getManifest: async () => ({ version: 1, latest: VERSION_ID, versions: [version], updatedAt: '2026-01-01T00:00:00Z' }),
    downloadVersion: async (_id, localDir) => {
      const localPath = join(localDir, `${VERSION_ID}.zip`);
      await writeFile(localPath, sealedV1);
      downloaded.push(localPath);
      dirs.push(localDir);
      await afterDownload?.(localDir, localPath);
      return { version: { ...version, size: sealedV1.byteLength }, localPath };
    },
  };
}

function nodeFiles(): FilesService {
  return createNodeFiles({ roots: [{ name: 'temp', path: tmpdir() }] });
}

async function failure(promise: Promise<unknown>): Promise<CloudStorageError> {
  try { await promise; }
  catch (error) { return error as CloudStorageError; }
  throw new Error('expected the proof to fail');
}

const trialFailed = (cause: string): string =>
  `云端加密标记为旧版（无密码校验子），升级前，用本机密码试解最新备份 ${VERSION_ID} 未通过：${cause}。`;

describe('sync_manager.rs whole-file password proof through ctx.files', () => {
  it('streams a DSBK v1 backup out of the download without a plaintext temp file', async () => {
    const files = nodeFiles();
    const openRead = vi.spyOn(files, 'openRead');
    const openWrite = vi.spyOn(files, 'openWrite');
    setFilesLookup(() => files);
    const run = ports();

    await expect(provePasswordAgainstExistingBackups(run, PASSWORD, false)).resolves.toBeUndefined();
    expect(openRead.mock.calls.map(([path]) => path)).toEqual(run.downloaded);
    expect(openWrite).not.toHaveBeenCalled();
    expect(run.crypto.decryptBackupFile).not.toHaveBeenCalled();
    expect(run.crypto.decryptBackupStream).toHaveBeenCalledTimes(1);
  });

  it('a wrong password fails with the same text with and without ctx.files', async () => {
    const fallback = await failure(provePasswordAgainstExistingBackups(ports(), 'wrong-pw', false));
    setFilesLookup(nodeFiles);
    const streamed = await failure(provePasswordAgainstExistingBackups(ports(), 'wrong-pw', false));

    expect(fallback.message).toContain(trialFailed('备份解密失败（密码错误或数据损坏）: aead::Error'));
    expect(streamed.message).toBe(fallback.message);
    expect(streamed.value.error_type).toBe('Configuration');
  });

  it.skipIf(asRoot)('an unreadable download reports decrypt_backup_file\'s 打开加密文件失败 in both paths', async () => {
    const lock = async (_dir: string, path: string): Promise<void> => { await chmod(path, 0o000); };
    const fallback = await failure(provePasswordAgainstExistingBackups(ports(lock), PASSWORD, false));
    setFilesLookup(nodeFiles);
    const streamed = await failure(provePasswordAgainstExistingBackups(ports(lock), PASSWORD, false));

    expect(fallback.message).toContain(trialFailed('打开加密文件失败: Permission denied (os error 13)'));
    expect(streamed.message).toBe(fallback.message);
  });

  it.skipIf(asRoot)('RF-W08-password-proof-discards-plaintext: a download directory that refuses new files still proves the password', async () => {
    const readOnly = async (dir: string): Promise<void> => { await chmod(dir, 0o555); };
    const fallback = await failure(provePasswordAgainstExistingBackups(ports(readOnly), PASSWORD, false));
    expect(fallback.message).toContain(trialFailed('创建解密输出失败: Permission denied (os error 13)'));

    setFilesLookup(nodeFiles);
    await expect(provePasswordAgainstExistingBackups(ports(readOnly), PASSWORD, false)).resolves.toBeUndefined();
  });

  it('a temp root that cannot hold the trial directory fails as FileSystem with tempfile\'s path suffix', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'proof-tmpdir-'));
    dirs.push(parent);
    const notADirectory = join(parent, 'file');
    await writeFile(notADirectory, '');
    vi.stubEnv('TMPDIR', notADirectory);
    const run = ports();

    const error = await failure(provePasswordAgainstExistingBackups(run, PASSWORD, false));
    expect(error.value.error_type).toBe('FileSystem');
    expect(error.message).toMatch(new RegExp(
      `^创建试解密临时目录失败: Not a directory \\(os error 20\\) at path "${notADirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/trial-decrypt-[0-9a-f]{16}"$`,
    ));
    expect(run.downloaded).toEqual([]);
  });

  it('the plugin resolves ctx.files at use time and drops the lookup on unload', async () => {
    const sync = await createSyncHost();
    try {
      expect(filesService()).toBeNull();
      const files = nodeFiles();
      sync.host.ctx.provide('files', files);
      expect(filesService()).toBe(files);
      await sync.host.unload('dstu.sync-providers');
      expect(filesService()).toBeNull();
    } finally {
      await sync.dispose();
    }
  });
});
