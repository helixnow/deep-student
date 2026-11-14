/**
 * F3 logging sink. `index.ts` wires it to `ctx.logger(target)`; standalone
 * tools and unit tests leave it unset (messages are dropped, like a disabled
 * tracing subscriber). Production code must never use `console.*`.
 */
import type { Logger } from '../log/api.ts';

export type StorageLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

type LoggerFactory = (target: string) => Logger;

let factory: LoggerFactory | null = null;
const cache = new Map<string, Logger>();

export function setStorageLogger(next: LoggerFactory | null): void {
  factory = next;
  cache.clear();
}

function loggerFor(target: string): Logger | null {
  if (factory === null) return null;
  let logger = cache.get(target);
  if (logger === undefined) {
    logger = factory(target);
    cache.set(target, logger);
  }
  return logger;
}

export function storageLog(target: string, level: StorageLogLevel, message: string): void {
  loggerFor(target)?.[level](message);
}
