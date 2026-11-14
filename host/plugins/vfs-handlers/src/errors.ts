/** Command-layer error envelopes shared by the migrated vfs command handlers. */
import type { Context } from '@deepseek-ai/cordis';
import { VfsError, type VfsCommandError } from '../../vfs/portable.ts';
import { VfsRepositoryError } from '../../vfs-repos/api.ts';

/** dstu_core::error_details::CommandError serde shape (traceId is camelCase on the wire). */
export interface CommandErrorEnvelope {
  code: string;
  message: string;
  data?: unknown;
  traceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** VfsError or VfsRepositoryError -> CommandError envelope; anything else is a programming error. */
export function toCommandEnvelope(error: unknown): { code: string; message: string; data?: unknown } {
  if (error instanceof VfsRepositoryError) return error.toCommandError();
  if (error instanceof VfsError) return error.toCommandError();
  throw error;
}

/** Mirrors todo_handlers::cmd_err: log a warning and attach a fresh trace id. */
export function todoCommandError(
  log: Context['logger'],
  command: string,
  error: unknown,
): CommandErrorEnvelope {
  const envelope: CommandErrorEnvelope = { ...toCommandEnvelope(error) };
  envelope.traceId = crypto.randomUUID();
  log.warn('[todo_handlers] %s failed: code=%s trace_id=%s message=%s',
    command, envelope.code, envelope.traceId, envelope.message);
  return envelope;
}

/** Envelope already shaped like VfsError::to_command_error (e.g. ItemNotFound built by hand). */
export function envelopeCommandError(
  log: Context['logger'],
  command: string,
  envelope: VfsCommandError,
): CommandErrorEnvelope {
  const result: CommandErrorEnvelope = { ...envelope, traceId: crypto.randomUUID() };
  log.warn('[todo_handlers] %s failed: code=%s trace_id=%s message=%s',
    command, result.code, result.traceId, result.message);
  return result;
}

/** Mirrors todo_handlers::cmd_err_custom for non-VfsError sources. */
export function customCommandError(
  log: Context['logger'],
  command: string,
  code: string,
  message: string,
): CommandErrorEnvelope {
  const envelope: CommandErrorEnvelope = { code, message, traceId: crypto.randomUUID() };
  log.warn('[todo_handlers] %s failed: code=%s trace_id=%s message=%s',
    command, envelope.code, envelope.traceId, envelope.message);
  return envelope;
}

/**
 * Pomodoro commands keep the legacy `Result<T, String>` contract: the VfsError
 * Display text is returned verbatim (todo_handlers::run_pomodoro_blocking).
 */
export function pomodoroErrorMessage(error: unknown): string {
  if (error instanceof VfsRepositoryError || error instanceof VfsError) return error.message;
  throw error;
}

export { isRecord };
