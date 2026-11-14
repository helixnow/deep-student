/**
 * chat 插件的同步本地文件端口。
 *
 * 发布接口（`api.ts` 的 `loadAgentsInstructions` / `readAgentsMdFile`、workspace 人设文件命令）
 * 与附件落盘（`attachment-stage.ts`）都是同步形状，移动端没有同步文件 API，因此这一层用端口隔离：
 * 桌面入口 `index.ts` 注入 `node:fs` / `node:os` 实现（`local-fs.node.ts`），移动端入口
 * `mobile.ts` 不注入——缺省端口没有本地文件系统，上述能力按“不可用”降级（AGENTS.md 发现返回 null、
 * 附件暂存报错），其余会话/消息能力不受影响。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），调用方保留原有的 `ioMessage` 文案与
 * `try/catch` 分支。已经异步的路径（`ctx.files`）不使用这里。
 */
import type { FileKind } from '../../../platform/files/api.ts';
import type { ZipEntryInfo, ZipIndexEntry, ZipReadOptions } from '../../../platform/util/zip.ts';

/** ZIP 索引面（`readZip` 的子集）：移动端不注入，缺省端口没有该能力。 */
export interface ChatZipArchive {
  readonly entries: readonly ZipEntryInfo[];
  inspectByIndex(index: number): ZipIndexEntry;
  read(entry: ZipEntryInfo, options?: ZipReadOptions): Uint8Array;
}
export type ChatZipArchiveFactory = (bytes: Uint8Array) => ChatZipArchive;

export interface LocalStat {
  readonly kind: FileKind;
  readonly size: number;
}

/** `openSync(path, 'r')` 的句柄；`read` 返回读取字节数，0 表示 EOF。 */
export interface LocalReadHandle {
  /** `fstatSync(fd).size`：以已打开的句柄为准，避免路径再次被替换。 */
  size(): number;
  read(buffer: Uint8Array): number;
  close(): void;
}

/** `openSync(path, 'wx')` 的句柄。 */
export interface LocalWriteHandle {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface ChatLocalFs {
  /** 运行平台名（`process.platform` 的同值）；决定 Windows 专有路径分支。 */
  readonly platform: string;
  /** `os.homedir()`；取不到时为空串。 */
  homeDir(): string;
  exists(path: string): boolean;
  /** `stat`：不跟随… 即跟随符号链接的元数据（Rust `fs::metadata`）。 */
  stat(path: string): LocalStat;
  /** `statSync(path, { bigint: true }).mtimeNs`；任何失败返回 null（Rust `metadata().ok()`）。 */
  statMtimeNs(path: string): bigint | null;
  /** `lstat`：不跟随符号链接（Rust `symlink_metadata`）。 */
  lstat(path: string): LocalStat;
  /** `realpathSync.native`。 */
  realpath(path: string): string;
  readBytes(path: string): Uint8Array;
  openRead(path: string): LocalReadHandle;
  /** `openSync(path, 'wx')`：目标已存在时报错。 */
  openExclusive(path: string): LocalWriteHandle;
  /** `mkdir -p`。 */
  mkdirp(path: string): void;
  /** `mkdirSync(path)`：已存在返回 false（`EEXIST`），其他失败抛出。 */
  mkdirExclusive(path: string): boolean;
  /** `writeFileSync`：失败时返回 false（调用方本就丢弃错误）。 */
  writeTextIgnoring(path: string, text: string): boolean;
  /** `writeFileSync`：失败抛出。 */
  writeText(path: string, text: string): void;
  unlink(path: string): void;
  /** `rmSync(path, { force: true })`：不存在时不报错。 */
  removeForce(path: string): void;
  /** `rmSync(path, { recursive: true, force: true })`。 */
  removeDirForce(path: string): void;
  /**
   * `readZip(bytes)`（F4 ZIP 解析，`node:zlib`）：附件归档扫描/解包需要。移动端不注入 →
   * `undefined`，调用方按“本地文件系统不可用”报错。
   */
  zip?(bytes: Uint8Array): ChatZipArchive;
  /** `isRealUserHomeUnderTest(home)`：Vitest 进程不得读取真实用户 home 里的 AGENTS.md。 */
  homeIsUnderTest?(home: string): boolean;
}

export class LocalFsUnavailableError extends Error {
  constructor(operation: string) {
    super(`local filesystem unavailable: ${operation}`);
    this.name = 'LocalFsUnavailableError';
  }
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: ChatLocalFs = {
  platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux',
  homeDir: () => '',
  exists: () => false,
  stat: (path) => { throw new LocalFsUnavailableError(`stat ${path}`); },
  statMtimeNs: () => null,
  lstat: (path) => { throw new LocalFsUnavailableError(`lstat ${path}`); },
  realpath: (path) => { throw new LocalFsUnavailableError(`realpath ${path}`); },
  readBytes: (path) => { throw new LocalFsUnavailableError(`read ${path}`); },
  openRead: (path) => { throw new LocalFsUnavailableError(`open ${path}`); },
  openExclusive: (path) => { throw new LocalFsUnavailableError(`create ${path}`); },
  mkdirp: (path) => { throw new LocalFsUnavailableError(`mkdir ${path}`); },
  mkdirExclusive: () => false,
  writeTextIgnoring: () => false,
  writeText: (path) => { throw new LocalFsUnavailableError(`write ${path}`); },
  unlink: (path) => { throw new LocalFsUnavailableError(`unlink ${path}`); },
  removeForce: () => undefined,
  removeDirForce: () => undefined,
};

let active: ChatLocalFs = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setChatLocalFs(port: ChatLocalFs | null): void {
  active = port ?? unavailable;
}

/** 当前端口；AGENTS.md 发现、人设文件与附件落盘的所有本地访问都经它。 */
export function chatLocalFs(): ChatLocalFs {
  return active;
}
