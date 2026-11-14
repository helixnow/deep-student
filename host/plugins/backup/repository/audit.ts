import { randomUUID } from 'node:crypto';
import { defineQuery, type SqlExecutor, type SqlParams, type SqlValue } from '../../../platform/storage/api.ts';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import {
  JsonReader, jsonNumberToRawJSON, jsonUnexpected, parseJsonDocument, stringifyJsonValue, type JsonNode,
} from '../../../platform/util/portable.ts';

export type AuditStatus = 'Started' | 'Completed' | 'Failed' | 'Partial';
export type AuditOperationType = 'Migration' | 'Backup' | 'Restore' | 'Sync' | 'Maintenance';
/** 安全范围内维持 number；持久化的合法 usize/u64 宽整数必须保留为 bigint（D3）。 */
type AuditUnsigned = number | bigint;

export type AuditOperation =
  | { type: 'Migration'; from_version: number; to_version: number; applied_count: AuditUnsigned }
  | { type: 'Backup'; backup_type: 'Full' | 'Incremental' | 'Auto'; file_count: AuditUnsigned; total_size: AuditUnsigned }
  | { type: 'Restore'; backup_path: string }
  | { type: 'Sync'; direction: 'Upload' | 'Download' | 'Bidirectional'; records_affected: AuditUnsigned }
  | { type: 'Maintenance'; action: string };

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  operation: AuditOperation;
  target: string;
  status: AuditStatus;
  duration_ms: AuditUnsigned | null;
  details: unknown;
  error_message: string | null;
}

export interface AuditFilter {
  operation_type?: string;
  from_time?: string;
  to_time?: string;
  status?: AuditStatus;
  limit?: number;
  offset?: number;
}

export interface AuditLogResponse {
  id: string;
  timestamp: string;
  operation_type: string;
  target: string;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
}

export interface AuditQueryResult {
  logs: AuditLogEntry[];
  total: number;
}

const CREATE_TABLE_SQL = `
        CREATE TABLE IF NOT EXISTS __audit_log (
            id TEXT PRIMARY KEY NOT NULL,
            timestamp TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            operation_data TEXT NOT NULL,
            target TEXT NOT NULL,
            status TEXT NOT NULL,
            duration_ms INTEGER,
            details TEXT,
            error_message TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON __audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_log_operation_type ON __audit_log(operation_type);
        CREATE INDEX IF NOT EXISTS idx_audit_log_status ON __audit_log(status);
    `;

const INSERT_SQL = `
        INSERT INTO __audit_log (
            id, timestamp, operation_type, operation_data, target,
            status, duration_ms, details, error_message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `;

export function newAuditLog(operation: AuditOperation, target: string): AuditLogEntry {
  return {
    id: randomUUID(),
    timestamp: toRfc3339(),
    operation,
    target,
    status: 'Started',
    duration_ms: null,
    details: null,
    error_message: null,
  };
}

export function completeAuditLog(log: AuditLogEntry, durationMs: number): AuditLogEntry {
  return { ...log, status: 'Completed', duration_ms: durationMs };
}

export function failAuditLog(log: AuditLogEntry, error: string): AuditLogEntry {
  return { ...log, status: 'Failed', error_message: error };
}

export function partialAuditLog(log: AuditLogEntry, reason: string, durationMs: number): AuditLogEntry {
  return { ...log, status: 'Partial', duration_ms: durationMs, error_message: reason };
}

export function withAuditDetails(log: AuditLogEntry, details: unknown): AuditLogEntry {
  return { ...log, details };
}

export function auditOperationType(operation: AuditOperation): AuditOperationType {
  return operation.type;
}

function statusToStr(status: AuditStatus): string {
  return status;
}

function strToStatus(value: string): AuditStatus {
  return value === 'Completed' || value === 'Failed' || value === 'Partial' ? value : 'Started';
}

export function initAuditTable(db: SqlExecutor): void {
  db.exec(CREATE_TABLE_SQL);
}

/** 从SQL读出的details保留原始Value树，使同一对象再保存时保重复键last-wins/首次键序。 */
const detailsNodes = new WeakMap<object, JsonNode>();

/** Node/Electron 支持标准 JSON.rawJSON；整数以 JSON 数字原文存储，不先转 number 或加引号。 */
function exactInteger(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
    return json.rawJSON(value.toString());
  }
  return value;
}

