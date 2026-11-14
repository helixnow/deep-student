/**
 * sync 的本地运行时端口（同步 `node:fs` / 异步 `node:fs/promises` / `node:os` 的形状）。
 *
 * 云同步要直接读写真实路径：业务库快照与 WAL、blobs/assets 资产树、导出/导入 JSON、加密对象与断点
 * 临时文件；`getSyncStatus` 还要探测库文件是否存在。这些接口在 Rust 侧是同步的 `std::fs`，移动端没有
 * 可用的同步文件 API，因此这一层用端口隔离：桌面入口 `index.ts` 注入 `node:fs` / `node:fs/promises`
 * 实现（`local-runtime.node.ts`），移动端入口（`mobile.ts`）不注入——缺省端口没有本地文件系统，
 * 走磁盘的指令按 `IO error` / `Database error` 降级，纯 SQLite 的指令与契约不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），调用方保留原有的 Rust `ioMessage` 文案与分发。
 */
export type LocalPath = string | Uint8Array;

export interface LocalStats {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `statSync(path, { bigint: true })`：`size` 与 `mtimeNs` 都按 bigint 精度（Rust `metadata().size()` / `mtime`）。 */
export interface LocalBigStats {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `open(path, 'wx', 0o600)` 的句柄（下载解密临时文件只创建、关闭）。 */
export interface LocalAsyncHandle {
  close(): Promise<void>;
}

export interface LocalRuntime {
  // ---- 同步（`node:fs`） ----
  existsSync(path: LocalPath): boolean;
  statSync(path: LocalPath): LocalStats;
  statBigSync(path: LocalPath): LocalBigStats;
  lstatSync(path: LocalPath): LocalStats;
  readdirSync(path: LocalPath): string[];
  /** `readdirSync(path, { encoding: 'buffer' })`：原始字节名，用于按字节保留文件名。 */
  readdirSyncRaw(path: LocalPath): Uint8Array[];
  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  copyFileSync(from: string, to: string): void;
  readFileSync(path: string): Uint8Array;
  openSync(path: string, flags: string): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  closeSync(fd: number): void;

  // ---- 异步（`node:fs/promises` / `node:os`） ----
  /** `os.tmpdir()`；取不到时为空串。 */
  tmpDir(): string;
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  stat(path: string): Promise<LocalStats>;
  statBig(path: string): Promise<LocalBigStats>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<LocalAsyncHandle>;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local filesystem unavailable: ${operation}`);
    this.name = 'LocalRuntimeUnavailableError';
  }
}

const unavailableStats = (operation: string): never => { throw new LocalRuntimeUnavailableError(operation); };

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: LocalRuntime = {
  existsSync: () => false,
  statSync: (path) => unavailableStats(`stat ${String(path)}`),
  statBigSync: (path) => unavailableStats(`stat ${String(path)}`),
  lstatSync: (path) => unavailableStats(`lstat ${String(path)}`),
  readdirSync: (path) => unavailableStats(`readdir ${String(path)}`),
  readdirSyncRaw: (path) => unavailableStats(`readdir ${String(path)}`),
  mkdirSync: (path) => unavailableStats(`mkdir ${path}`),
  rmSync: () => undefined,
  copyFileSync: (from) => unavailableStats(`copy ${from}`),
  readFileSync: (path) => unavailableStats(`read ${path}`),
  openSync: (path) => unavailableStats(`create ${path}`),
  writeSync: () => unavailableStats('write'),
  closeSync: () => undefined,
  tmpDir: () => '',
  mkdtemp: async (prefix) => unavailableStats(`mkdtemp ${prefix}`),
  mkdir: async (path) => unavailableStats(`mkdir ${path}`),
  stat: async (path) => unavailableStats(`stat ${path}`),
  statBig: async (path) => unavailableStats(`stat ${path}`),
  rename: async (from) => unavailableStats(`rename ${from}`),
  rm: async () => undefined,
  writeFile: async (path) => unavailableStats(`write ${path}`),
  open: async (path) => unavailableStats(`open ${path}`),
};

let active: LocalRuntime = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setLocalRuntime(runtime: LocalRuntime | null): void {
  active = runtime ?? unavailable;
}

/** 当前端口；所有按路径的同步本地访问都经它。 */
export function localRuntime(): LocalRuntime {
  return active;
}

/** 稳定门面：调用方直接写 `fs.existsSync(...)`，实现由入口注入。 */
export const fs: LocalRuntime = {
  existsSync: (path) => active.existsSync(path),
  statSync: (path) => active.statSync(path),
  statBigSync: (path) => active.statBigSync(path),
  lstatSync: (path) => active.lstatSync(path),
  readdirSync: (path) => active.readdirSync(path),
  readdirSyncRaw: (path) => active.readdirSyncRaw(path),
  mkdirSync: (path, options) => active.mkdirSync(path, options),
  rmSync: (path, options) => active.rmSync(path, options),
  copyFileSync: (from, to) => active.copyFileSync(from, to),
  readFileSync: (path) => active.readFileSync(path),
  openSync: (path, flags) => active.openSync(path, flags),
  writeSync: (fd, buffer, offset, length) => active.writeSync(fd, buffer, offset, length),
  closeSync: (fd) => active.closeSync(fd),
  tmpDir: () => active.tmpDir(),
  mkdtemp: (prefix) => active.mkdtemp(prefix),
  mkdir: (path, options) => active.mkdir(path, options),
  stat: (path) => active.stat(path),
  statBig: (path) => active.statBig(path),
  rename: (from, to) => active.rename(from, to),
  rm: (path, options) => active.rm(path, options),
  writeFile: (path, data) => active.writeFile(path, data),
  open: (path, flags, mode) => active.open(path, flags, mode),
};
