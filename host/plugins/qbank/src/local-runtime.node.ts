/**
 * qbank 本地运行时端口的桌面实现（`node:fs` / `node:fs/promises` / `node:zlib`，
 * 虚拟 URI 物化复用 L13 的 `copy_file_verified`）。
 *
 * 只由桌面入口 `host/plugins/qbank/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import type { FileKind } from '../../../platform/files/api.ts';
import { copyFileVerified } from '../../../platform/storage/unified-file-manager.ts';
import type {
  LocalReadHandle, LocalStat, LocalWriteHandle, QbankLocalRuntime,
} from './local-runtime.ts';

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

export const nodeQbankLocalRuntime: QbankLocalRuntime = {
  exists: (path) => existsSync(path),
  stat(path): LocalStat {
    const metadata = statSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  removeFile(path) { unlinkSync(path); },
  writeFile(path, bytes) { writeFileSync(path, bytes); },
  mkdirp(path) { mkdirSync(path, { recursive: true }); },
  readFile: (path) => readFileSync(path),
  openRead(path): LocalReadHandle {
    const fd = openSync(path, 'r');
    let closed = false;
    return {
      size: () => fstatSync(fd).size,
      read: (buffer) => readSync(fd, buffer, 0, buffer.length, null),
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  },
  openWrite(path): LocalWriteHandle {
    const fd = openSync(path, 'w');
    let closed = false;
    return {
      write: (bytes) => {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      },
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  },
  deflateRaw: (bytes) => deflateRawSync(bytes),
  mkdirpAsync: async (path) => { await mkdir(path, { recursive: true }); },
  writeFileAsync: async (path, bytes) => { await writeFile(path, bytes); },
  renameAsync: async (from, to) => { await rename(from, to); },
  copyFileVerified: async (source, target) => { await copyFileVerified(source, target); },
};
