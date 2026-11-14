/**
 * 变换脚本沙箱的桌面文件端口（`node:fs`），只由桌面入口
 * `host/plugins/chatanki/index.ts` 注入；移动端入口不导入本文件。
 */
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { TransformFsPort, TransformFsStat } from './transform-script-fs.ts';
import { TransformFsError } from './transform-script-fs.ts';

function statOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mode: number }): TransformFsStat {
  const kind = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : metadata.isSymbolicLink() ? 'symlink' : 'other';
  return { kind, size: metadata.isFile() ? metadata.size : 0, mode: metadata.mode };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

export const nodeTransformFs: TransformFsPort = {
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  stat(path, followSymlinks) {
    try { return statOf(followSymlinks ? statSync(path) : lstatSync(path)); }
    catch { return null; }
  },
  realpath(path) {
    try { return realpathSync(path); }
    catch { return null; }
  },
  mkdir(path, mode) { mkdirSync(path, { recursive: true, mode }); },
  writeFile(path, bytes, mode) { writeFileSync(path, bytes, { mode }); },
  chmod(path, mode) { chmodSync(path, mode); },
  readBounded(path, limit) {
    let metadata;
    try { metadata = lstatSync(path); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') throw new TransformFsError('missing', String((error as Error).message));
      throw new TransformFsError('io', String((error as Error).message));
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TransformFsError('not_regular');
    if (metadata.size > limit) throw new TransformFsError('too_large', '', metadata.size, limit);
    let fd: number;
    try { fd = openSync(path, 'r'); }
    catch (error) { throw new TransformFsError('io', String((error as Error).message)); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buffer = new Uint8Array(64 * 1024);
    try {
      while (total <= limit) {
        let read: number;
        try { read = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - total), null); }
        catch (error) { throw new TransformFsError('io', String((error as Error).message)); }
        if (read === 0) break;
        chunks.push(buffer.slice(0, read));
        total += read;
      }
    } finally { closeSync(fd); }
    if (total > limit) throw new TransformFsError('too_large', '', total, limit);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  },
};
