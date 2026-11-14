/**
 * Logging seam for chat_v2.
 *
 * Rust source modules log through the `log` crate (`log::warn!` etc.). The host
 * hands plugins a Cordis `ctx.logger`; production code passes it through to
 * repository calls. No process-global logger is shared between Host instances.
 */
export interface ChatLogger {
  error(format: string, ...params: unknown[]): void;
  warn(format: string, ...params: unknown[]): void;
  info(format: string, ...params: unknown[]): void;
  debug(format: string, ...params: unknown[]): void;
}

/** `{e}` in Rust formats the error's Display text; `String(error)` matches `to_string()`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