function stringifyDetails(details: unknown): string {
  if (details !== null && typeof details === 'object') {
    const node = detailsNodes.get(details);
    if (node !== undefined) return stringifyJsonValue(node);
  }
  return JSON.stringify(details ?? null, exactInteger);
}

/** `AuditRepository::save`：非 Started 先关闭最近的 Started 行（按 job_id 或 target）。 */
export function saveAuditLog(db: SqlExecutor, log: AuditLogEntry): void {
  const operationType = auditOperationType(log.operation);
  const operationData = JSON.stringify(log.operation, exactInteger);
  const status = statusToStr(log.status);
  const details = stringifyDetails(log.details);
  const timestamp = log.timestamp;
  const jobId = log.details && typeof log.details === 'object' && !Array.isArray(log.details)
    ? (log.details as Record<string, unknown>).job_id
    : undefined;
  const correlationJobId = typeof jobId === 'string' ? jobId : null;

  if (log.status !== 'Started') {
    const updated = db.run(
      `UPDATE __audit_log
       SET target = ?1, operation_data = ?2, status = ?3, duration_ms = ?4,
           details = ?5, error_message = ?6
       WHERE id = (
           SELECT id FROM __audit_log
           WHERE operation_type = ?7 AND status = 'Started'
             AND (
                 (?9 IS NOT NULL AND json_extract(details, '$.job_id') = ?9)
                 OR (?9 IS NULL AND target = ?8)
             )
           ORDER BY timestamp DESC LIMIT 1
       )`,
      [log.target, operationData, status, log.duration_ms, details, log.error_message,
        operationType, log.target, correlationJobId],
    );
    if (updated.changes === 1) return;
  }

  db.run(INSERT_SQL, [
    log.id, timestamp, operationType, operationData, log.target,
    status, log.duration_ms, details, log.error_message,
  ]);
}

interface AuditRow {
  id: SqlValue;
  timestamp: SqlValue;
  operation_type: SqlValue;
  operation_data: SqlValue;
  target: SqlValue;
  status: SqlValue;
  duration_ms: SqlValue;
  details: SqlValue;
  error_message: SqlValue;
}

