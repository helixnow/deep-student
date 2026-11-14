/** File-level E2EE and verified transfers, sync/mod.rs:998,2640,10273-10460. */
import { dirname, join } from '../../../platform/util/path.ts';
import {
  calculateFileHash, cleanupStaleParts, contentKeyedPartPath, getFileWithOptionalResume,
  persistDownload, isCloudRateLimited, SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE, SYNC_E2EE_WRONG_PASSWORD_CODE,
  type CloudStorage, type UploadProgressCallback,
} from '../../sync-providers/api.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import type { FilePayloadCodec } from './payload.ts';
import type { SyncLogger } from './log.ts';
import { SyncError } from './errors.ts';
import { fs } from './local-runtime.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const database = (text: string) => new SyncError(`Database error: ${text}`);
const network = (text: string) => new SyncError(`Network error: ${text}`);

/** Rust TempPath Drop and explicitly ignored remove_file; never mask a prior error. */
async function removeTemporary(path: string, recursive = false): Promise<void> {
  try { await fs.rm(path, { force: true, recursive }); }
  catch { // boundary-allow empty-catch: TempPath Drop and let _ = remove_file ignore cleanup errors in mod.rs:10459.
  }
}

export async function ensureFileUploadEncryptionPolicy(storage: CloudStorage, encrypted: boolean): Promise<void> {
  if (encrypted) return;
  let marker;
  try { marker = await storage.get('.encryption-marker'); }
  catch (error) { throw network(`读取云端加密标记失败，无法确认加密策略，已停止文件级上传（fail-closed）: ${message(error)}`); }
  if (marker !== null) throw database(`[${SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE}] ` +
    '云端根目录已存在端到端加密标记（.encryption-marker），但本机未配置加密密码。' +
    '为避免明文文件与加密数据混布，已拒绝文件级明文上传。' +
    '请在云同步设置里填入该根目录既有的加密密码后重试，或改用一个全新的云端根目录。');
}

export interface EncryptedUploadObject {
  path: string;
  sha256: string;
  size: bigint;
  dispose(): Promise<void>;
}

export async function encryptUploadObject(path: string, codec: FilePayloadCodec): Promise<EncryptedUploadObject | null> {
  if (!codec.encrypted) return null;
  const cipher = await codec.fileCipher();
  if (cipher === null) return null;
  let dir;
  try { dir = await fs.mkdtemp(join(fs.tmpDir(), 'dsbk-up-')); }
  catch (error) { throw database(`创建加密临时文件失败: ${ioMessage(error)}`); }
  const encrypted = join(dir, 'payload.tmp');
  try {
    try { await cipher.encryptFile(path, encrypted); }
    catch (error) { throw database(`加密上传对象失败 ${JSON.stringify(path)}: ${message(error)}`); }
    let sha256;
    try { sha256 = await calculateFileHash(encrypted); }
    catch (error) { throw database(`计算密文哈希失败: ${message(error)}`); }
    let size;
    try { size = (await fs.statBig(encrypted)).size; }
    catch (error) { throw database(`读取密文大小失败: ${ioMessage(error)}`); }
    return { path: encrypted, sha256, size, dispose: () => removeTemporary(dir, true) };
  } catch (error) { await removeTemporary(dir, true); throw error; }
}

export async function putFileAndVerifySize(
  storage: CloudStorage, key: string, path: string, expected: bigint, progress: UploadProgressCallback | null,
  context: string, isCancelled: () => boolean, logger: SyncLogger,
): Promise<void> {
  if (isCancelled()) throw new SyncError('Sync cancelled by user');
  try { await storage.putFile(key, path, progress); }
  catch (error) { throw network(`${context} 上传失败: ${message(error)}`); }
  let info;
  try { info = await storage.stat(key); }
  catch (error) {
    if (isCloudRateLimited(message(error))) throw network(message(error));
    logger.warn(`[sync] 上传 size 回验 stat 失败: key=${key}, err=${message(error)}`);
    throw network(`${context} 上传后大小不一致或对象不存在，已停止并不得写入清单`);
  }
  if (info !== null && BigInt(info.size) === expected) return;
  if (info === null) logger.warn(`[sync] 上传后对象不存在（回验失败）: key=${key}`);
  else logger.warn(`[sync] 上传 size 回验不符: key=${key}, 期望=${expected}, 实际=${info.size}`);
  throw network(`${context} 上传后大小不一致或对象不存在，已停止并不得写入清单`);
}

