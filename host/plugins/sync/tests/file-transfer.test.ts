import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { encryptUploadObject, downloadFileObject, putFileAndVerifySize, ensureFileUploadEncryptionPolicy } from '../src/file-transfer.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'sync-file-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const real = createBackupCrypto();
const createCipher = vi.fn((password: string) => real.createFileCipherSession(password, { mCost: 8, tCost: 1, pCost: 1 }));
const backup = { ...real, createFileCipherSession: createCipher };
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

it('encrypted_file_upload_reuses_session_and_preserves_payload', async () => {
  createCipher.mockClear();
  const codec = await createPayloadCodec(backup, 'test-password');
  const clone = codec;
  const cipher = await codec.fileCipher();
  expect(await clone.fileCipher()).toBe(cipher);
  const dir = await directory(); const source = join(dir, 'input.bin');
  const plain = Buffer.from('streamed file 数据\n'.repeat(1024)); await writeFile(source, plain);
  const encrypted = await encryptUploadObject(source, clone);
  try {
    expect(encrypted).not.toBeNull();
    expect((await stat(encrypted!.path, { bigint: true })).size).toBe(encrypted!.size);
    expect(hash(await readFile(encrypted!.path))).toBe(encrypted!.sha256);
    const restored = join(dir, 'restored.bin');
    await cipher!.decryptFile(encrypted!.path, restored);
    expect(await readFile(restored)).toEqual(plain);
    expect(createCipher).toHaveBeenCalledTimes(1);
  } finally { await encrypted?.dispose(); codec.dispose(); }
  await expect(stat(encrypted!.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('encrypted download verifies ciphertext and plaintext before replacing the existing target', async () => {
  const sender = await createPayloadCodec(backup, 'password');
  const receiver = await createPayloadCodec(backup, 'password');
  const dir = await directory(); const source = join(dir, 'input'); const target = join(dir, 'target');
  const plain = Buffer.from('file payload'); await writeFile(source, plain); await writeFile(target, 'old');
  const encrypted = (await encryptUploadObject(source, sender))!;
  const bytes = await readFile(encrypted.path);
  const getFile = vi.fn(async (_key: string, dest: string, expected?: string | null) => {
    expect(expected).toBe(encrypted.sha256); await writeFile(dest, bytes); return hash(bytes);
  });
  const storage = { supportsResumableDownload: () => false, getFile } as unknown as CloudStorage;
  try {
    await expect(downloadFileObject(storage, 'key', target, 'incorrect', encrypted.sha256, receiver, () => false, null, '附件'))
      .rejects.toThrow('附件 解密后明文哈希不匹配');
    expect(await readFile(target, 'utf8')).toBe('old');
    await downloadFileObject(storage, 'key', target, hash(plain), encrypted.sha256, receiver, () => false, null, '附件');
    expect(await readFile(target)).toEqual(plain);
    await expect(stat(getFile.mock.calls.at(-1)![1])).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await encrypted.dispose(); sender.dispose(); receiver.dispose(); }
});

it('rejects encrypted files without a password and legacy plaintext when encryption is enabled', async () => {
  const plain = await createPayloadCodec(undefined, null); const encrypted = await createPayloadCodec(backup, 'pw');
  const dir = await directory(); const dest = join(dir, 'target');
  const storage = { getFile: vi.fn() } as unknown as CloudStorage;
  try {
    await expect(downloadFileObject(storage, 'key', dest, null, 'cipher', plain, () => false, null, '文件')).rejects.toThrow('E_SYNC_E2EE_PASSWORD_REQUIRED');
    await expect(downloadFileObject(storage, 'key', dest, null, null, encrypted, () => false, null, '文件')).rejects.toThrow('E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED');
    expect(storage.getFile).not.toHaveBeenCalled();
  } finally { plain.dispose(); encrypted.dispose(); }
});

it('short file uploads cannot publish manifests; cancellation prevents starting a transfer', async () => {
  const storage = { putFile: vi.fn(async () => ''), stat: vi.fn(async () => ({ size: 1 })) } as unknown as CloudStorage;
  await expect(putFileAndVerifySize(storage, 'key', 'path', 2n, null, '工作区数据库', () => false, logger)).rejects.toThrow('不得写入清单');
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('期望=2, 实际=1'));
  vi.mocked(storage.putFile).mockClear();
  await expect(putFileAndVerifySize(storage, 'key', 'path', 2n, null, '工作区数据库', () => true, logger)).rejects.toThrow('cancel');
  expect(storage.putFile).not.toHaveBeenCalled();
});

it('file encryption marker policy fails closed and leaves password verification to the record gate', async () => {
  const storage = { get: vi.fn(async () => Buffer.from('marker')) } as unknown as CloudStorage;
  await expect(ensureFileUploadEncryptionPolicy(storage, true)).resolves.toBeUndefined();
  expect(storage.get).not.toHaveBeenCalled();
  await expect(ensureFileUploadEncryptionPolicy(storage, false)).rejects.toThrow('已拒绝文件级明文上传');
  vi.mocked(storage.get).mockRejectedValueOnce(new Error('offline'));
  await expect(ensureFileUploadEncryptionPolicy(storage, false)).rejects.toThrow('读取云端加密标记失败');
});
