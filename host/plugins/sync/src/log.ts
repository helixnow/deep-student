/**
 * 同步引擎日志出口。
 *
 * Rust 中 `tracing::warn!` / `info!` 的位置在 TS 中必须保留同样的日志，但不阻断流程。
 * 由 `index.ts` 注入 Cordis logger；测试可省略（此时仅跳过日志，不改变行为）。
 */
export interface SyncLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
