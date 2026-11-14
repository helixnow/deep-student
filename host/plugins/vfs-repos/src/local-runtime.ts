/**
 * vfs-repos 的同步本地运行时端口。
 *
 * 仓储（`BlobRepo` / `AttachmentRepo` / `FileRepo`）、维护服务与 worker 服务都保持同步形状：
 * 发布接口 `api.ts` 的方法签名是同步的，调用方（vfs、vfs-handlers、qbank、media、browser）
 * 遍布全仓，不能在本次移植里改成异步。移动端没有同步文件 API、也没有 worker 线程，因此这一层
 * 用端口隔离：桌面入口 `index.ts` 注入 `node:fs` / `node:worker_threads` 实现
 * （`local-runtime.node.ts`），移动端入口 `mobile.ts` 不注入——缺省端口没有本地文件系统，
 * 也没有 worker：blob/附件文件读写、zip 清单解析与跨线程执行按“不可用”降级，数据库侧
 * （元数据、引用计数、索引状态）照常工作。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误）：调用方保留原有的 `try/catch` 分支与
 * `VfsRepositoryError` 文案。已经异步的路径（`ctx.files`）不使用这里。
 */
import type { FileKind } from '../../../platform/files/api.ts';

export interface LocalStat {
  readonly kind: FileKind;
  readonly size: number;
  readonly mtimeMs: number;
}

/** `openSync(path, 'r')` 的句柄；`read` 返回读取字节数，0 表示 EOF。 */
export interface LocalReadHandle {
  /** `fstatSync(fd).size`：以已打开的句柄为准，避免路径再次被替换。 */
  size(): number;
  read(buffer: Uint8Array): number;
  close(): void;
}

/** `openSync(path, 'w' | 'a')` 的句柄。 */
export interface LocalWriteHandle {
  write(bytes: Uint8Array): void;
  close(): void;
}

/** zip 中央目录里清单页需要的字段（`zip` crate `ZipFile::name` / `size`）。 */
export interface LocalZipEntry {
  readonly name: string;
  readonly size: number;
}

export interface LocalZipArchive {
  readonly entries: readonly LocalZipEntry[];
}

/** `node:worker_threads` 的 `Worker` 中本插件用到的部分。 */
export interface LocalWorkerHandle {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number) => void): void;
  terminate(): Promise<void>;
}

export interface LocalWorkerOptions {
  readonly dbPath: string;
  readonly deviceId: string;
}

export interface VfsReposLocalRuntime {
  /** 运行平台名（`process.platform` 的同值）；决定 Windows 专有的 rename 重试。 */
  readonly platform: string;
  exists(path: string): boolean;
  /** 跟随符号链接的元数据；不存在时报错。 */
  stat(path: string): LocalStat;
  /** 不跟随符号链接的元数据；不存在时报错。 */
  lstat(path: string): LocalStat;
  /** `realpathSync.native`。 */
  realpath(path: string): string;
  readFile(path: string): Uint8Array;
  /** `writeFileSync(path, bytes, { flag: 'a' })`。 */
  appendFile(path: string, bytes: Uint8Array): void;
  /** `mkdir -p`。 */
  mkdirp(path: string): void;
  /** `rename`：win32 上对 `EPERM` / `EACCES` / `EBUSY` 退避重试。 */
  rename(from: string, to: string): void;
  /** `rmSync(path)`：不存在时报错（删除隔离文件时用来暴露竞态）。 */
  remove(path: string): void;
  /** `rmSync(path, { force: true })`：不存在时不报错。 */
  removeForce(path: string): void;
  /** `rmSync(path, { recursive: true, force: true })`。 */
  removeDirForce(path: string): void;
  readdir(path: string): string[];
  /** `openSync(path, 'w')`。 */
  openWrite(path: string): LocalWriteHandle;
  openRead(path: string): LocalReadHandle;
  /** 同步读 zip 中央目录（`platform/util/zip.ts` 的桌面子模块，移动端不可用）。 */
  readZip(bytes: Uint8Array): LocalZipArchive;
  /** 阻塞等待（SQLite busy 重试、跨线程回读轮询）；移动端为空操作。 */
  sleepSync(milliseconds: number): void;
  spawnWorker(options: LocalWorkerOptions): LocalWorkerHandle;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local runtime unavailable: ${operation}`);
    this.name = 'LocalRuntimeUnavailableError';
  }
}

/** 缺省端口：没有本地文件系统，也没有 worker（移动端 / 未注入）。 */
const unavailable: VfsReposLocalRuntime = {
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  exists: () => false,
  stat: (path) => { throw new LocalRuntimeUnavailableError(`stat ${path}`); },
  lstat: (path) => { throw new LocalRuntimeUnavailableError(`lstat ${path}`); },
  realpath: (path) => { throw new LocalRuntimeUnavailableError(`realpath ${path}`); },
  readFile: (path) => { throw new LocalRuntimeUnavailableError(`read ${path}`); },
  appendFile: (path) => { throw new LocalRuntimeUnavailableError(`append ${path}`); },
  mkdirp: (path) => { throw new LocalRuntimeUnavailableError(`mkdir ${path}`); },
  rename: (from, to) => { throw new LocalRuntimeUnavailableError(`rename ${from} -> ${to}`); },
  // 删除类操作在缺省端口里是空操作：没有本地文件可删，保持“尽力而为”的调用方语义。
  remove: () => undefined,
  removeForce: () => undefined,
  removeDirForce: () => undefined,
  readdir: () => [],
  openWrite: (path) => { throw new LocalRuntimeUnavailableError(`create ${path}`); },
  openRead: (path) => { throw new LocalRuntimeUnavailableError(`open ${path}`); },
  readZip: () => { throw new LocalRuntimeUnavailableError('read zip'); },
  sleepSync: () => undefined,
  spawnWorker: () => { throw new LocalRuntimeUnavailableError('worker'); },
};

let active: VfsReposLocalRuntime = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统 / 无 worker）。 */
export function setVfsReposLocalRuntime(port: VfsReposLocalRuntime | null): void {
  active = port ?? unavailable;
}

/** 当前端口；blob/附件文件、zip 清单与 worker 的所有本地访问都经它。 */
export function vfsReposLocalRuntime(): VfsReposLocalRuntime {
  return active;
}
