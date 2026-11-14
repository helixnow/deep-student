/**
 * `sync/mod.rs:400-475` `SyncError` 中本 lane 产生的变体。
 *
 * `message` 与 Rust `Display`（thiserror `#[error(...)]`）逐字一致：
 * - `IO error: {0}`
 * - `Database error: {0}`
 * - `Network error: {0}`
 * - `Clock drift suspected: {table}.{record_id} timestamp is {drift_ms}ms in the future`
 */
export type SyncSupportErrorKind = 'Io' | 'Database' | 'Network' | 'ClockDriftSuspected';

export interface SyncSupportErrorOptions {
  readonly table?: string;
  readonly recordId?: string;
  readonly driftMs?: number;
  readonly cause?: unknown;
}

export class SyncSupportError extends Error {
  readonly kind: SyncSupportErrorKind;
  readonly table: string | undefined;
  readonly recordId: string | undefined;
  readonly driftMs: number | undefined;

  constructor(kind: SyncSupportErrorKind, message: string, options: SyncSupportErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SyncSupportError';
    this.kind = kind;
    this.table = options.table;
    this.recordId = options.recordId;
    this.driftMs = options.driftMs;
  }
}

export function databaseError(detail: string): never {
  throw new SyncSupportError('Database', `Database error: ${detail}`);
}

export function networkError(detail: string): never {
  throw new SyncSupportError('Network', `Network error: ${detail}`);
}

export function ioError(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  throw new SyncSupportError('Io', `IO error: ${detail}`, { cause: error });
}

/** `SyncError::ClockDriftSuspected`。 */
export function clockDriftSuspected(table: string, recordId: string, driftMs: number): never {
  throw new SyncSupportError(
    'ClockDriftSuspected',
    `Clock drift suspected: ${table}.${recordId} timestamp is ${driftMs}ms in the future`,
    { table, recordId, driftMs },
  );
}

export function isClockDriftSuspected(error: unknown): error is SyncSupportError {
  return error instanceof SyncSupportError && error.kind === 'ClockDriftSuspected';
}

/** 任意异常 → `SyncError::Database`（Rust 中 `map_err(error)` 的等价物）。 */
export function asDatabaseError(error: unknown): never {
  if (error instanceof SyncSupportError) throw error;
  databaseError(error instanceof Error ? error.message : String(error));
}
