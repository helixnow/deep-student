/**
 * vfs 的本地运行时端口（同步 `node:fs` / 异步 `node:fs/promises` / `node:os` / `node:crypto` 的形状）。
 *
 * VFS 直接读写真实路径：blobs 目录、导出临时 ZIP、教程/思维导图导入、附件暂存、资源与 PDF 的协议应答、
 * 回收站清理，以及 blob 落盘的原子替换。这些在 Rust 侧是同步 `std::fs`，移动端没有可用的同步文件 API，
 * 因此这一层用端口隔离：桌面入口 `index.ts` 注入 `node:fs` / `node:fs/promises` 实现
 * （`local-runtime.node.ts`），移动端入口（`mobile.ts`）不注入——缺省端口没有本地文件系统，
 * 走磁盘的指令按 `VfsError`/`Error` 降级，纯 SQLite 的列表、搜索、文件夹能力不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），调用方保留原有的错误文案与 `try/catch` 分支。
 * 只读元数据探测（`existsSync`）在缺省端口返回 false，和 Rust `Path::exists()` 在无权限时一致。
 */
import type { StagedFile } from '../../../platform/storage/staged-upload.ts';

export type LocalPath = string | Uint8Array;

export interface LocalStats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `statSync(path, { bigint: true })`：`size` / `mtimeNs` 按 bigint 精度。 */
export interface LocalBigStats {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `readdirSync(path, { withFileTypes: true })` 的目录项。 */
export interface LocalDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `open(path, 'r')` 的异步句柄。 */
export interface LocalAsyncHandle {
  stat(): Promise<LocalStats>;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface LocalRuntime {
  // ---- 同步（`node:fs`） ----
  existsSync(path: LocalPath): boolean;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  renameSync(from: string, to: string): void;
  /** `platform/util/durable-fs.ts` 的 win32 EPERM/EACCES/EBUSY 退避重命名。 */
  renameSyncWithRetry(from: string, to: string): void;
  statSync(path: LocalPath): LocalStats;
  statBigSync(path: LocalPath): LocalBigStats;
  lstatSync(path: LocalPath): LocalStats;
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
  readdirDirentsSync(path: string): LocalDirent[];
  openSync(path: string, flags: string, mode?: number): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  closeSync(fd: number): void;
  fstatSync(fd: number): LocalStats;
  copyFileSync(from: string, to: string): void;

  // ---- 异步（`node:fs/promises` / `node:os`） ----
  tmpDir(): string;
  /** `os.homedir()`；取不到时为空串。 */
  homeDir(): string;
  mkdtemp(prefix: string): Promise<string>;
  statBig(path: string): Promise<LocalBigStats>;
  open(path: string, flags: string): Promise<LocalAsyncHandle>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /**
   * 读至多 `maxBytes + 1` 字节（多读 1 字节，调用方据此发现文件在读取期间增长），
   * 等价于 `createReadStream(path, { end: maxBytes })` 的全量收集。
   */
  readFileBounded(path: string, maxBytes: number): Promise<Uint8Array>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  // ---- 平台差异（桌面进程环境与分块上传暂存） ----
  /** Rust `std::env::var("DEVICE_ID")`；没有环境变量的平台返回 null。 */
  deviceIdEnv(): string | null;
  /** 分块暂存上传的已登记句柄（`staged_upload` 指令只存在于桌面）。 */
  takeStagedUpload(uploadId: string): Pick<StagedFile, 'path' | 'name' | 'size' | 'readBounded' | 'dispose'>;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local filesystem unavailable: ${operation}`);
    this.name = 'LocalRuntimeUnavailableError';
  }
}

const unavailable = (operation: string): never => { throw new LocalRuntimeUnavailableError(operation); };

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
export const unavailableLocalRuntime: LocalRuntime = {
  existsSync: () => false,
  readFileSync: (path) => unavailable(`read ${path}`),
  writeFileSync: (path) => unavailable(`write ${path}`),
  mkdirSync: (path) => unavailable(`mkdir ${path}`),
  rmSync: () => undefined,
  renameSync: (from) => unavailable(`rename ${from}`),
  renameSyncWithRetry: (from) => unavailable(`rename ${from}`),
  statSync: (path) => unavailable(`stat ${String(path)}`),
  statBigSync: (path) => unavailable(`stat ${String(path)}`),
  lstatSync: (path) => unavailable(`lstat ${String(path)}`),
  realpathSync: (path) => unavailable(`realpath ${path}`),
  readdirSync: (path) => unavailable(`readdir ${path}`),
  readdirDirentsSync: (path) => unavailable(`readdir ${path}`),
  openSync: (path) => unavailable(`open ${path}`),
  readSync: () => unavailable('read'),
  writeSync: () => unavailable('write'),
  closeSync: () => undefined,
  fstatSync: () => unavailable('fstat'),
  copyFileSync: (from) => unavailable(`copy ${from}`),
  tmpDir: () => '',
  homeDir: () => '',
  mkdtemp: (prefix) => unavailable(`mkdtemp ${prefix}`),
  statBig: (path) => unavailable(`stat ${path}`),
  open: (path) => unavailable(`open ${path}`),
  writeFile: (path) => unavailable(`write ${path}`),
  readFileBounded: (path) => unavailable(`read ${path}`),
  rm: () => Promise.resolve(),
  deviceIdEnv: () => null,
  takeStagedUpload: (uploadId) => unavailable(`staged upload ${uploadId}`),
};

let active: LocalRuntime = unavailableLocalRuntime;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setLocalRuntime(runtime: LocalRuntime | null): void {
  active = runtime ?? unavailableLocalRuntime;
}

/** 当前端口；所有按路径的本地访问都经它。 */
export function localRuntime(): LocalRuntime {
  return active;
}

/** 稳定门面：调用方直接写 `fs.existsSync(...)`，实现由入口注入。 */
export const fs: LocalRuntime = {
  existsSync: (path) => active.existsSync(path),
  readFileSync: (path) => active.readFileSync(path),
  writeFileSync: (path, data) => active.writeFileSync(path, data),
  mkdirSync: (path, options) => active.mkdirSync(path, options),
  rmSync: (path, options) => active.rmSync(path, options),
  renameSync: (from, to) => active.renameSync(from, to),
  renameSyncWithRetry: (from, to) => active.renameSyncWithRetry(from, to),
  statSync: (path) => active.statSync(path),
  statBigSync: (path) => active.statBigSync(path),
  lstatSync: (path) => active.lstatSync(path),
  realpathSync: (path) => active.realpathSync(path),
  readdirSync: (path) => active.readdirSync(path),
  readdirDirentsSync: (path) => active.readdirDirentsSync(path),
  openSync: (path, flags, mode) => active.openSync(path, flags, mode),
  readSync: (fd, buffer, offset, length, position) => active.readSync(fd, buffer, offset, length, position),
  writeSync: (fd, buffer, offset, length) => active.writeSync(fd, buffer, offset, length),
  closeSync: (fd) => active.closeSync(fd),
  fstatSync: (fd) => active.fstatSync(fd),
  copyFileSync: (from, to) => active.copyFileSync(from, to),
  tmpDir: () => active.tmpDir(),
  homeDir: () => active.homeDir(),
  mkdtemp: (prefix) => active.mkdtemp(prefix),
  statBig: (path) => active.statBig(path),
  open: (path, flags) => active.open(path, flags),
  writeFile: (path, data) => active.writeFile(path, data),
  readFileBounded: (path, maxBytes) => active.readFileBounded(path, maxBytes),
  rm: (path, options) => active.rm(path, options),
  deviceIdEnv: () => active.deviceIdEnv(),
  takeStagedUpload: (uploadId) => active.takeStagedUpload(uploadId),
};
