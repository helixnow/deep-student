import type { SqlExecutor, SqlParam, SqlValue } from '../../../platform/storage/api.ts';
import { StorageError } from '../../../platform/storage/errors.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { MemoryAuditLogRecord } from '../api.ts';
import { f32, i64ToF32 } from '../src/f32.ts';

type AuditRow = Record<'id' | 'timestamp' | 'source' | 'operation' | 'success' | 'note_id' | 'title'
  | 'content_preview' | 'folder' | 'event' | 'confidence' | 'reason' | 'session_id' | 'duration_ms', SqlValue>;

function sqlType(value: SqlValue): string {
  if (value === null) return 'Null';
  if (typeof value === 'bigint') return 'Integer';
  if (typeof value === 'number') return 'Real';
  if (typeof value === 'string') return 'Text';
  return 'Blob';
}

// rusqlite 0.40 `Row::get` → `Error::InvalidColumnType` Display; VfsError::Database wraps it later.
function invalidColumnType(index: number, name: string, value: SqlValue): StorageError {
  return new StorageError('SQLITE', `Invalid column type ${sqlType(value)} at index: ${index}, name: ${name}`);
}

function readI64(row: AuditRow, index: number, name: keyof AuditRow): bigint {
  const value = row[name];
  if (typeof value !== 'bigint') throw invalidColumnType(index, name, value);
  return value;
}

function readString(row: AuditRow, index: number, name: keyof AuditRow): string {
  const value = row[name];
  if (typeof value !== 'string') throw invalidColumnType(index, name, value);
  return value;
}

function readOptionalString(row: AuditRow, index: number, name: keyof AuditRow): string | null {
  return row[name] === null ? null : readString(row, index, name);
}

/** Rust `row.get::<_, i32>(4)? != 0`. */
function readI32Flag(row: AuditRow): boolean {
  const value = readI64(row, 4, 'success');
  if (value < -2147483648n || value > 2147483647n) {
    throw new StorageError('SQLITE', `Integer ${value} out of range at index 4`);
  }
  return value !== 0n;
}

/** Rust `Option<f32>`: Integer is `i as f32`, Real is `f as f32`. */
function readOptionalF32(row: AuditRow): number | null {
  const value = row.confidence;
  if (value === null) return null;
  if (typeof value === 'bigint') return f32(i64ToF32(value));
  if (typeof value === 'number') return f32(value);
  throw invalidColumnType(10, 'confidence', value);
}

function decodeAuditRow(row: AuditRow): MemoryAuditLogRecord {
  return {
    id: readI64(row, 0, 'id'),
    timestamp: readString(row, 1, 'timestamp'),
    source: readString(row, 2, 'source'),
    operation: readString(row, 3, 'operation'),
    success: readI32Flag(row),
    noteId: readOptionalString(row, 5, 'note_id'),
    title: readOptionalString(row, 6, 'title'),
    contentPreview: readOptionalString(row, 7, 'content_preview'),
    folder: readOptionalString(row, 8, 'folder'),
    event: readOptionalString(row, 9, 'event'),
    confidence: readOptionalF32(row),
    reason: readOptionalString(row, 11, 'reason'),
    sessionId: readOptionalString(row, 12, 'session_id'),
    durationMs: row.duration_ms === null ? null : readI64(row, 13, 'duration_ms'),
  };
}

/** Rust `audit_log::query_audit_logs`: exact i64 rows, decoded per row in `query_map` order. */
export function queryAuditLogs(db: SqlExecutor, limit: number, offset: number,
  source: string | null, operation: string | null, success: boolean | null): MemoryAuditLogRecord[] {
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  for (const [column, value] of [['source', source], ['operation', operation], ['success', success]] as const) {
    if (value !== null) {
      params.push(value);
      conditions.push(`${column} = ?${params.length}`);
    }
  }
  const query = defineQuery<SqlParam[], AuditRow>(
    `SELECT id, timestamp, source, operation, success, note_id, title,
      content_preview, folder, event, confidence, reason, session_id, duration_ms
     FROM memory_audit_log ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    { name: 'memory.audit.query', options: { safeIntegers: true } });
  params.push(limit, offset);
  const records: MemoryAuditLogRecord[] = [];
  for (const row of db.iterate(query, params)) records.push(decodeAuditRow(row));
  return records;
}

export interface AuditEntryInput {
  source: string;
  operation: string;
  success: boolean;
  noteId: string | null;
  title: string | null;
  contentPreview: string | null;
  folder: string | null;
  event: string | null;
  confidence: number | null;
  reason: string | null;
  sessionId: string | null;
  durationMs: number | null;
  extraJson: string | null;
}

const insertAuditQuery = defineQuery<[string, string, number, string | null, string | null,
  string | null, string | null, string | null, number | null, string | null, string | null,
  number | null, string | null]>(
  `INSERT INTO memory_audit_log
     (source, operation, success, note_id, title, content_preview,
      folder, event, confidence, reason, session_id, duration_ms, extra_json)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  { name: 'memory.audit.insert' });

export function truncatePreview(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}...`;
}

/** Rust `MemoryAuditLogger::log`: preview is 100 chars, failures only warn. */
export function insertAuditLog(db: SqlExecutor, entry: AuditEntryInput,
  warn: (message: string) => void = () => undefined): void {
  try {
    db.run(insertAuditQuery, [entry.source, entry.operation, entry.success ? 1 : 0,
      entry.noteId, entry.title,
      entry.contentPreview === null ? null : truncatePreview(entry.contentPreview, 100),
      entry.folder, entry.event, entry.confidence, entry.reason, entry.sessionId,
      entry.durationMs, entry.extraJson]);
  } catch (error) {
    // Rust logs a warning and keeps the command successful.
    warn(`[Memory] Failed to write audit log: ${error instanceof Error ? error.message : String(error)}`);
  }
}
