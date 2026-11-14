import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { errorDisplay } from '../../kernel/error-model.ts';
import type { LogService } from './api.ts';
import { sanitizeDiagnosticMessage } from './diagnostics-sanitize.ts';

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

const label = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w.:|-]{1,160}$/.test(value) ? value : undefined;

export function diagnosticRecord(event: DiagnosticError): DiagnosticRecord {
  const message = event.error instanceof Error ? event.error.message : errorDisplay(event.error);
  let code: string | undefined;
  try { code = label((event.error as { details?: { code?: unknown } } | null)?.details?.code); } catch { /* boundary-allow empty-catch: hostile error value */ }
  return {
    code: label(event.code) ?? code,
    id: label(event.id) ?? globalThis.crypto.randomUUID(),
    source: event.source,
    operation: label(event.operation) ?? 'unknown',
    pluginId: label(event.pluginId),
    window: label(event.window),
    message: sanitizeDiagnosticMessage(message).slice(0, 1200),
    timestamp: new Date().toISOString(),
  };
}

export interface DiagnosticQuery {
  id?: string;
  operation?: string;
  pluginId?: string;
}

export async function queryDiagnosticErrors(log: Pick<LogService, 'logDir' | 'structured'>, query: DiagnosticQuery) {
  await log.structured.flush();
  const records: DiagnosticRecord[] = [];
  const missing: string[] = [];
  const scan = async (relative: string, match: RegExp, parse: (line: string) => unknown) => {
    const dir = join(log.logDir, relative);
    let files;
    try { files = await readdir(dir, { withFileTypes: true }); }
    catch { missing.push(relative || 'electron'); return; }
    const selected = files.filter(f => f.isFile() && match.test(f.name)).map(f => f.name);
    if (selected.length === 0) missing.push(relative || 'electron');
    for (const name of selected) {
      const stream = createReadStream(join(dir, name), { encoding: 'utf8' });
      try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          let r: DiagnosticRecord;
          try { r = parse(line) as DiagnosticRecord; } catch { continue; }
          if (!r || typeof r.timestamp !== 'string' || typeof r.message !== 'string' ||
              !['host', 'frontend', 'electron'].includes(r.source)) continue;
          if (query.id !== undefined && query.id !== r.id) continue;
          if (query.operation !== undefined && query.operation !== r.operation) continue;
          if (query.pluginId !== undefined && query.pluginId !== r.pluginId) continue;
          // Return only fields authored by the diagnostic boundary. Do not surface arbitrary log data.
          records.push({ source: r.source, timestamp: r.timestamp, operation: label(r.operation) ?? 'unknown',
            id: label(r.id) ?? 'unknown', code: label(r.code), pluginId: label(r.pluginId), window: label(r.window),
            message: sanitizeDiagnosticMessage(r.message).slice(0, 1200) });
          if (records.length > 40) {
            records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            records.length = 40;
          }
        }
      } catch { missing.push(relative ? relative + '/' + name : name); }
      finally { stream.destroy(); }
    }
  };
  await Promise.all([
    scan('backend', /^\d{4}-\d\d-\d\d_diagnostic\.log(?:\.\d+)?$/, line => JSON.parse(line).data),
    scan('', /^electron-main\.log(?:\.\d+)?$/, line => {
      const marker = '[diagnostic] ';
      const i = line.indexOf(marker);
      return i < 0 ? null : JSON.parse(line.slice(i + marker.length));
    }),
  ]);
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { records: records.slice(0, 12), sourcesWithoutRecords: ['host', 'frontend', 'electron'].filter(source =>
    !records.some(record => record.source === source)), missing, truncated: records.length > 12 };
}
