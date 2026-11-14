/**
 * agent-orchestration 本地运行时端口的桌面实现（`node:fs` / `node:os`）。
 *
 * 只由桌面入口 `host/plugins/agent-orchestration/index.ts` 注入；移动端入口不导入本文件。
 */
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import type { FileKind } from '../../../platform/files/api.ts';
import type { LocalNodeRuntime, LocalNodeStat, LocalNodeWriteHandle } from './local-node-runtime.ts';

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

export const nodeLocalNodeRuntime: LocalNodeRuntime = {
  hostname: () => {
    try { return osHostname(); }
    catch { return 'local'; }
  },
  pid: () => (globalThis as { process?: { pid?: number } }).process?.pid ?? 0,
  exists: (path) => existsSync(path),
  lstat(path): LocalNodeStat {
    return { kind: kindOf(lstatSync(path)) };
  },
  lstatBig(path) {
    const metadata = lstatSync(path, { bigint: true });
    return { kind: kindOf(metadata), size: Number(metadata.size), mtimeNs: metadata.mtimeNs };
  },
  mkdirp(path) { mkdirSync(path, { recursive: true }); },
  readBytes(path) { return readFileSync(path); },
  readDir(path) {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
  },
  readDirRawNames(path) { return readdirSync(path, { encoding: 'buffer' }); },
  openExclusive(path): LocalNodeWriteHandle {
    const fd = openSync(path, 'wx');
    return {
      write: (bytes) => { writeSync(fd, bytes); },
      sync: () => { fsyncSync(fd); },
      close: () => { closeSync(fd); },
    };
  },
  rename(from, to) { renameSync(from, to); },
  unlink(path) { unlinkSync(path); },
  removeForce(path) { rmSync(path, { force: true }); },
};
