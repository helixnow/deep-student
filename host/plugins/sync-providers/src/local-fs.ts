/**
 * sync-providers 的本地文件系统端口（异步 `node:fs/promises` 形状）。
 *
 * 云传输的落地/续传/增量归档都要读写真实路径上的文件（本地缓存对象、断点文件、临时归档）。移动端没有
 * 可用的本地路径语义，因此这一层用端口隔离：桌面入口 `index.ts` 注入 `node:fs/promises` / `node:os`
 * 实现（`local-fs.node.ts`），移动端入口（`mobile.ts`）不注入——缺省端口没有本地文件系统，
 * 走磁盘的传输与归档按 `FileSystem` 错误降级，内存对象（`put` / `get`）与纯逻辑不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），调用方保留原有的 Rust `ioError` 文案与 `try/catch` 分支。
 */
import type { ZipByteSink, ZipByteSource } from '../../../platform/zip/core/index.ts';

export interface LocalFileStats {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `open()` 的句柄；参数形状与 Node `FileHandle` 相同（省略 position 时用当前文件偏移）。 */
export interface LocalFileHandle {
  write(data: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number }>;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number }>;
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<LocalFileStats>;
  close(): Promise<void>;
}

export interface LocalFs {
  /** `fs.constants` 里用到的位；移动端缺省端口给 0。 */
  readonly constants: { readonly O_APPEND: number; readonly O_CREAT: number; readonly O_WRONLY: number };
  /** `os.tmpdir()`；取不到时为空串。 */
  tmpDir(): string;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  /** `fs.mkdtemp(prefix)`：前缀可直接带目录。 */
  mkdtemp(prefix: string): Promise<string>;
  stat(path: string): Promise<LocalFileStats>;
  lstat(path: string): Promise<LocalFileStats>;
  /** `fs.promises.open(path, flags, mode)`。 */
  open(path: string, flags?: string | number, mode?: number): Promise<LocalFileHandle>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  /** `fs.link`：硬链接（恢复时把验证过的文件挂到目标名）。 */
  link(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** `fs.rmdir`：只删空目录。 */
  rmdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** `createReadStream(path, { highWaterMark })` 的异步迭代：按块读取文件内容。 */
  readChunks(path: string, highWaterMark: number): AsyncIterable<Uint8Array>;
  /** 直接写目标文件的流式 ZIP 写入器（`platform/zip` 的文件适配层）；移动端缺省端口不可用。 */
  createZipWriter(path: string): Promise<LocalZipWriter>;
}

/** `platform/zip/node/file.ts` 的 `ZipFileWriter` 在端口里的结构形状。 */
export interface LocalZipWriter {
  addFile(name: string, sourcePath: string): Promise<void>;
  finish(options?: { sync?: boolean }): Promise<number>;
  abort(): Promise<void>;
}

export class LocalFsUnavailableError extends Error {
  constructor(operation: string) {
    super(`local filesystem unavailable: ${operation}`);
    this.name = 'LocalFsUnavailableError';
  }
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: LocalFs = {
  constants: { O_APPEND: 0, O_CREAT: 0, O_WRONLY: 0 },
  tmpDir: () => '',
  mkdir: async (path) => { throw new LocalFsUnavailableError(`mkdir ${path}`); },
  mkdtemp: async (prefix) => { throw new LocalFsUnavailableError(`mkdtemp ${prefix}`); },
  stat: async (path) => { throw new LocalFsUnavailableError(`stat ${path}`); },
  lstat: async (path) => { throw new LocalFsUnavailableError(`lstat ${path}`); },
  open: async (path) => { throw new LocalFsUnavailableError(`open ${path}`); },
  readFile: async (path) => { throw new LocalFsUnavailableError(`read ${path}`); },
  writeFile: async (path) => { throw new LocalFsUnavailableError(`write ${path}`); },
  copyFile: async (from) => { throw new LocalFsUnavailableError(`copy ${from}`); },
  link: async (from) => { throw new LocalFsUnavailableError(`link ${from}`); },
  rename: async (from) => { throw new LocalFsUnavailableError(`rename ${from}`); },
  unlink: async (path) => { throw new LocalFsUnavailableError(`unlink ${path}`); },
  rm: async (path) => { throw new LocalFsUnavailableError(`remove ${path}`); },
  rmdir: async (path) => { throw new LocalFsUnavailableError(`rmdir ${path}`); },
  readdir: async (path) => { throw new LocalFsUnavailableError(`readdir ${path}`); },
  // eslint-disable-next-line require-yield
  readChunks: async function* (path): AsyncIterable<Uint8Array> { throw new LocalFsUnavailableError(`read ${path}`); },
  createZipWriter: async (path) => { throw new LocalFsUnavailableError(`zip ${path}`); },
};

let active: LocalFs = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setLocalFs(port: LocalFs | null): void {
  active = port ?? unavailable;
}

/** 当前端口；所有按路径的云同步文件访问都经它。 */
export function localFs(): LocalFs {
  return active;
}

/**
 * 稳定门面：调用方直接写 `fs.mkdir(...)`，实现由入口注入（`setLocalFs`）。
 * 这里只做转发，不改写错误与返回值。
 */
export const fs: LocalFs = {
  get constants() { return active.constants; },
  tmpDir: () => active.tmpDir(),
  mkdir: (path, options) => active.mkdir(path, options),
  mkdtemp: (prefix) => active.mkdtemp(prefix),
  stat: (path) => active.stat(path),
  lstat: (path) => active.lstat(path),
  open: (path, flags, mode) => active.open(path, flags, mode),
  readFile: (path) => active.readFile(path),
  writeFile: (path, data) => active.writeFile(path, data),
  copyFile: (from, to) => active.copyFile(from, to),
  link: (from, to) => active.link(from, to),
  rename: (from, to) => active.rename(from, to),
  unlink: (path) => active.unlink(path),
  rm: (path, options) => active.rm(path, options),
  rmdir: (path) => active.rmdir(path),
  readdir: (path) => active.readdir(path),
  readChunks: (path, highWaterMark) => active.readChunks(path, highWaterMark),
  createZipWriter: (path) => active.createZipWriter(path),
};

/** 把端口的随机读写句柄接到可移植 ZIP 核心上（`ZipByteSource` / `ZipByteSink`）。 */
export function handleZipSource(handle: LocalFileHandle, size: number): ZipByteSource {
  return {
    size,
    async read(position, length) {
      const buffer = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled === length ? buffer : buffer.subarray(0, filled);
    },
  };
}

export function handleZipSink(handle: LocalFileHandle): ZipByteSink {
  return {
    async write(data, position) {
      let written = 0;
      while (written < data.length) {
        const { bytesWritten } = await handle.write(data, written, data.length - written, position + written);
        if (bytesWritten <= 0) throw new Error('ZIP write made no progress');
        written += bytesWritten;
      }
    },
  };
}
