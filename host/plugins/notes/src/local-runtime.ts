/**
 * notes 插件的桌面本地运行时端口（同步 `node:fs`、F3 本地文件辅助、删除队列与数据库 worker 线程池）。
 *
 * 笔记资源（`notes_assets/`）、导出/导入归档落盘、附件删除队列与 `spawn_blocking` 等价任务都是同步形状，
 * 移动端没有同步文件 API、没有 worker 线程，也没有 `node:fs`，因此这一层用端口隔离：桌面入口
 * `host/plugins/notes/index.ts` 注入实现（`local-runtime.node.ts`），移动端入口（`mobile.ts`）不注入——
 * 缺省端口没有本地文件系统：资源落盘/扫描、导入导出写盘、附件删除按“不可用”降级（明确报错），
 * 笔记 CRUD、历史、租约、关系、画布等基于 SQLite 的能力不受影响。`notes_list_tags` / `notes_db_vacuum`
 * 在没有 worker 线程时在调用线程上直接执行（同一份任务实现）。
 *
 * 端口方法语义与 Node 同名函数一致（不包装错误），调用方保留原有的 `NotesExporterError` /
 * `AssetError` 文案；已经异步的 `copyFileVerified` 也走本端口，因为移动端同样没有 `node:fs/promises`。
 */
import { Disposer } from '../../../kernel/api.ts';
import type { FileKind } from '../../../platform/files/api.ts';
import type {
  DatabaseWorkerTasks, SqlExecutor,
} from '../../../platform/storage/api.ts';
import type { NoteAssetRetention, PreparedDeletionIntent } from '../../../platform/storage/node.ts';

/** `statSync` / `lstatSync` 的子集：调用方只按类型与大小分支。 */
export interface LocalStat {
  readonly kind: FileKind;
  readonly size: number;
}

/** `readdirSync(path, { withFileTypes: true })` 的一项。 */
export interface LocalDirEntry {
  readonly name: string;
  readonly kind: FileKind;
}

/** `unified_file_manager::classify_path` 的结果（`ensure_local_path` 只需要这两种形态）。 */
export type LocalPathClassification =
  | { readonly kind: 'virtual'; readonly uri: string }
  | { readonly kind: 'local'; readonly path: string };

/** `createDatabaseWorkerPool` 的端口形状（只用到 notes 的三种操作）。 */
export interface NotesWorkerPool {
  run<T>(task: string, payload: null, options: { readonly database: string }): Promise<T>;
  pause(): Promise<void>;
  resume(): void;
  close(): Promise<void>;
}

export interface NotesWorkerPoolOptions {
  readonly baseDir: string;
  readonly dataLocalDir: string;
  readonly taskModule: URL;
  readonly tasks: readonly string[];
}

export interface NotesLocalRuntime {
  // ---------------------------------------------------------------- 同步文件系统
  exists(path: string): boolean;
  /** `statSync`：跟随符号链接。 */
  stat(path: string): LocalStat;
  /** `lstatSync`：不跟随符号链接。 */
  lstat(path: string): LocalStat;
  /** `realpathSync`。 */
  realpath(path: string): string;
  /** `realpathSync.native`。 */
  realpathNative(path: string): string;
  /** `readdirSync(path)`。 */
  readDirNames(path: string): string[];
  /** `readdirSync(path, { withFileTypes: true })`。 */
  readDir(path: string): LocalDirEntry[];
  /** `readFileSync`。 */
  readBytes(path: string): Uint8Array;
  /** `writeFileSync`；`exclusive` 对应 `{ flag: 'wx' }`。 */
  writeBytes(path: string, bytes: Uint8Array, options?: { readonly exclusive?: boolean }): void;
  /** `mkdir -p`。 */
  mkdirp(path: string): void;
  /** `rmdirSync`：目录非空时报错。 */
  rmdir(path: string): void;
  /** `unlinkSync`。 */
  unlink(path: string): void;
  /** `classify_path`：SAF/content URI 判为虚拟路径，其余返回规范化后的本地路径。 */
  classifyPath(rawPath: string): LocalPathClassification;

