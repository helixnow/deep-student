/**
 * `ctx.files`：限定在允许根目录内的异步文件操作（W14）。
 *
 * - 只有异步接口：移动端（Capacitor Filesystem、OPFS）没有同步文件 API；
 * - 接口只用 `Uint8Array`、字符串、Web Streams（`ReadableStream` / `WritableStream`）和普通对象，
 *   不出现 `Buffer`、`fs.Stats`、`stream.Readable` 等 Node 类型；
 * - 每次操作先做路径包含判断：绝对路径按组件规范化（`.`、`..`、重复分隔符）后必须落在某个允许根内；
 *   Windows 按 `C:\`、UNC 根与大小写不敏感比较，POSIX 按字节比较（`/a/bc` 不在 `/a/b` 内）。
 *   桌面实现另外对目标的真实路径（解析符号链接后）再判一次，防止根内符号链接指向根外。
 * - 允许根默认取自 `ctx.paths`（见 `FileRootName`）；用户经系统对话框选择的路径用 `grant()` 临时放行。
 *
 * 这是防误用的护栏（拦截 ZIP 条目、模型工具参数、导入文件名中的 `..` 等），不是进程级沙箱。
 * 语义与移动端实现方式见 host/platform/API.md「files」。
 */

/** 路径风味：决定分隔符、根的形态和比较规则。 */
export type PathFlavor = 'posix' | 'win32';

/**
 * 默认根（桌面由 `ctx.paths` 推导）：
 * - `appData` = `ctx.paths.appDataDir`（含 `slots/` 下全部数据槽）
 * - `appLocalData` / `appConfig` / `appCache` / `appLog` = 同名 `ctx.paths` 目录
 * - `temp` = `ctx.paths.os.temp`
 * - `legacy` = Rust 旧版散落位置：`<dataLocal|data|config|home|temp>/deep-student`
 * - `granted` = `grant()` 临时放行的用户选择路径
 */
export type FileRootName = 'appData' | 'appLocalData' | 'appConfig' | 'appCache' | 'appLog' | 'temp' | 'legacy' | 'granted';

export interface FileRoot {
  readonly name: FileRootName;
  /** 绝对路径（平台原生分隔符）。 */
  readonly path: string;
}

export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileStat {
  readonly kind: FileKind;
  /** 字节数。 */
  readonly size: number;
  readonly modifiedMs: number;
  /** 出生时间；文件系统不提供时为 null。 */
  readonly createdMs: number | null;
  /** Unix 权限位（`mode & 0o7777`）；Windows / 移动端为 null。 */
  readonly unixMode: number | null;
}

export interface DirEntry {
  readonly name: string;
  /** `FilesService` 中为绝对路径；`FileScope` 中为相对作用域根、以 `/` 分隔的路径。 */
  readonly path: string;
  /** 不跟随符号链接：指向目录的链接报告为 `symlink`。 */
  readonly kind: FileKind;
}

export interface WalkEntry extends DirEntry {
  /** 相对遍历起点、以 `/` 分隔。 */
  readonly relativePath: string;
  /** 遍历起点的直接子项为 1。 */
  readonly depth: number;
}

/**
 * 与 Rust `std::io::ErrorKind` 同名的错误分类，另加：
 * `OutsideRoots`（路径不在允许根/作用域内）、`InvalidPath`（相对路径、NUL、Windows 设备名等）、
 * `TooLarge`（超过 `maxBytes`）、`UnsupportedOnPlatform`（当前平台没有该能力，消息以 `UNSUPPORTED_ON_PLATFORM: ` 开头，
 * 例如移动端的 `grant()`、缺少 `move()` 时的目录改名）。
 */
export type FileErrorKind =
  | 'NotFound'
  | 'AlreadyExists'
  | 'PermissionDenied'
  | 'NotADirectory'
  | 'IsADirectory'
  | 'DirectoryNotEmpty'
  | 'StorageFull'
  | 'ReadOnlyFilesystem'
  | 'CrossesDevices'
  | 'InvalidData'
  | 'OutsideRoots'
  | 'InvalidPath'
  | 'TooLarge'
  | 'UnsupportedOnPlatform'
  | 'Other';

