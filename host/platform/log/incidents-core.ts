/**
 * Portable diagnostic incident record types and formatter (zero `node:*`).
 * Shared between desktop `incidents.ts` and mobile `log/mobile.ts`.
 */
import { errorDisplay } from '../../kernel/error-model.ts';
import { sanitizeDiagnosticMessageWithPlatform } from './diagnostics-sanitize-core.ts';

export interface DiagnosticError {
  source: 'host' | 'frontend' | 'electron';
  operation: string;
  id?: string;
  pluginId?: string;
  window?: string;
  code?: string;
  error: unknown;
}

export interface DiagnosticRecord {
  source: DiagnosticError['source'];
  operation: string;
  id: string;
  pluginId?: string;
  window?: string;
  message: string;
  code?: string;
  timestamp: string;
}

export interface DiagnosticQuery {
  id?: string;
  operation?: string;
  pluginId?: string;
}

export const diagnosticLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w.:|-]{1,160}$/.test(value) ? value : undefined;

export function diagnosticRecord(event: DiagnosticError, platform = 'linux'): DiagnosticRecord {
  const message = event.error instanceof Error ? event.error.message : errorDisplay(event.error);
  let code: string | undefined;
  try {
    code = diagnosticLabel((event.error as { details?: { code?: unknown } } | null)?.details?.code);
  } catch {
    code = undefined;
  }
  return {
    code: diagnosticLabel(event.code) ?? code,
    id: diagnosticLabel(event.id) ?? globalThis.crypto.randomUUID(),
    source: event.source,
    operation: diagnosticLabel(event.operation) ?? 'unknown',
    pluginId: diagnosticLabel(event.pluginId),
    window: diagnosticLabel(event.window),
    message: sanitizeDiagnosticMessageWithPlatform(message, platform).slice(0, 1200),
    timestamp: new Date().toISOString(),
  };
}
