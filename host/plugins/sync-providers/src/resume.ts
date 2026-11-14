import { sha256Hasher } from './hashing.ts';
import { basename, dirname, join } from '../../../platform/util/path.ts';
import type { CloudStorage, DownloadProgressCallback } from '../api.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink } from './logging.ts';

export const RESUMABLE_GET_ATTEMPTS = 3;

export async function destResumeLen(dest: string, remoteSize: number): Promise<number> {
  let metadata;
  try { metadata = await fs.lstat(dest); } catch { return 0; }
  if (!metadata.isSymbolicLink() && metadata.isFile() && metadata.size > 0 && metadata.size <= remoteSize) return metadata.size;
  await Promise.allSettled([fs.unlink(dest)]);
  return 0;
}

export async function getFileWithOptionalResume(storage: CloudStorage, key: string, dest: string, expectedChecksum?: string | null, progress?: DownloadProgressCallback | null): Promise<string> {
  if (!storage.supportsResumableDownload()) return storage.getFile(key, dest, expectedChecksum, progress);
  const info = await storage.stat(key);
  if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESUMABLE_GET_ATTEMPTS; attempt++) {
    const resumeFrom = await destResumeLen(dest, info.size);
    try { await storage.getFileResumable(key, dest, resumeFrom, progress); }
    catch (error) {
      if (error instanceof CloudStorageError && error.message.includes('E_CLOUD_RATE_LIMITED')) throw error;
      lastError = error;
      defaultLogSink().warn(
        `续传下载失败，将按断点重试: attempt=${attempt} resume_from=${resumeFrom} key=${key}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const actual = await calculateFileHash(dest);
    if (expectedChecksum != null && expectedChecksum !== actual) {
      await Promise.allSettled([fs.unlink(dest)]);
      throw new CloudStorageError('Validation', `校验和不匹配: 期望 ${expectedChecksum.slice(0, 8)}, 实际 ${actual.slice(0, 8)}`);
    }
    return actual;
  }
  throw lastError ?? new CloudStorageError('Unknown', '续传下载失败且未留下错误');
}

export async function calculateFileHash(path: string): Promise<string> {
  const file = await fs.open(path, 'r').catch(error => { throw new CloudStorageError('FileSystem', `打开文件计算哈希失败 ${JSON.stringify(path)}: ${ioError(error)}`); });
  const hash = sha256Hasher();
  try {
    const buffer = new Uint8Array(8192);
    for (;;) {
      const { bytesRead } = await file.read(buffer).catch(error => { throw new CloudStorageError('FileSystem', `读取文件失败 ${JSON.stringify(path)}: ${ioError(error)}`); });
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
  return hash.digestHex();
}

export function contentKeyedPartPath(dest: string, checksum: string): string {
  const name = basename(dest) || 'object';
  const tag = [...checksum].filter(ch => /^[a-fA-F0-9]$/.test(ch)).slice(0, 16).join('');
  return join(dirname(dest), `.${name}.${tag.length >= 8 ? tag : 'unknown'}.ds-dl.part`);
}

export async function cleanupStaleParts(dest: string, keep: string): Promise<void> {
  const parent = dirname(dest), name = basename(dest);
  if (!name) return;
  let entries: string[];
  try { entries = await fs.readdir(parent); } catch { return; }
  for (const entry of entries) {
    const path = join(parent, entry);
    if (entry.startsWith(`.${name}.`) && entry.endsWith('.ds-dl.part') && path !== keep) {
      await Promise.allSettled([fs.unlink(path)]);
    }
  }
}

export async function persistDownload(part: string, dest: string): Promise<void> {
  if (part === dest) return;
  await fs.mkdir(dirname(dest), { recursive: true }).catch(error => { throw new CloudStorageError('FileSystem', `创建下载目录失败: ${ioError(error)}`); });
  try { await fs.rename(part, dest); }
  catch {
    await fs.copyFile(part, dest).catch(error => { throw new CloudStorageError('FileSystem', `保存下载文件失败: ${ioError(error)}`); });
    await Promise.allSettled([fs.unlink(part)]);
  }
}
