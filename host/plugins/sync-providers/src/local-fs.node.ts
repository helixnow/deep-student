/**
 * sync-providers 本地文件端口的桌面实现（`node:fs/promises` / `node:os`）。
 *
 * 只由桌面入口 `host/plugins/sync-providers/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 */
import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import {
  copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ZipFileWriter } from '../../../platform/zip/node/file.ts';
import type { LocalFileHandle, LocalFileStats, LocalFs, LocalZipWriter } from './local-fs.ts';

export const nodeLocalFs: LocalFs = {
  constants: { O_APPEND: constants.O_APPEND, O_CREAT: constants.O_CREAT, O_WRONLY: constants.O_WRONLY },
  tmpDir() {
    try { return tmpdir(); }
    catch { return ''; }
  },
  mkdir: (path, options) => mkdir(path, options),
  mkdtemp: (prefix) => mkdtemp(prefix),
  stat: async (path): Promise<LocalFileStats> => stat(path),
  lstat: async (path): Promise<LocalFileStats> => lstat(path),
  async open(path: string, flags: string | number = 'r', mode?: number): Promise<LocalFileHandle> {
    const handle = await open(path, flags, mode);
    return {
      write: (data, offset, length, position) => handle.write(data, offset ?? 0, length ?? data.length, position ?? null),
      read: (buffer, offset, length, position) => handle.read(buffer, offset ?? 0, length ?? buffer.length, position ?? null),
      writeFile: (data) => handle.writeFile(data),
      sync: () => handle.sync(),
      stat: async () => handle.stat(),
      close: () => handle.close(),
    };
  },
  readFile: (path) => readFile(path).then((data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
  writeFile: (path, data) => writeFile(path, data),
  copyFile: (from, to) => copyFile(from, to),
  link: (from, to) => link(from, to),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  rm: (path, options) => rm(path, options),
  rmdir: (path) => rmdir(path),
  readdir: (path) => readdir(path),
  async createZipWriter(path: string): Promise<LocalZipWriter> {
    const writer = await ZipFileWriter.create(path);
    return {
      addFile: (name, sourcePath) => writer.addFile(name, sourcePath).then(() => undefined),
      finish: (options) => writer.finish(options),
      abort: () => writer.abort(),
    };
  },
  async *readChunks(path: string, highWaterMark: number): AsyncIterable<Uint8Array> {
    for await (const chunk of createReadStream(path, { highWaterMark })) yield chunk as Uint8Array;
  },
};
