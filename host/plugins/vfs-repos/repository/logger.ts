/**
 * Repository logging seam. `index.ts` injects the Cordis logger in production;
 * tests that instantiate repositories directly get a silent sink. Rust
 * `warn!`/`error!`/`info!`/`debug!` calls are forwarded unchanged so the
 * message, target and severity stay observable in the application log.
 */
export type RepositoryLogMethod = (format: unknown, ...params: unknown[]) => void;

export interface RepositoryLogger {
  error: RepositoryLogMethod;
  warn: RepositoryLogMethod;
  info: RepositoryLogMethod;
  debug: RepositoryLogMethod;
}

const silentLogger: RepositoryLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

let activeLogger: RepositoryLogger = silentLogger;

export function setRepositoryLogger(logger: RepositoryLogger): void {
  activeLogger = logger;
}

export function logError(format: unknown, ...params: unknown[]): void {
  activeLogger.error(format, ...params);
}

export function logWarn(format: unknown, ...params: unknown[]): void {
  activeLogger.warn(format, ...params);
}

export function logInfo(format: unknown, ...params: unknown[]): void {
  activeLogger.info(format, ...params);
}

export function logDebug(format: unknown, ...params: unknown[]): void {
  activeLogger.debug(format, ...params);
}
