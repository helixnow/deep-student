// Port of dstu-browser/src/browser/error.rs. Repository helpers throw this wrapper so
// callers can map the tagged error to the same frontend strings as the Rust commands.

import { browserErrorMessage, type BrowserError } from './command-result.ts';

export class BrowserFailure extends Error {
  readonly error: BrowserError;

  constructor(error: BrowserError) {
    super(browserErrorMessage(error));
    this.name = 'BrowserFailure';
    this.error = error;
  }
}

export function browserValidation(message: string): BrowserFailure {
  return new BrowserFailure({ kind: 'Validation', message });
}

export function browserNotFound(message: string): BrowserFailure {
  return new BrowserFailure({ kind: 'NotFound', message });
}

export function browserNotOpen(): BrowserFailure {
  return new BrowserFailure({ kind: 'NotOpen' });
}

/** Storage/sqlite failures become `BrowserError::Sqlite` (same Display prefix). */
export function asBrowserFailure(error: unknown): BrowserFailure {
  if (error instanceof BrowserFailure) return error;
  return new BrowserFailure({
    kind: 'Sqlite',
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Run a database block, normalising native SQLite errors into `BrowserFailure`. */
export function databaseOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw asBrowserFailure(error);
  }
}
