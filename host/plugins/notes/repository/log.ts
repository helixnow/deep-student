/**
 * Lane logger sink. Rust tracing writes through the host log file; plugins must
 * not use `console.*`. `index.ts` binds this to `ctx.logger('notes')` during
 * apply; repository unit tests leave it unset (log-only side effects are
 * intentionally dropped there, mirroring a disabled log level).
 */
export interface NotesLogSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

let sink: NotesLogSink | null = null;

export function configureNotesLogger(next: NotesLogSink | null): void {
  sink = next;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const notesLog = {
  error(message: string): void {
    sink?.error(message);
  },
  warn(message: string): void {
    sink?.warn(message);
  },
  info(message: string): void {
    sink?.info(message);
  },
  debug(message: string): void {
    sink?.debug(message);
  },
  /** Rust `warn!("...: {}", e)` with a library error. */
  warnError(prefix: string, error: unknown): void {
    sink?.warn(`${prefix}: ${messageOf(error)}`);
  },
  debugError(prefix: string, error: unknown): void {
    sink?.debug(`${prefix}: ${messageOf(error)}`);
  },
};
