/** Rust AppError wire values, independent of desktop file operations. */
export type AppErrorType =
  | 'Validation' | 'Database' | 'LLM' | 'FileSystem' | 'NotFound'
  | 'Configuration' | 'Network' | 'Conflict' | 'Unknown';

export interface AppErrorValue {
  error_type: AppErrorType;
  message: string;
  details: Record<string, unknown> | null;
}

export function appError(errorType: AppErrorType, message: string): AppErrorValue {
  return { error_type: errorType, message, details: null };
}

export function appErrorWithDetails(errorType: AppErrorType, message: string, details: Record<string, unknown>): AppErrorValue {
  return { error_type: errorType, message, details };
}

export function commandError(errorType: AppErrorType, message: string, errorCode: string): AppErrorValue {
  return appErrorWithDetails(errorType, message, { errorCode });
}
