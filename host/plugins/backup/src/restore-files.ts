/** `backup/mod.rs::prepare_backup_restore_destination`。 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync,
} from 'node:fs';
import { copyFile, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateSafeRelativePath } from './manifest.ts';
import { ioMessage } from './io.ts';

export function prepareBackupRestoreDestination(root: string, relative: string): string {
  mkdirSync(root, { recursive: true });
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`恢复目标根路径必须是普通目录: ${root}`);
  }
  validateSafeRelativePath(relative);
  const components = relative.split(/[\\/]/);
  let current = root;
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    current = join(current, component);
    const isLast = index + 1 === components.length;
    let metadata;
    try { metadata = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!isLast) mkdirSync(current);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`恢复目标路径不允许包含符号链接: ${relative}`);
    }
    if (!isLast && !metadata.isDirectory()) {
      throw new Error(`恢复目标父路径不是目录: ${current}`);
    }
    if (isLast && !metadata.isFile()) {
      throw new Error(`恢复目标不是普通文件: ${current}`);
    }
  }
  mkdirSync(dirname(current), { recursive: true });
  return current;
}

const HASH_CHUNK_BYTES = 1 << 20;

/** `calculate_file_sha256_exact`（固定读取 expectedSize 字节；分块读取，不受 2 GiB 整读上限影响）。 */
export function sha256FileExact(path: string, expectedSize: number): string {
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = new Uint8Array(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      hash.update(buffer.subarray(0, read));
    }
    if (total !== expectedSize) throw new Error(`文件大小不匹配: expected=${expectedSize}, actual=${total}`);
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** {@link sha256FileExact} 的异步版本：恢复消费路径用，不阻塞 Host 事件循环。 */
export async function sha256FileExactAsync(path: string, expectedSize: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = new Uint8Array(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expectedSize) throw new Error(`文件大小不匹配: expected=${expectedSize}, actual=${total}`);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function verifyRestoredFile(
  domainId: string,
  file: { path: string; size: number; sha256: string | null },
  destination: string,
): Promise<void> {
  const size = (await stat(destination)).size;
  if (size !== file.size) {
    throw new Error(
      `域 ${domainId} 文件恢复后大小不匹配 ${file.path}: expected=${file.size}, actual=${size}`,
    );
  }
  if (file.sha256 !== null) {
    const actual = await sha256FileExactAsync(destination, file.size);
    if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
      throw new Error(`域 ${domainId} 文件恢复后 SHA-256 不匹配: ${file.path}`);
    }
  }
}

export async function copyVerified(
  source: string,
  destination: string,
  domainId: string,
  file: { path: string; size: number; sha256: string | null },
): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    throw new Error(`域 ${domainId} 文件复制失败 ${file.path}: ${ioMessage(error)}`);
  }
  await verifyRestoredFile(domainId, file, destination);
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}
