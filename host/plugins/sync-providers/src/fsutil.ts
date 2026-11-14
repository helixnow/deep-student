/** Filesystem helpers shared by the transports; all errors surface as CloudStorageError. */

import { dirname, join } from '../../../platform/util/path.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { fs, type LocalFileHandle } from './local-fs.ts';
import { randomHex } from './random.ts';

export interface OpenFile {
  write(data: Uint8Array): Promise<void>;
  /** Read into `buffer` at `offset`, up to `length` bytes; returns bytes read (0 = EOF). */
  read(buffer: Uint8Array, offset: number, length: number): Promise<number>;
  /** `flush()` + `sync_all()` (webdav.rs:1336-1341). */
  sync(): Promise<void>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
  remove(): Promise<void>;
}

export async function createDirAll(path: string, failurePrefix: string): Promise<void> {
  try { await fs.mkdir(path, { recursive: true }); }
  catch (error) { throw new CloudStorageError('FileSystem', `${failurePrefix}: ${ioError(error)}`); }
}

export async function statFile(path: string): Promise<{ size: number }> {
  const info = await fs.stat(path);
  return { size: info.size };
}

export async function randomTempName(nearPath: string, prefix: string, suffix: string): Promise<string> {
  const dir = dirname(nearPath);
  const name = `${prefix}${randomHex(8)}${suffix}`;
  return join(dir, name);
}

export async function openFile(path: string, mode: 'r' | 'w' | 'a'): Promise<OpenFile> {
  let handle: LocalFileHandle;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    handle = await fs.open(path, mode === 'a' ? fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY : mode === 'w' ? 'w' : 'r');
  } catch (error) {
    throw new CloudStorageError('FileSystem', `${mode === 'r' ? '打开文件失败' : '创建文件失败'}: ${ioError(error)}`);
  }
  return {
    async write(data) {
      try { await handle.write(data); }
      catch (error) { throw new CloudStorageError('FileSystem', `写入文件失败: ${ioError(error)}`); }
    },
    async read(buffer, offset, length) {
      try {
        const { bytesRead } = await handle.read(buffer, offset, length, null);
        return bytesRead;
      } catch (error) { throw new CloudStorageError('FileSystem', `读取文件失败: ${ioError(error)}`); }
    },
    async sync() {
      try { await handle.sync(); }
      catch (error) { throw new CloudStorageError('FileSystem', `同步文件失败: ${ioError(error)}`); }
    },
    async stat() {
      try { const info = await handle.stat(); return { size: info.size }; }
      catch (error) { throw new CloudStorageError('FileSystem', `读取断点文件元信息失败: ${ioError(error)}`); }
    },
    async close() { await handle.close().catch(() => undefined); },
    async remove() { await fs.unlink(path).catch(() => undefined); },
  };
}

/** Rename, falling back to copy+unlink (Windows cannot rename over an existing file). */
export async function renameOver(from: string, to: string): Promise<void> {
  try { await fs.rename(from, to); return; }
  catch {
    try { await fs.copyFile(from, to); }
    catch (error) { throw new CloudStorageError('FileSystem', `保存下载文件失败: ${ioError(error)}`); }
    await fs.unlink(from).catch(() => undefined);
  }
}

export async function isSymlink(path: string): Promise<boolean> {
  try { return (await fs.lstat(path)).isSymbolicLink(); }
  catch { return false; }
}
