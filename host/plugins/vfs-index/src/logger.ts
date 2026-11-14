/**
 * Lane logging facade.
 *
 * Production wiring passes `ctx.logger('vfs-index')` (Cordis); the interface is
 * deliberately narrow so services and repositories do not depend on the logger
 * implementation. Callers that omit it (unit tests of pure logic) simply do not
 * emit diagnostics, mirroring a disabled Rust `log` target.
 */
export interface LaneLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
