/**
 * chat-pipeline 同步文件端口的桌面实现（`node:fs`）。
 *
 * 只由桌面入口 `host/plugins/chat-pipeline/index.ts` 注入；移动端入口（`mobile.ts`）
 * 不导入本文件，插件本体与端口接口保持可移植。
 */
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { FileKind } from '../../../platform/files/api.ts';
import { LocalFsError, type ChatPipelineLocalFs } from './local-fs.ts';

const CHUNK_BYTES = 64 * 1024;

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

export const nodeChatPipelineLocalFs: ChatPipelineLocalFs = {
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  lstat(path) {
    try { return { kind: kindOf(lstatSync(path)) }; }
    catch (error) {
      if (isNotFound(error)) throw new LocalFsError('missing', String((error as Error).message));
      throw new LocalFsError('io', String((error as Error).message));
    }
  },
  realpath(path) {
    try { return realpathSync(path); }
    catch (error) {
      if (isNotFound(error)) throw new LocalFsError('missing', String((error as Error).message));
      throw new LocalFsError('io', String((error as Error).message));
    }
  },
  isDirectory(path) {
    try { return statSync(path).isDirectory(); }
    catch { return false; }
  },
  readChunks(path, onChunk) {
    let fd: number;
    try { fd = openSync(path, 'r'); }
    catch (error) { throw new LocalFsError('io', String((error as Error).message)); }
    const buffer = new Uint8Array(CHUNK_BYTES);
    try {
      for (;;) {
        let read: number;
        try { read = readSync(fd, buffer, 0, buffer.length, null); }
        catch (error) { throw new LocalFsError('io', String((error as Error).message)); }
        if (read === 0) break;
        onChunk(buffer.slice(0, read));
      }
    } finally { closeSync(fd); }
  },
};
