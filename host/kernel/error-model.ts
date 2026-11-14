/**
 * 命令错误模型（叶子模块）：kernel 命令边界的 {@link CommandError} 与 Rust
 * `dstu_core::models::AppError`（dstu-core/src/models.rs:928–1084）。
 *
 * 只依赖本身没有 import 的 `./json.ts`。kernel 内部（commands / runtime / plugin-manager …）与
 * `host/platform/errors/api.ts` 都从这里取值，避免 `kernel/api.ts ⇄ platform/errors/api.ts` 的 import 环。
 * 插件继续从 `kernel/api.ts`（`CommandError`）与 `platform/errors/api.ts`（`AppError` 等）导入，两处都 re-export 本文件。
 */
import { findNonJson } from './json.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * 对应 Rust 命令的 `Err(E)`：`value` 必须是 E 的 serde 序列化结果，原样发给前端。
 * `message` 是显示文本：字符串原样；带非空字符串 `message` 字段的普通对象（AppError、envelope、DstuError）取该字段，
 * 与 Rust `impl Display for AppError`（只写 message）和 {@link errorDisplay} 一致；其余值为 JSON 文本或非 JSON 诊断（V05-02）。
 */
export class CommandError extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    // Diagnostic text must not execute a class's toJSON or throw on D3 BigInt.
    // The original value is validated/projected only by CommandService.
    super(typeof value === 'string' ? value : plainMessage(value) ?? findNonJson(value)
      ?? JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item));
    this.name = 'CommandError';
    this.value = value;
  }
}

function plainMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const message = Object.getOwnPropertyDescriptor(value, 'message')?.value;
  return typeof message === 'string' && message ? message : undefined;
}

/**
 * 任意错误值的显示文本（V08-04；Rust `e.to_string()` / `format!("{e}")`）：`Error` 取 `message`（为空时取 `name`），
 * 字符串原样，带非空字符串 `message` 的对象取该字段（裸抛的 `AppError.*`、envelope），其余值尽量 JSON 化。
 * 对任何值都不抛错。替代 `error instanceof Error ? error.message : String(error)`——后者对 AppError 得到 `[object Object]`。
 */
export function errorDisplay(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
      const json = JSON.stringify(error, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
      if (json !== undefined) return json;
    }
    return String(error);
  } catch {
    // Proxy 陷阱、循环引用、抛错的 toJSON / getter。
    return opaqueDescription(error);
  }
}

/** 不读取任何属性的描述（`[object Object]` 之类）。 */
function opaqueDescription(error: unknown): string {
  try {
    return Object.prototype.toString.call(error);
  } catch {
    return 'unprintable thrown value';
  }
}

export const AppErrorType = {
  Validation: 'Validation', Database: 'Database', LLM: 'LLM', FileSystem: 'FileSystem',
  NotFound: 'NotFound', Configuration: 'Configuration', Network: 'Network', Conflict: 'Conflict', Unknown: 'Unknown',
} as const;
export type AppErrorType = typeof AppErrorType[keyof typeof AppErrorType];
export interface AppError { error_type: AppErrorType; message: string; details: JsonValue }
function appError(error_type: AppErrorType, message: string, details: JsonValue = null): AppError {
  return { error_type, message, details };
}
/** All factories return plain IPC values (Rust serde shape), not Error instances. */
export const AppError = {
  new: appError,
  with_details: appError,
  validation: (message: string) => appError('Validation', message),
  database: (message: string) => appError('Database', message),
  llm: (message: string) => appError('LLM', message),
  file_system: (message: string) => appError('FileSystem', message),
  not_found: (message: string) => appError('NotFound', message),
  configuration: (message: string) => appError('Configuration', message),
  network: (message: string) => appError('Network', message),
  authentication: (message: string) => appError('Network', message),
  unknown: (message: string) => appError('Unknown', message),
  internal: (message: string) => appError('Unknown', message),
  operation_failed: (message: string) => appError('Unknown', message),
  conflict: (message: string) => appError('Conflict', message),
  not_implemented: (message: string) => appError('Unknown', message),
  from: (message: string) => appError('Validation', message),
  from_zip: (message: string) => appError('FileSystem', `ZIP操作错误: ${message}`),
  from_anyhow: (message: string) => appError('Unknown', message),
  from_json: (message: string) => appError('Validation', `JSON序列化错误: ${message}`),
  from_io: (message: string) => appError('FileSystem', `文件系统错误: ${message}`),
  from_acquire: (message: string) => appError('Unknown', `Failed to acquire semaphore permit: ${message}`),
  from_sqlite: (message: string) => appError('Database', `数据库错误: ${message}`),
};

const APP_ERROR_TYPES: ReadonlySet<unknown> = new Set(Object.values(AppErrorType));
const APP_ERROR_KEYS: ReadonlySet<string> = new Set(['error_type', 'message', 'details']);

/**
 * 是否是 `AppError` 的 serde 形状：普通对象，恰好含 `error_type`（合法变体）/ `message`（字符串）/
 * `details` 三个自有键——与 Rust `AppError` 序列化结果以及上面工厂函数的返回值一致。
 * kernel 据此把处理函数裸抛的 `AppError.x(...)` 当作 `Err(AppError)` 发送。
 */
export function isAppErrorValue(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  if (keys.length !== APP_ERROR_KEYS.size || !keys.every((key) => APP_ERROR_KEYS.has(key))) return false;
  const record = value as Record<string, unknown>;
  return APP_ERROR_TYPES.has(record.error_type) && typeof record.message === 'string';
}
