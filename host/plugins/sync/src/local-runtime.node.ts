/**
 * sync 本地运行时端口的桌面实现（`node:fs` / `node:fs/promises` / `node:os`）。
 *
 * 只由桌面入口 `host/plugins/sync/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync,
  statSync, writeSync,
} from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { LocalAsyncHandle, LocalBigStats, LocalPath, LocalRuntime, LocalStats } from './local-runtime.ts';

export const nodeLocalRuntime: LocalRuntime = {
  existsSync: (path) => existsSync(path as never),
  statSync: (path: LocalPath): LocalStats => statSync(path as never),
  statBigSync: (path: LocalPath): LocalBigStats => statSync(path as never, { bigint: true }) as unknown as LocalBigStats,
  lstatSync: (path: LocalPath): LocalStats => lstatSync(path as never),
  readdirSync: (path: LocalPath) => readdirSync(path as never),
  readdirSyncRaw: (path: LocalPath) => readdirSync(path as never, { encoding: 'buffer' }),
  mkdirSync: (path, options) => mkdirSync(path, options),
  rmSync: (path, options) => rmSync(path, options),
  copyFileSync: (from, to) => copyFileSync(from, to),
  readFileSync: (path) => readFileSync(path),
  openSync: (path, flags) => openSync(path, flags as 'w'),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  closeSync: (fd) => closeSync(fd),
  tmpDir() {
    try { return tmpdir(); }
    catch { return ''; }
  },
  mkdtemp: (prefix) => mkdtemp(prefix),
  mkdir: (path, options) => mkdir(path, options),
  stat: async (path) => stat(path),
  statBig: async (path) => stat(path, { bigint: true }) as unknown as LocalBigStats,
  rename: (from, to) => rename(from, to),
  rm: (path, options) => rm(path, options),
  writeFile: (path, data) => writeFile(path, data),
  async open(path: string, flags: string, mode?: number): Promise<LocalAsyncHandle> {
    const handle = await open(path, flags, mode);
    return { close: () => handle.close() };
  },
};
