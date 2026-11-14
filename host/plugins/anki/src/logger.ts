/**
 * 插件日志接口：对应 Rust `tracing::{debug,info,warn,error}`。
 *
 * 生产路径由插件入口注入 `ctx.logger`；仓储与纯逻辑模块只依赖本接口，
 * 不直接写 stdout/stderr（strict 边界规则禁止 `console.*`）。
 */
export interface AnkiLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
