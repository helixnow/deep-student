/**
 * agent-orchestration 的桌面本地运行时端口（同步 `node:fs`、主机名、pid）。
 *
 * 发布接口（`api.ts` 的 `atomicWrite` / `CustomAgentStore` / `migrateLegacyDb`）与人设工具
 * 都是同步形状，移动端没有同步文件 API，因此这一层用端口隔离：桌面入口
 * `host/plugins/agent-orchestration/index.ts` 注入 `node:fs` / `node:os` 实现
 * （`local-node-runtime.node.ts`），移动端入口（`mobile.ts`）不注入——缺省端口没有本地文件系统，
 * 人设文件能力按“不可用”降级，其余自动化/待办能力不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），这样 `ioStep` 的 Rust 文案与错误码保持原样。
 */
import type { FileKind } from '../../../platform/files/api.ts';

export interface LocalNodeStat {
  readonly kind: FileKind;
}

export interface LocalNodeBigStat extends LocalNodeStat {
  readonly size: number;
  /** `stat.mtimeNs`（bigint），供 `chronoRfc3339` 使用。 */
  readonly mtimeNs: bigint;
}

/** `openSync(path, 'wx')` 的句柄。 */
export interface LocalNodeWriteHandle {
  write(bytes: Uint8Array): void;
  /** `fsync`。 */
  sync(): void;
  close(): void;
}

export interface LocalNodeDirEntry {
  readonly name: string;
  readonly directory: boolean;
}

export interface LocalNodeRuntime {
  hostname(): string;
  pid(): number;
  exists(path: string): boolean;
  /** `lstat`：不跟随符号链接，文件大小与 mtime 取 `number` / `bigint` 两种精度。 */
  lstat(path: string): LocalNodeStat;
  lstatBig(path: string): LocalNodeBigStat;
  /** `mkdir -p`。 */
  mkdirp(path: string): void;
  readBytes(path: string): Uint8Array;
  readDir(path: string): LocalNodeDirEntry[];
  /** 目录项名的原始字节（`readdirSync(dir, { encoding: 'buffer' })`），用于按字节排序。 */
  readDirRawNames(path: string): Uint8Array[];
  /** `openSync(path, 'wx')`。 */
  openExclusive(path: string): LocalNodeWriteHandle;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  /** `rmSync(path, { force: true })`：不存在时不报错。 */
  removeForce(path: string): void;
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: LocalNodeRuntime = {
  hostname: () => 'local',
  pid: () => 0,
  exists: () => false,
  lstat: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  lstatBig: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  mkdirp: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  readBytes: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  readDir: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  readDirRawNames: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  openExclusive: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  rename: (from) => { throw new Error(`local filesystem unavailable: ${from}`); },
  unlink: (path) => { throw new Error(`local filesystem unavailable: ${path}`); },
  removeForce: () => undefined,
};

let active: LocalNodeRuntime = unavailable;

/** 入口注入桌面实现；`null` 恢复缺省（无本地文件系统）。 */
export function setLocalNodeRuntime(runtime: LocalNodeRuntime | null): void {
  active = runtime ?? unavailable;
}

/** 当前端口；人设文件与启动期旧库迁移的所有本地访问都经它。 */
export function localNodeRuntime(): LocalNodeRuntime {
  return active;
}