  // ---------------------------------------------------------------- F3 本地文件能力
  /** `assetLocalPathFromKey`：`active/` / `app_data/` key 的应用数据相对路径。 */
  assetLocalPathFromKey(key: string): string;
  /** 删除队列：记录意图并删除物理文件；文件不存在返回 false。 */
  deleteAssetWithJournal(activeDir: string, key: string, localPath: string): boolean;
  /** 删除队列（事务内）：写入 prepared 意图，随后由 `finishAssetDeletion` 落盘。 */
  prepareAssetDeletion(
    conn: SqlExecutor, activeDir: string, key: string, localPath: string,
  ): PreparedDeletionIntent;
  /** 删除队列（事务内）：完成 prepared 意图（rename/unlink → ready）。 */
  finishAssetDeletion(conn: SqlExecutor, activeDir: string, intent: PreparedDeletionIntent): void;
  /** 启动期恢复未完成的删除意图。 */
  recoverAssetDeletions(activeDir: string): number;
  /** 注册笔记资产引用保护（删除队列在事务里查询）。 */
  registerNoteAssetRetention(retention: NoteAssetRetention): Disposer;
  /** `createDatabaseWorkerPool`：移动端返回 null，由调用方在同线程执行任务。 */
  createWorkerPool(options: NotesWorkerPoolOptions): NotesWorkerPool | null;
  /** 带哈希校验的复制（虚拟 URI → 真实文件）。 */
  copyFileVerified(source: string, target: string): Promise<void>;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local runtime unavailable: ${operation}`);
    this.name = 'LocalRuntimeUnavailableError';
  }
}

const unavailable = (operation: string): never => {
  throw new LocalRuntimeUnavailableError(operation);
};

/** 缺省端口：没有本地文件系统与 worker 线程（移动端 / 未注入）。 */
const UNAVAILABLE: NotesLocalRuntime = {
  exists: () => false,
  stat: (path) => unavailable(`stat ${path}`),
  lstat: (path) => unavailable(`lstat ${path}`),
  realpath: (path) => unavailable(`realpath ${path}`),
  realpathNative: (path) => unavailable(`realpath ${path}`),
  readDirNames: (path) => unavailable(`readdir ${path}`),
  readDir: (path) => unavailable(`readdir ${path}`),
  readBytes: (path) => unavailable(`read ${path}`),
  writeBytes: (path) => unavailable(`write ${path}`),
  mkdirp: (path) => unavailable(`mkdir ${path}`),
  rmdir: (path) => unavailable(`rmdir ${path}`),
  unlink: (path) => unavailable(`unlink ${path}`),
  classifyPath: (rawPath) => ({ kind: 'virtual', uri: rawPath }),
  assetLocalPathFromKey: (key) => unavailable(`asset key ${key}`),
  deleteAssetWithJournal: () => unavailable('delete asset'),
  prepareAssetDeletion: () => unavailable('prepare asset deletion'),
  finishAssetDeletion: () => unavailable('finish asset deletion'),
  recoverAssetDeletions: () => 0,
  registerNoteAssetRetention: () => new Disposer(() => undefined),
  createWorkerPool: () => null,
  copyFileVerified: async (source) => unavailable(`copy ${source}`),
};

let active: NotesLocalRuntime = UNAVAILABLE;

/** 入口注入平台实现；`null` 恢复缺省（无本地运行时）。 */
export function setNotesLocalRuntime(runtime: NotesLocalRuntime | null): void {
  active = runtime ?? UNAVAILABLE;
}

/** 当前端口；笔记资源、导入导出落盘与删除队列的所有本地访问都经它。 */
export function notesLocalRuntime(): NotesLocalRuntime {
  return active;
}