export async function downloadFileObject(
  storage: CloudStorage, key: string, dest: string, expectedPlain: string | null, expectedCipher: string | null,
  codec: FilePayloadCodec, isCancelled: () => boolean, progress: UploadProgressCallback | null, label: string,
): Promise<void> {
  if (isCancelled()) throw new SyncError('Sync cancelled by user');
  if (expectedCipher === null) {
    if (codec.encrypted) throw database(`[${SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE}] ` +
      `${label} 的云端条目是启用加密前的明文对象（缺少 cipher_sha256），` +
      '本端已启用端到端加密，为防止密文被明文静默替换已拒绝下载。' +
      '处理办法：在仍持有该数据的设备上配置同一加密密码并执行一次上传同步' +
      '（会自动把该对象重新加密上传）；或暂时清除本端加密密码取回旧明文数据后，' +
      '重新配置密码并执行一次完整上传。');
    if (storage.supportsResumableDownload()) {
      const part = contentKeyedPartPath(dest, expectedPlain ?? 'unknown');
      await cleanupStaleParts(dest, part);
      try { await getFileWithOptionalResume(storage, key, part, expectedPlain, progress); }
      catch (error) { throw network(`下载 ${label} 失败: ${message(error)}`); }
      try { await persistDownload(part, dest); }
      catch (error) { throw database(`保存 ${label} 失败: ${message(error)}`); }
    } else {
      try { await storage.getFile(key, dest, expectedPlain, progress); }
      catch (error) { throw network(`下载 ${label} 失败: ${message(error)}`); }
    }
    return;
  }
  const cipher = await codec.fileCipher();
  if (cipher === null) throw database(`[${SYNC_E2EE_PASSWORD_REQUIRED_CODE}] ` +
    `${label} 的云端对象已端到端加密（存在 cipher_sha256），但本端未配置加密密码，` +
    '无法解密。请在云同步设置中填入正确的加密密码后重试。');
  const parent = dirname(dest);
  if (parent === '.' && !dest.includes('/') && !dest.includes('\\')) throw database(`下载目标路径非法: ${JSON.stringify(dest)}`);
  try { await fs.mkdir(parent, { recursive: true }); }
  catch (error) { throw database(`创建下载目录失败: ${ioMessage(error)}`); }
  const part = contentKeyedPartPath(dest, expectedCipher);
  await cleanupStaleParts(dest, part);
  try { await getFileWithOptionalResume(storage, key, part, expectedCipher, progress); }
  catch (error) { throw network(`下载加密对象 ${label} 失败: ${message(error)}`); }
  const plain = join(parent, `.dsbk-pt-${globalThis.crypto.randomUUID()}.tmp`);
  try {
    try { const file = await fs.open(plain, 'wx', 0o600); await file.close(); }
    catch (error) { throw database(`创建解密临时文件失败: ${ioMessage(error)}`); }
    try { await cipher.decryptFile(part, plain); }
    catch (error) { throw database(`[${SYNC_E2EE_WRONG_PASSWORD_CODE}] 解密 ${label} 失败（密码不一致或数据损坏）: ${message(error)}`); }
    if (expectedPlain !== null) {
      let actual;
      try { actual = await calculateFileHash(plain); }
      catch (error) { throw database(`计算 ${label} 明文哈希失败: ${message(error)}`); }
      if (actual !== expectedPlain) throw database(`${label} 解密后明文哈希不匹配: 期望 ${expectedPlain}, 实际 ${actual}`);
    }
    try { await fs.rename(plain, dest); }
    catch (error) { throw database(`替换 ${label} 目标文件失败: ${ioMessage(error)}`); }
    await removeTemporary(part);
  } finally { await removeTemporary(plain); }
}
