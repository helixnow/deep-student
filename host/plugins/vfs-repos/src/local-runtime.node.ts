/**
 * vfs-repos 本地运行时端口的桌面实现（`node:fs` / `node:worker_threads`）。
 *
 * 只由桌面入口 `host/plugins/vfs-repos/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import fs, {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { FileKind } from '../../../platform/files/api.ts';
import { retryRenameSync } from '../../../platform/paths/rename-retry.ts';
import { readZip as readZipArchive } from '../../../platform/util/zip.ts';
import type {
  LocalReadHandle, LocalStat, LocalWorkerHandle, LocalWorkerOptions, LocalWriteHandle, VfsReposLocalRuntime,
} from './local-runtime.ts';

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

/** 调用时读取：测试会临时改写 `process.platform` 来走 Windows 的 rename 重试分支。 */
function currentPlatform(): string {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux';
}

export const nodeVfsReposLocalRuntime: VfsReposLocalRuntime = {
  get platform() { return currentPlatform(); },
  exists: (path) => existsSync(path),
  stat(path): LocalStat {
    const metadata = statSync(path);
    return { kind: kindOf(metadata), size: metadata.size, mtimeMs: metadata.mtimeMs };
  },
  lstat(path): LocalStat {
    const metadata = lstatSync(path);
    return { kind: kindOf(metadata), size: metadata.size, mtimeMs: metadata.mtimeMs };
  },
  realpath: (path) => realpathSync.native(path),
  readFile: (path) => readFileSync(path),
  appendFile(path, bytes) { writeFileSync(path, bytes, { flag: 'a' }); },
  mkdirp(path) { mkdirSync(path, { recursive: true }); },
  // 经默认导入取 `renameSync`：测试用它替换 `node:fs` 的同名方法观察重试次数。
  rename(from, to) { retryRenameSync(currentPlatform(), () => fs.renameSync(from, to)); },
  remove(path) { rmSync(path); },
  removeForce(path) { rmSync(path, { force: true }); },
  removeDirForce(path) { rmSync(path, { recursive: true, force: true }); },
  readdir: (path) => readdirSync(path),
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
  openRead(path): LocalReadHandle {
    const fd = openSync(path, 'r');
    // Rust `File::metadata`：以已打开的句柄为准，避免路径在检查后被替换。
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
  readZip: (bytes) => readZipArchive(bytes),
  sleepSync(milliseconds) {
    if (milliseconds <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
  spawnWorker(options: LocalWorkerOptions): LocalWorkerHandle {
    const worker = new Worker(new URL('./worker-entry.ts', import.meta.url), {
      workerData: { dbPath: options.dbPath, deviceId: options.deviceId },
    });
    return {
      postMessage: (message) => { worker.postMessage(message); },
      onMessage: (listener) => { worker.on('message', listener); },
      onError: (listener) => { worker.on('error', listener); },
      onExit: (listener) => { worker.on('exit', (code) => { listener(code); }); },
      terminate: async () => { await worker.terminate(); },
    };
  },
};
