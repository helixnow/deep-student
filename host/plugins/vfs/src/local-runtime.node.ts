/**
 * vfs 本地运行时端口的桌面实现（`node:fs` / `node:fs/promises` / `node:os`）。
 *
 * 只由桌面入口 `host/plugins/vfs/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import {
  closeSync, copyFileSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { renameSyncWithRetry } from '../../../platform/util/durable-fs.ts';
import { takeStagedUpload, type StagedFile } from '../../../platform/storage/staged-upload.ts';
import type {
  LocalAsyncHandle, LocalBigStats, LocalDirent, LocalPath, LocalRuntime, LocalStats,
} from './local-runtime.ts';

export const nodeLocalRuntime: LocalRuntime = {
  existsSync: (path) => existsSync(path as never),
  readFileSync: (path: string) => readFileSync(path),
  writeFileSync: (path, data) => writeFileSync(path, data),
  mkdirSync: (path, options) => mkdirSync(path, options),
  rmSync: (path, options) => rmSync(path, options),
  renameSync: (from, to) => renameSync(from, to),
  renameSyncWithRetry: (from, to) => renameSyncWithRetry(from, to),
  statSync: (path: LocalPath): LocalStats => statSync(path as never),
  statBigSync: (path: LocalPath): LocalBigStats => statSync(path as never, { bigint: true }) as unknown as LocalBigStats,
  lstatSync: (path: LocalPath): LocalStats => lstatSync(path as never),
  realpathSync: (path) => realpathSync.native(path),
  readdirSync: (path) => readdirSync(path),
  readdirDirentsSync: (path): LocalDirent[] => readdirSync(path, { withFileTypes: true }),
  openSync: (path, flags, mode) => openSync(path, flags as 'r', mode),
  readSync: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  closeSync: (fd) => closeSync(fd),
  fstatSync: (fd): LocalStats => fstatSync(fd),
  copyFileSync: (from, to) => copyFileSync(from, to),
  tmpDir() {
    try { return tmpdir(); }
    catch { return ''; }
  },
  homeDir() {
    try { return homedir(); }
    catch { return ''; }
  },
  mkdtemp: (prefix) => mkdtemp(prefix),
  statBig: async (path: string) => stat(path, { bigint: true }) as unknown as LocalBigStats,
  async open(path: string, flags: string): Promise<LocalAsyncHandle> {
    const handle = await open(path, flags as 'r');
    return {
      stat: async () => handle.stat(),
      read: (buffer, offset = 0, length = buffer.byteLength, position = null) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
  writeFile: (path, data) => writeFile(path, data),
  async readFileBounded(path: string, maxBytes: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of createReadStream(path, { end: maxBytes })) {
      const bytes = chunk as Uint8Array;
      chunks.push(bytes);
      length += bytes.byteLength;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  },
  rm: (path, options) => rm(path, options),
  deviceIdEnv() {
    const process_ = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = process_?.env?.DEVICE_ID;
    return value === undefined || value === '' ? null : value;
  },
  takeStagedUpload: (uploadId): StagedFile => takeStagedUpload(uploadId),
};
