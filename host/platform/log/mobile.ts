/** Bounded, redacted Worker logs. Logs are intentionally memory-only (not desktop disk archives). */
import { definePlugin } from '../../kernel/core.ts';
import type { LogService, LogLevel, StructuredLogger } from './api.ts';
import { redactSensitiveText, redactSensitiveFields, sanitizeForLevel } from './redact.ts';

export function createMobileLog(logDir: string, capacity = 500): LogService & { entries(): readonly string[] } {
  const ring: string[] = [];
  const write = (level: LogLevel, target: string, message: string) => {
    const entry = redactSensitiveText(`[${level}][${target}] ${message}`);
    ring.push(entry);
    if (ring.length > capacity) ring.shift();
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(entry);
  };
  const record = async (operation: string, data: unknown) => { write('debug', operation, JSON.stringify(redactSensitiveFields(data))); };
  const structured: StructuredLogger = {
    async log(level, module, operation, data) { write(level.toLowerCase() as LogLevel, module, `${operation}: ${JSON.stringify(redactSensitiveFields(data))}`); },
    logDatabaseOperation: (...args) => record('database', args), logChatRecordOperation: (...args) => record('chat', args),
    logRagOperation: (...args) => record('rag', args), logStreamingOperation: (...args) => record('stream', args),
    logApiCall: (...args) => record('api', args), logStateChange: (...args) => record('state', args),
    logLlmUsage: (...args) => record('llm', args), async flush() {},
    async writeFrontendEntries(entries) { for (const entry of entries) await record(entry.module, entry); },
  };
  return {
    async recordError(event) { write('error', event.operation, String(event.error)); },
    async queryErrors() { return { records: [], sourcesWithoutRecords: ['host', 'frontend', 'electron'], missing: ['desktop log archive is unavailable on mobile'], truncated: false }; },
    logDir, mainLogFile: `${logDir}/deep-student.log`, write, enabled: () => true,
    logger(target) { return { target, error: message => write('error', target, message), warn: message => write('warn', target, message),
      info: message => write('info', target, message), debug: message => write('debug', target, message), trace: message => write('trace', target, message) }; },
    structured,
    debugLogs: {
      ensureDir: () => `${logDir}/debug-logs`, writeRequestEntry: () => null, writeResponseEntry: () => null,
      async flushPending() { return true; }, roots: () => [logDir],
      info: () => ({ count: 0, total_size_bytes: 0, total_size_display: '0 B', oldest_file: null, newest_file: null }),
      clearAll: () => 0, cleanupOld: () => 0,
      readFile() { throw new Error('UNSUPPORTED_ON_PLATFORM: log.diskArchive is not available on mobile'); },
    },
    writeCrashLog(error) { write('error', 'crash', String(error)); return ''; },
    redactSensitiveText, redactSensitiveFields, sanitizeForLevel,
    scrubPii: input => redactSensitiveText(input).split(logDir).join('<logs>'),
    entries: () => [...ring],
  };
}

export default definePlugin({
  meta: { id: 'dstu.platform.log', provides: ['log'], platforms: ['mobile'] },
  inject: ['paths'],
  apply(ctx) { ctx.reflect.provide('log', createMobileLog(ctx.paths.appLogDir)); },
});
