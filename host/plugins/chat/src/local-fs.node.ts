/**
 * chat 本地文件端口的桌面实现（`node:fs` / `node:os`）。
 *
 * 只由桌面入口 `host/plugins/chat/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import type { FileKind } from '../../../platform/files/api.ts';
import { readZip } from '../../../platform/util/node.ts';
import { isRealUserHomeUnderTest } from '../../../platform/paths/index.ts';
import type { ChatLocalFs, ChatZipArchive, LocalReadHandle, LocalStat, LocalWriteHandle } from './local-fs.ts';

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

export const nodeChatLocalFs: ChatLocalFs = {
  zip: (bytes) => readZip(bytes),
  homeIsUnderTest: (home) => isRealUserHomeUnderTest(home),
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  homeDir() {
    try { return homedir(); }
    catch { return ''; }
  },
  exists: (path) => existsSync(path),
  stat(path): LocalStat {
    const metadata = statSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  statMtimeNs(path) {
    try { return statSync(path, { bigint: true }).mtimeNs; }
    catch { return null; }
  },
  lstat(path): LocalStat {
    const metadata = lstatSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  realpath: (path) => realpathSync.native(path),
  readBytes: (path) => readFileSync(path),
  openRead(path): LocalReadHandle {
    const fd = openSync(path, 'r');
    return {
      // Rust `File::metadata`：以已打开的句柄为准，避免路径在检查后被替换。
      size: () => fstatSync(fd).size,
      read: (buffer) => readSync(fd, buffer, 0, buffer.length, null),
      close: () => { closeSync(fd); },
    };
  },
  openExclusive(path): LocalWriteHandle {
    const fd = openSync(path, 'wx');
    return {
      write: (bytes) => {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      },
      close: () => { closeSync(fd); },
    };
  },
  mkdirp(path) { mkdirSync(path, { recursive: true }); },
  mkdirExclusive(path) {
    try { mkdirSync(path); return true; }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === 'EEXIST') return false;
      throw error;
    }
  },
  writeTextIgnoring(path, text) {
    try { writeFileSync(path, text); return true; }
    catch { return false; }
  },
  writeText(path, text) { writeFileSync(path, text); },
  unlink(path) { unlinkSync(path); },
  removeForce(path) { rmSync(path, { force: true }); },
  removeDirForce(path) { rmSync(path, { recursive: true, force: true }); },
};
