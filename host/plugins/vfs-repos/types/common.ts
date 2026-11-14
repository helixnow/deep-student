/** Shared error and JSON value contracts. */
/** Repository error (Rust VfsError Display and stable command envelope). */
export class VfsRepositoryError extends Error {
  readonly code: string;
  readonly data?: Record<string, JsonValue>;
  constructor(code: string, message: string, data?: Record<string, JsonValue>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'VfsRepositoryError';
    this.code = code;
    this.data = data;
  }
  toCommandError(): { code: string; message: string; data?: Record<string, JsonValue> } {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
