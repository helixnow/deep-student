/**
 * anki 本地运行时端口的桌面实现（`node:fs` / `node:zlib` / `node:net`）。
 *
 * 只由桌面入口 `host/plugins/anki/index.ts` 注入；移动端入口（`mobile.ts`）不导入本文件。
 * 文件名空间（`fs.readFileSync` 等）按属性访问，测试用 `vi.spyOn(fs, ...)` 替换时同样生效。
 */
import fs from 'node:fs';
import * as zlib from 'node:zlib';
import net from 'node:net';
import { copyFileVerified } from '../../../platform/storage/node.ts';
import type { FileKind } from '../../../platform/files/api.ts';
import type { AnkiLocalRuntime, LocalStat, LocalTcpError } from './local-runtime.ts';

/** `node:zlib` 的 zstd 同步解压（Node ≥ 22.15 / 24）。仓库 `@types/node` 仍是 20，这里按最小结构取用。 */
const zstdDecompressSync = (zlib as unknown as {
  zstdDecompressSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
}).zstdDecompressSync;

function kindOf(metadata: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symlink';
  return 'other';
}

/** `TcpStream::connect_timeout`：连通返回 null，失败返回带 `code` 的错误。 */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<LocalTcpError | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ message: 'connection timed out', code: 'ETIMEDOUT' });
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(null); });
    socket.once('error', (error: LocalTcpError) => { clearTimeout(timer); socket.destroy(); resolve(error); });
  });
}

export const nodeAnkiLocalRuntime: AnkiLocalRuntime = {
  exists: (path) => fs.existsSync(path),
  stat(path): LocalStat {
    const metadata = fs.statSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  lstat(path): LocalStat {
    const metadata = fs.lstatSync(path);
    return { kind: kindOf(metadata), size: metadata.size };
  },
  realpath: (path) => fs.realpathSync.native(path),
  readBytes: (path) => fs.readFileSync(path),
  writeBytes(path, bytes, options) {
    if (options?.exclusive === true) fs.writeFileSync(path, bytes, { flag: 'wx' });
    else fs.writeFileSync(path, bytes);
  },
  writeText(path, text) { fs.writeFileSync(path, text); },
  mkdirp(path) { fs.mkdirSync(path, { recursive: true }); },
  rename(from, to) { fs.renameSync(from, to); },
  remove(path) { fs.rmSync(path, { force: true }); },
  removeDir(path) { fs.rmSync(path, { recursive: true, force: true }); },
  readBundledText(name) {
    return fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8');
  },
  writeFile: (path, text) => fs.promises.writeFile(path, text, 'utf8'),
  mkdirpAsync: async (path) => { await fs.promises.mkdir(path, { recursive: true }); },
  removeAsync: async (path) => { await fs.promises.rm(path, { force: true }); },
  copyFileVerified: async (source, destination) => { await copyFileVerified(source, destination); },
  deflateRaw: (bytes) => zlib.deflateRawSync(bytes),
  inflateRaw: (bytes, maxOutputLength) => maxOutputLength === undefined
    ? zlib.inflateRawSync(bytes)
    : zlib.inflateRawSync(bytes, { maxOutputLength }),
  zstdDecompress: (bytes, maxOutputLength) => maxOutputLength === undefined
    ? zstdDecompressSync(bytes)
    : zstdDecompressSync(bytes, { maxOutputLength }),
  probeTcp,
};
