import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';

export function appError(error_type: AppError['error_type'], message: string): CommandError {
  return new CommandError(AppError.new(error_type, message));
}
/** Rust `{}`：AppError 的 Display 只输出 message（models.rs:1038-1042），裸抛与 CommandError 包装同样处理。 */
export function errorText(error: unknown): string {
  const value = error instanceof CommandError ? error.value : error;
  if (value !== null && typeof value === 'object' && !(value instanceof Error)) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}
