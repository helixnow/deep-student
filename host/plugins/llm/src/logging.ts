/**
 * 插件日志出口。
 *
 * Rust 侧的 `tracing::warn!` / `info!` / `debug!` / `error!` 由插件入口注入的
 * `ctx.log.logger(target)` 承接；未注入时（单元测试或独立调用）在有 stderr 的
 * 运行时写 stderr，避免日志被静默丢弃。生产代码不得使用 `console.*`。
 */
import type { Logger } from '../../../platform/log/api.ts';

export type LlmLogger = Pick<Logger, 'error' | 'warn' | 'info' | 'debug'>;

let active: LlmLogger | null = null;
const fallbackStderr = (globalThis as { process?: { stderr?: { write(chunk: string): unknown } } }).process?.stderr;

export function setLlmLogger(logger: LlmLogger | null): void {
  active = logger;
}

function emit(level: keyof LlmLogger, message: string): void {
  if (active !== null) {
    active[level](message);
    return;
  }
  fallbackStderr?.write(`[${level.toUpperCase()}][dstu_llm] ${message}\n`);
}

export function logError(message: string): void {
  emit('error', message);
}

export function logWarn(message: string): void {
  emit('warn', message);
}

export function logInfo(message: string): void {
  emit('info', message);
}

export function logDebug(message: string): void {
  emit('debug', message);
}