export type FileOperation =
  | 'read' | 'write' | 'append' | 'writeAtomic' | 'openRead' | 'openWrite' | 'openFile' | 'truncate' | 'sync' | 'close'
  | 'stat' | 'readDir' | 'walk' | 'mkdir' | 'rename' | 'copyFile' | 'rm' | 'scope' | 'grant';

/**
 * 本服务抛出的唯一错误类型。`message` 对系统错误沿用 Rust `io::Error` 的 Display
 * （如 `No such file or directory (os error 2)`），与平台既有 `ioMessage` 一致；路径和操作放在字段里。
 */
export class FileError extends Error {
  override name = 'FileError';
  readonly kind: FileErrorKind;
  readonly operation: FileOperation;
  readonly path: string;
  /** 桌面上的原始 errno 码（如 `ENOENT`），仅供诊断；分支请用 `kind`。 */
  readonly osCode: string | null;
  constructor(kind: FileErrorKind, operation: FileOperation, path: string, message: string, options: { osCode?: string | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.operation = operation;
    this.path = path;
    this.osCode = options.osCode ?? null;
  }
}

/** `error instanceof FileError && error.kind === 'NotFound'`。 */
export function isFileNotFound(error: unknown): boolean {
  return error instanceof FileError && error.kind === 'NotFound';
}

export interface ReadOptions {
  /** 超过该字节数抛 `TooLarge`（先按 stat 判断，读完再复核）。 */
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ReadTextOptions extends ReadOptions {
  /** 默认 `replace`（同 Node `readFile(path, 'utf8')`）；`error` 同 Rust `read_to_string`（抛 `InvalidData`）。BOM 原样保留。 */
  readonly invalidUtf8?: 'replace' | 'error';
}

export interface WriteOptions {
  /** 先创建缺失的父目录（`create_dir_all`）。默认 false。 */
  readonly createParents?: boolean;
  /** true 时目标已存在抛 `AlreadyExists`（`O_EXCL`）。默认 false（覆盖）。 */
  readonly exclusive?: boolean;
  /** 新建文件的 Unix 权限位（受 umask 影响），默认 0o666。 */
  readonly unixMode?: number;
}

export interface AppendOptions {
  readonly createParents?: boolean;
  readonly unixMode?: number;
}

export interface AtomicWriteOptions {
  readonly createParents?: boolean;
  /** 默认 0o600（`tempfile` 语义，与平台既有 `atomicWriteFile` 一致）；显式给出时精确设置，不受 umask 影响。 */
  readonly unixMode?: number;
  /** rename 后再 fsync 父目录（POSIX），断电后也保证目录项落盘。默认 false。 */
  readonly durable?: boolean;
}

export interface ReadStreamOptions {
  /** 起始字节（含），默认 0。 */
  readonly start?: number;
  /** 结束字节（不含），默认到文件尾。 */
  readonly end?: number;
  /** 每块字节数，默认 64 KiB。 */
  readonly chunkSize?: number;
}

export interface WriteStreamOptions {
  /**
   * `overwrite`（默认，截断）| `append` | `exclusive`（已存在抛 `AlreadyExists`）|
   * `atomic`（写同目录临时文件，`close()` 时 fsync + rename，`abort()` 时删除临时文件）。
   */
  readonly mode?: 'overwrite' | 'append' | 'exclusive' | 'atomic';
  readonly createParents?: boolean;
  readonly unixMode?: number;
}

/**
 * `openFile` 的打开方式：
 * - `read`（默认）：只读，文件必须存在；
 * - `readWrite`：读写，文件必须存在，保留内容；
 * - `create`：读写，不存在则新建，存在则保留内容；
 * - `truncate`：读写，不存在则新建，存在则截断为空；
 * - `exclusive`：读写，新建；已存在（含同名目录）抛 `AlreadyExists`。
 */
export type OpenFileMode = 'read' | 'readWrite' | 'create' | 'truncate' | 'exclusive';

export interface OpenFileOptions {
  readonly mode?: OpenFileMode;
  /** 先创建缺失的父目录；只对会新建文件的模式（`create` / `truncate` / `exclusive`）生效。默认 false。 */
  readonly createParents?: boolean;
  /** 新建文件的 Unix 权限位（受 umask 影响），默认 0o666。 */
  readonly unixMode?: number;
}

/**
 * 定位读写句柄：没有游标，每次读写都给出字节位置。结构上就是 ZIP 核心的 `ZipByteSource`（`size` + `read`）
 * 与 `ZipByteSink`（`write`），可以直接交给 `ZipReader.open` / `new ZipWriter`。
 * 位置与长度必须是非负安全整数（否则抛 `Other`）；`close()` 之后除 `close()` 外的调用都抛 `Other`。
 */
export interface RandomAccessFile {
  /** 调用方传给 `openFile` 的路径（作用域里是相对路径）。 */
  readonly path: string;
  readonly mode: OpenFileMode;
  /** 打开时的字节数，随本句柄的 `write` / `truncate` 更新；看不到其他写入者的修改（需要时用 `stat`）。 */
  readonly size: number;
  /** 从 `position` 起读取至多 `length` 字节；只有读到文件尾时才更短，`position` 在文件尾或之后时返回空数组。 */
  read(position: number, length: number): Promise<Uint8Array>;
  /** 把 `data` 全部写到 `position`，超过文件尾时中间补 0；空 `data` 什么也不做。只读句柄抛 `PermissionDenied`。 */
  write(data: Uint8Array, position: number): Promise<void>;
  /** 截断或以 0 扩展到 `size` 字节。只读句柄抛 `PermissionDenied`。 */
  truncate(size: number): Promise<void>;
  /** 已写数据落盘（桌面 `fsync`，移动端 `flush()`）；只读句柄什么也不做。 */
  sync(): Promise<void>;
  /** 幂等。桌面关闭时不 `fsync`（需要断电持久性时先 `sync()`）；移动端写入句柄关闭前总会 `flush()`。 */
  close(): Promise<void>;
}

export interface MkdirOptions {
  /** 默认 true（`create_dir_all`）；false 时父目录必须存在、目标不得存在。 */
  readonly recursive?: boolean;
}

export interface RemoveOptions {
  /** 删除目录树，默认 false。 */
  readonly recursive?: boolean;
  /** 目标不存在时不报错，默认 false。 */
  readonly force?: boolean;
}

export interface RenameOptions {
  /** 默认 true；false 时目标已存在抛 `AlreadyExists`（先检查后改名，非原子）。 */
  readonly overwrite?: boolean;
  readonly createParents?: boolean;
}

export interface CopyOptions {
  /** 默认 true；false 时目标已存在抛 `AlreadyExists`（`COPYFILE_EXCL`）。 */
  readonly overwrite?: boolean;
  readonly createParents?: boolean;
}

export interface StatOptions {
  /** 默认 true；false 时符号链接本身报告为 `symlink`（`lstat`）。 */
  readonly followSymlinks?: boolean;
}

export interface WalkOptions {
  /** 最大深度（直接子项为 1），默认不限。 */
  readonly maxDepth?: number;
  /** 是否产出目录条目本身，默认 true。 */
  readonly includeDirectories?: boolean;
}

/**
 * 文件操作。`FilesService` 上的路径是绝对路径；`FileScope` 上的路径是相对作用域根的路径
 * （`/` 分隔，Windows 也接受 `\`）。目录列举与遍历按名称的 UTF-16 码元顺序排序，结果可复现。
 */
export interface FileOperations {
  readBytes(path: string, options?: ReadOptions): Promise<Uint8Array>;
  readText(path: string, options?: ReadTextOptions): Promise<string>;
  writeBytes(path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  /** UTF-8，不加 BOM。 */
  writeText(path: string, text: string, options?: WriteOptions): Promise<void>;
  append(path: string, data: Uint8Array | string, options?: AppendOptions): Promise<void>;
  /** 同目录临时文件 → write → fsync → rename；失败时删除临时文件，目标保持原样。 */
  writeAtomic(path: string, data: Uint8Array | string, options?: AtomicWriteOptions): Promise<void>;
  openRead(path: string, options?: ReadStreamOptions): Promise<ReadableStream<Uint8Array>>;
  openWrite(path: string, options?: WriteStreamOptions): Promise<WritableStream<Uint8Array>>;
  /**
   * 定位读写句柄（见 `RandomAccessFile`），用完必须 `close()`。目标是目录抛 `IsADirectory`（`exclusive` 为 `AlreadyExists`）。
   * 移动端：写入模式持有该文件的同步访问句柄直到 `close()`，期间对同一文件的其他写入抛 `Other`
   * （`osCode` = `NoModificationAllowedError`），读取不受影响；没有同步访问句柄（不在 Worker 中）时写入模式抛
   * `UnsupportedOnPlatform`，`read` 模式照常可用。
   */
  openFile(path: string, options?: OpenFileOptions): Promise<RandomAccessFile>;
  /** 不存在抛 `NotFound`。 */
  stat(path: string, options?: StatOptions): Promise<FileStat>;
  /** 同 Rust `Path::exists`：任何元数据错误都返回 false；路径不在允许根内仍抛 `OutsideRoots`。 */
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<DirEntry[]>;
  /** 先序深度优先；不跟随符号链接进入目录。 */
  walk(path: string, options?: WalkOptions): AsyncIterable<WalkEntry>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rename(from: string, to: string, options?: RenameOptions): Promise<void>;
  copyFile(from: string, to: string, options?: CopyOptions): Promise<void>;
  /** 非递归时只删文件或空目录（`rm -d`）。拒绝删除允许根或作用域根本身（`InvalidPath`）。 */
  rm(path: string, options?: RemoveOptions): Promise<void>;
}

/** 以某个目录为根的视图：所有路径相对该目录，`..` 不得越出它。适合接收不可信的相对文件名。 */
export interface FileScope extends FileOperations {
  /** 作用域根的绝对路径。 */
  readonly root: string;
  /** 相对路径 → 绝对路径（只做词法校验，不访问文件系统）；越界抛 `OutsideRoots`。 */
  resolve(relativePath: string): string;
  /** 子作用域。 */
  scope(relativePath: string): FileScope;
}

/** `grant()` 的返回值；`revoke()` 后该路径不再放行（幂等）。 */
export interface FileGrant {
  readonly path: string;
  revoke(): void;
}

export interface FilesService extends FileOperations {
  readonly flavor: PathFlavor;
  /** 当前全部允许根（含 `grant()` 放行的路径）。 */
  readonly roots: readonly FileRoot[];
  /** 路径是否在允许根内（桌面实现含真实路径判定）。相对路径返回 false。 */
  isAllowed(path: string): Promise<boolean>;
  /** 以绝对目录为根创建作用域；目录必须在允许根内（不要求已存在）。 */
  scope(directory: string): FileScope;
  /**
   * 临时放行一个用户经系统对话框选择的文件或目录（导入、导出、自定义备份目录）。
   * 只能传来自外壳对话框或用户显式配置的路径，不得传模型输出或文件内容里的路径。
   */
  grant(path: string): FileGrant;
  /**
   * 默认备份根（Rust `default_recovery_backup_dir` / `DataSpaceManager::recovery_backups_dir`）：
   * `appData` 根下的 `recovery/backups`，在 A/B 数据槽之外，切槽或清理非活动槽不会带走备份。
   * 它在 `appData` 根内，读写不需要 `grant()`；这里只给路径，不创建目录。
   * 桌面 = `ctx.paths.recoveryBackupsDir`；移动端 = `<AppInfo.dataDir>/recovery/backups`（OPFS）。
   *
   * 用户在设置里选的自定义备份目录不在允许根内：桌面先 `grant(dir)` 再访问，用完 `revoke()`；
   * 移动端没有自定义目录（Rust `pick_backup_directory` 在移动端直接报错，这里的 `grant()` 抛 `UnsupportedOnPlatform`）。
   * 服务没有 `appData` 根（只给了别的根的测试实例）时读取本属性抛 `UnsupportedOnPlatform`。
   */
  readonly backupRoot: string;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** W14：限定根目录的异步文件服务。 */
    files: FilesService;
  }
}