const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** serde `#[serde(tag = "type")] AuditOperation`（dstu-storage audit/mod.rs:43-90）。 */
export function decodeAuditOperation(text: string): AuditOperation {
  // 不能先 JSON.parse：1.0/1e0/-0 会失去词法类型，u64边界会先舍入。
  const reader = new JsonReader(text);
  const node = reader.readValue();
  const invalidType = (value: JsonNode, expected: string): Error =>
    new Error(`invalid type: ${jsonUnexpected(value)}, expected ${expected}`);
  if (node.kind !== 'object') {
    throw invalidType(node, 'internally tagged enum AuditOperation');
  }
  const field = (key: string): JsonNode => {
    const entries = node.members.filter(member => member.key === key);
    if (entries.length === 0) throw new Error(`missing field \`${key}\``);
    if (entries.length > 1) throw new Error(`duplicate field \`${key}\``);
    return entries[0]!.value;
  };
  const uint = (key: string, width: 'u32' | 'u64' | 'usize', max = U64_MAX): AuditUnsigned => {
    const value = field(key);
    if (value.kind !== 'number') throw invalidType(value, width);
    // Value可含arbitrary raw；有界字段必须走F4 typed数字读取，不假定Value数字都有.value。
    const number = new JsonReader(value.value.raw).readNumber(width);
    if (number.kind === 'f64') throw invalidType(value, width);
    const integer = number.value;
    if (integer < 0n || integer > max) {
      throw new Error(`invalid value: ${jsonUnexpected(value)}, expected ${width}`);
    }
    return integer <= SAFE_INTEGER_MAX ? Number(integer) : integer;
  };
  const string = (key: string): string => {
    const value = field(key);
    if (value.kind !== 'string') throw invalidType(value, 'a string');
    return value.value;
  };
  const unknownVariant = (name: string, allowed: readonly string[]): Error =>
    new Error(`unknown variant \`${name}\`, expected one of ${allowed.map(item => `\`${item}\``).join(', ')}`);
  const variant = <T extends string>(key: string, allowed: readonly T[]): T => {
    const value = field(key);
    let name: string;
    let body: JsonNode | undefined;
    if (value.kind === 'string') name = value.value;
    else if (value.kind === 'object') {
      if (value.members.length !== 1) throw new Error('invalid value: map, expected map with a single key');
      name = value.members[0]!.key;
      body = value.members[0]!.value;
    } else {
      throw invalidType(value, 'string or map');
    }
    if (!(allowed as readonly string[]).includes(name)) throw unknownVariant(name, allowed);
    if (body !== undefined && body.kind !== 'null') throw invalidType(body, 'unit');
    return name as T;
  };
  const tag = field('type');
  if (tag.kind !== 'string') throw invalidType(tag, 'variant identifier');
  let operation: AuditOperation;
  switch (tag.value) {
    case 'Migration':
      operation = {
        // u32已先按bigint检查范围，转number不会丢精度。
        type: 'Migration', from_version: Number(uint('from_version', 'u32', U32_MAX)),
        to_version: Number(uint('to_version', 'u32', U32_MAX)), applied_count: uint('applied_count', 'usize'),
      };
      break;
    case 'Backup':
      operation = {
        type: 'Backup', backup_type: variant('backup_type', ['Full', 'Incremental', 'Auto'] as const),
        file_count: uint('file_count', 'usize'), total_size: uint('total_size', 'u64'),
      };
      break;
    case 'Restore':
      operation = { type: 'Restore', backup_path: string('backup_path') };
      break;
    case 'Sync':
      operation = {
        type: 'Sync', direction: variant('direction', ['Upload', 'Download', 'Bidirectional'] as const),
        records_affected: uint('records_affected', 'usize'),
      };
      break;
    case 'Maintenance':
      operation = { type: 'Maintenance', action: string('action') };
      break;
    default:
      throw unknownVariant(tag.value, ['Migration', 'Backup', 'Restore', 'Sync', 'Maintenance']);
  }
  reader.end();
  return operation;
}

/** 对应 rusqlite 0.40.1 InvalidColumnType Display；safeIntegers 查询中 number 是 REAL，INTEGER 是 bigint。 */
function invalidSqlColumn(value: SqlValue, index: number, name: string): Error {
  const kind = value === null ? 'Null' : typeof value === 'bigint' ? 'Integer'
    : typeof value === 'number' ? 'Real' : typeof value === 'string' ? 'Text' : 'Blob';
  return new Error(`Database error: Invalid column type ${kind} at index: ${index}, name: ${name}`);
}

function sqlString(value: SqlValue, index: number, name: string): string {
  if (typeof value !== 'string') throw invalidSqlColumn(value, index, name);
  return value;
}

function optionalSqlString(value: SqlValue, index: number, name: string): string | null {
  return value === null ? null : sqlString(value, index, name);
}

/** SQLite INTEGER物理上限为i64::MAX；Rust row.get::<Option<u64>>仅接收非负INTEGER或NULL。 */
function sqlDuration(value: SqlValue): AuditUnsigned | null {
  if (value === null) return null;
  if (typeof value !== 'bigint') throw invalidSqlColumn(value, 6, 'duration_ms');
  if (value < 0n) throw new Error(`Database error: Integer ${value} out of range at index 6`);
  return value <= SAFE_INTEGER_MAX ? Number(value) : value;
}

/** 桌面serde_json::Value开启arbitrary_precision；数字投影使用F4正式raw原子，不先Number。 */
function auditDetailsValue(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool':
    case 'string': return node.value;
    case 'number': {
      const number = node.value;
      if (number.kind === 'u64' || number.kind === 'i64') {
        return number.value >= -SAFE_INTEGER_MAX && number.value <= SAFE_INTEGER_MAX ? Number(number.value) : number.value;
      }
      return jsonNumberToRawJSON(number);
    }
    case 'array': {
      const value = node.items.map(auditDetailsValue);
      detailsNodes.set(value, node);
      return value;
    }
    case 'object': {
      const value = Object.fromEntries(node.members.map(member => [member.key, auditDetailsValue(member.value)]));
      detailsNodes.set(value, node);
      return value;
    }
  }
}

function rowToAuditLog(row: AuditRow): AuditLogEntry {
  // Rust audit/mod.rs:768-776 先按列序做FromSql转换，之后才解析时间/operation JSON。
  const id = sqlString(row.id, 0, 'id');
  const timestampText = sqlString(row.timestamp, 1, 'timestamp');
  sqlString(row.operation_type, 2, 'operation_type'); // Native同样读取类型，但最终类型来自operation_data。
  const operationText = sqlString(row.operation_data, 3, 'operation_data');
  const target = sqlString(row.target, 4, 'target');
  const status = sqlString(row.status, 5, 'status');
  const duration = sqlDuration(row.duration_ms);
  const detailsText = optionalSqlString(row.details, 7, 'details');
  const errorMessage = optionalSqlString(row.error_message, 8, 'error_message');
  // Rust audit/mod.rs:779-793：chrono parse_from_rfc3339（保留纳秒）+ serde 解码 AuditOperation。
  const timestamp = parseRfc3339(timestampText);
  if (timestamp === null) throw new Error(`Database error: Invalid timestamp: ${timestampText}`);
  let operation: AuditOperation;
  try { operation = decodeAuditOperation(operationText); }
  catch (e) { throw new Error(`Serialization error: ${e instanceof Error ? e.message : String(e)}`); }
  let details: unknown = null;
  if (detailsText) {
    try { details = auditDetailsValue(parseJsonDocument(detailsText)); }
    catch { details = null; }
  }
  return {
    id,
    timestamp: toRfc3339(timestamp.epochNanos),
    operation,
    target,
    status: strToStatus(status),
    duration_ms: duration,
    details,
    error_message: errorMessage,
  };
}

function whereClause(filter: AuditFilter): { sql: string; params: (string | number)[] } {
  let sql = ' WHERE 1=1';
  const params: (string | number)[] = [];
  let index = 1;
  if (filter.operation_type !== undefined) {
    sql += ` AND operation_type = ?${index++}`;
    params.push(filter.operation_type);
  }
  if (filter.from_time !== undefined) {
    sql += ` AND timestamp >= ?${index++}`;
    params.push(filter.from_time);
  }
  if (filter.to_time !== undefined) {
    sql += ` AND timestamp <= ?${index++}`;
    params.push(filter.to_time);
  }
  if (filter.status !== undefined) {
    sql += ` AND status = ?${index}`;
    params.push(statusToStr(filter.status));
  }
  return { sql, params };
}

/** `AuditRepository::query`。 */
export function queryAuditLogs(db: SqlExecutor, filter: AuditFilter): AuditLogEntry[] {
  const where = whereClause(filter);
  let sql = `SELECT id, timestamp, operation_type, operation_data, target,
                    status, duration_ms, details, error_message
             FROM __audit_log${where.sql} ORDER BY timestamp DESC`;
  if (filter.limit !== undefined) sql += ` LIMIT ${Math.trunc(filter.limit)}`;
  if (filter.offset !== undefined && filter.offset > 0) sql += ` OFFSET ${Math.trunc(filter.offset)}`;
  const query = defineQuery<SqlParams, AuditRow>(sql, {
    name: 'backup.audit.query', options: { safeIntegers: true },
  });
  return db.all(query, where.params).map(rowToAuditLog);
}

/** `AuditRepository::query_paged`。 */
export function queryAuditLogsPaged(db: SqlExecutor, filter: AuditFilter): AuditQueryResult {
  const where = whereClause(filter);
  const total = Number(db.pluck<number>(`SELECT COUNT(*) FROM __audit_log${where.sql}`, where.params) ?? 0);
  return { logs: queryAuditLogs(db, filter), total };
}

/** `AuditRepository::cleanup_keep_recent`。 */
export function cleanupKeepRecent(db: SqlExecutor, keepCount: number): number {
  const result = db.run(
    `DELETE FROM __audit_log WHERE id NOT IN (
        SELECT id FROM __audit_log ORDER BY timestamp DESC LIMIT ?1
    )`,
    [Math.trunc(keepCount)],
  );
  return result.changes;
}

/** `AuditRepository::cleanup_before`。 */
export function cleanupBefore(db: SqlExecutor, before: string): number {
  return db.run('DELETE FROM __audit_log WHERE timestamp < ?1', [before]).changes;
}

/** `AuditRepository::cleanup_old_entries`。 */
export function cleanupOldEntries(db: SqlExecutor, maxAgeDays: number, now = new Date()): number {
  const before = new Date(now.getTime() - Math.trunc(maxAgeDays) * 86_400_000);
  return cleanupBefore(db, toRfc3339(BigInt(before.getTime()) * 1_000_000n));
}

/** `AuditLogResponse::from`。 */
export function toAuditLogResponse(log: AuditLogEntry): AuditLogResponse {
  return {
    id: log.id,
    timestamp: log.timestamp,
    operation_type: auditOperationType(log.operation),
    target: log.target,
    status: log.status,
    // D3：只有这个IPC summary边界才与Tauri前端JSON number一样舍入，内部/写库保持精确。
    duration_ms: log.duration_ms === null ? null : Number(log.duration_ms),
    error_message: log.error_message,
  };
}
