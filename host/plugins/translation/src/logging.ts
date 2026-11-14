/**
 * 翻译插件日志出口。
 *
 * Rust 侧的 `log::warn!` / `info!` 由插件入口注入的 `ctx.log.logger(target)`
 * 承接；未注入时（单元测试或独立调用）写 stderr（无 `process` 的宿主写 console），避免日志被静默丢弃。
 * 生产代码不得使用 `console.*`。
 */
import type { Logger } from '../../../platform/log/api.ts';
import { writeHostStderr } from '../../../kernel/kernel.ts';

export type TranslationLogger = Pick<Logger, 'error' | 'warn' | 'info' | 'debug'>;

let active: TranslationLogger | null = null;

export function setTranslationLogger(logger: TranslationLogger | null): void {
  active = logger;
}

function emit(level: keyof TranslationLogger, message: string): void {
  if (active !== null) {
    active[level](message);
    return;
  }
  writeHostStderr(`[${level.toUpperCase()}][dstu_translation] ${message}\n`);
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
