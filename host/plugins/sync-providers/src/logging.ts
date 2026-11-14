/**
 * Logging seam for the Rust `tracing::warn!` / `log::warn!` sites.
 *
 * Production wiring injects the kernel logger (`ctx.logger(target)`) from
 * `index.ts`; tests can install a recorder. The default is a no-op only so
 * pure helper functions can run without a kernel context — every production
 * path is wired in `index.ts`.
 */

export interface LogSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

const noopSink: LogSink = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

let defaultSink: LogSink = noopSink;

export function setDefaultLogSink(sink: LogSink): void {
  defaultSink = sink;
}

export function defaultLogSink(): LogSink {
  return defaultSink;
}
