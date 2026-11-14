/**
 * F3 存储错误类型（可移植叶子模块：只导入同样没有任何 import 的 `errors/unsupported-on-platform.ts`）。
 *
 * `api.ts` 原样 re-export 本文件，业务插件继续从 `api.ts` 导入即可；移动端实现与其他需要在
 * Worker / WebView 中求值的模块应直接从这里导入，避免经 `api.ts` 的值再导出加载桌面实现。
 */
import { UNSUPPORTED_ON_PLATFORM_PREFIX, unsupportedOnPlatformMessage } from '../errors/unsupported-on-platform.ts';

export type StorageErrorCode =
  /** SQLite 原生错误；`sqliteCode` 为扩展码名，如 `SQLITE_CONSTRAINT_UNIQUE`。 */
  | 'SQLITE'
  /** 写者槽被异步事务占用（非阻塞地拒绝，见 `DatabaseHandle.transaction`）。 */
  | 'BUSY'
  | 'NO_ROWS'
  | 'TX_CLOSED'
  | 'ABORTED'
  | 'ASYNC_IN_SYNC_TX'
  | 'MAINTENANCE'
  | 'MAINTENANCE_DRAIN_TIMEOUT'
  | 'INVALID_PARAM'
  | 'UNKNOWN_DATABASE'
  /** `registerFinalizer` 同名重复。 */
  | 'FINALIZER_DUPLICATE'
  /** finalizer 名称为空或回调不是函数。 */
  | 'FINALIZER_INVALID'
  /** `after` 指向不存在的 finalizer。 */
  | 'FINALIZER_UNKNOWN_DEPENDENCY'
  /** `after` 依赖成环。 */
  | 'FINALIZER_CYCLE'
  /** `runStartupFinalizers()` 已开始后仍尝试注册。 */
  | 'FINALIZER_LATE_REGISTRATION'
  /** 维护屏障参与者重名。 */
  | 'MAINTENANCE_PARTICIPANT_DUPLICATE'
  /**
   * 当前平台不提供该能力（如移动端的 `browser` 库）。`capability` / `platform` 给出机器可读的定位，
   * `message` 以 `UNSUPPORTED_ON_PLATFORM: ` 开头——非 Rust 错误到前端只剩消息文本，前端按该前缀识别。
   */
  | 'UNSUPPORTED_ON_PLATFORM';

/** SQL 执行阶段。由 F3 在物理分层处打标，业务 lane 据此映射 Rust 的分阶段错误文案。 */
export type SqlPhase = 'prepare' | 'bind' | 'execute';

/**
 * 存储层错误。`message` 对 `SQLITE` 等于 `sqlite3_errmsg`（与 rusqlite `Error` 的 Display 一致），
 * 业务 lane 据此拼出与 Rust 相同的前端错误文案。
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly sqliteCode: string | undefined;
  readonly database: string | undefined;
  /** 失败发生阶段；非 SQL 路径（如 `BUSY`/`NO_ROWS`）保持 `undefined`。 */
  readonly phase: SqlPhase | undefined;
  /** `UNSUPPORTED_ON_PLATFORM`：能力 id（与平台能力清单中的 id 相同）。 */
  readonly capability: string | undefined;
  /** `UNSUPPORTED_ON_PLATFORM`：当前平台。 */
  readonly platform: string | undefined;
  constructor(
    code: StorageErrorCode,
    message: string,
    extra?: { sqliteCode?: string; database?: string; cause?: unknown; phase?: SqlPhase; capability?: string; platform?: string },
  ) {
    super(message, extra?.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'StorageError';
    this.code = code;
    this.sqliteCode = extra?.sqliteCode;
    this.database = extra?.database;
    this.phase = extra?.phase;
    this.capability = extra?.capability;
    this.platform = extra?.platform;
  }
}

/** `UNSUPPORTED_ON_PLATFORM` 错误消息的固定前缀（前端识别用）。 */
export { UNSUPPORTED_ON_PLATFORM_PREFIX };

/** 构造“当前平台不支持”的存储错误：`UNSUPPORTED_ON_PLATFORM: <capability> is not available on <platform>[: detail]`。 */
export function unsupportedOnPlatform(capability: string, platform: string, detail?: string): StorageError {
  return new StorageError('UNSUPPORTED_ON_PLATFORM', unsupportedOnPlatformMessage(capability, platform, detail), { capability, platform });
}

/** `runStartupFinalizers()` 失败：`finalizer` 是失败钩子名，`cause` 是原始错误，`completed` 是已成功钩子。 */
export class StartupFinalizerError extends Error {
  readonly finalizer: string;
  readonly completed: readonly string[];
  constructor(finalizer: string, completed: readonly string[], cause: unknown) {
    super(`startup finalizer failed: ${finalizer}`, { cause });
    this.name = 'StartupFinalizerError';
    this.finalizer = finalizer;
    this.completed = completed;
  }
}

/** afterCommit 回调失败：数据**已提交**，`errors` 为各回调抛出的错误。 */
export class AfterCommitError extends AggregateError {
  readonly committed = true as const;
  constructor(errors: unknown[]) {
    super(errors, `${errors.length} afterCommit callback(s) failed after a successful commit`);
    this.name = 'AfterCommitError';
  }
}
