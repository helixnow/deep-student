/**
 * Portable `__audit_log` SQLite operations for mobile (`databases/audit.db`).
 * Zero `node:*` dependencies. Schema and validation rules match `host/plugins/backup/repository/audit.ts` & `src/governance.ts`.
 */
import type { SqlExecutor, SqlValue } from '../storage/api.ts';
import { toRfc3339 } from '../time/index.ts';

const CREATE_AUDIT_TABLE_SQL = `
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

export interface MobileAuditLogResponse {
  id: string;
  timestamp: string;
  operation_type: string;
  target: string;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
}

export function ensureAuditTable(db: SqlExecutor): void {
  db.exec(CREATE_AUDIT_TABLE_SQL);
}

export function saveMobileAuditEntry(
  db: SqlExecutor,
  entry: {
    id: string;
    operationType: 'Migration' | 'Backup' | 'Restore' | 'Sync' | 'Maintenance';
    operationData: Record<string, unknown>;
    target: string;
    status: 'Started' | 'Completed' | 'Failed' | 'Partial';
    durationMs: number | null;
    details?: unknown;
    errorMessage?: string | null;
  },
): void {
  ensureAuditTable(db);
  db.run(
    `INSERT INTO __audit_log (
      id, timestamp, operation_type, operation_data, target, status, duration_ms, details, error_message
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [
      entry.id,
      toRfc3339(),
      entry.operationType,
      JSON.stringify(entry.operationData),
      entry.target,
      entry.status,
      entry.durationMs,
      entry.details === undefined ? null : JSON.stringify(entry.details),
      entry.errorMessage ?? null,
    ],
  );
}

export function queryMobileAuditLogs(
  db: SqlExecutor,
  args: {
    operationType?: string | null;
    status?: string | null;
    limit?: number | null;
    offset?: number | null;
  },
): { logs: MobileAuditLogResponse[]; total: number } {
  ensureAuditTable(db);
  if (args.status != null && !['Started', 'Completed', 'Failed', 'Partial'].includes(args.status)) {
    throw new Error(`无效的状态过滤值: ${args.status}。可选值: Completed, Failed, Partial`);
  }
  let where = ' WHERE 1=1';
  const params: SqlValue[] = [];
  let idx = 1;
  if (args.operationType != null) {
    where += ` AND operation_type = ?${idx++}`;
    params.push(args.operationType);
  }
  if (args.status != null) {
    where += ` AND status = ?${idx++}`;
    params.push(args.status);
  }
  const total = Number(db.pluck<number>(`SELECT COUNT(*) FROM __audit_log${where}`, params) ?? 0);
  const limit = Math.max(1, Math.trunc(args.limit ?? 100));
  const offset = args.offset != null && args.offset > 0 ? Math.trunc(args.offset) : 0;
  const rows = db.all<{
    id: string;
    timestamp: string;
    operation_type: string;
    target: string;
    status: string;
    duration_ms: number | bigint | null;
    error_message: string | null;
  }>(
    `SELECT id, timestamp, operation_type, target, status, duration_ms, error_message
     FROM __audit_log${where} ORDER BY timestamp DESC LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ''}`,
    params,
  );
  return {
    logs: rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      operation_type: row.operation_type,
      target: row.target,
      status: row.status,
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
      error_message: row.error_message,
    })),
    total,
  };
}

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

function parseI64(text: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const value = BigInt(text);
  return value < I64_MIN || value > I64_MAX ? null : value;
}

export function cleanupMobileAuditLogs(
  db: SqlExecutor,
  args: {
    keepRecent?: number | null;
    beforeDays?: number | null;
    confirmationToken: string;
    generateId: () => string;
  },
): number {
  const TOKEN_PREFIX = 'AUDIT_CLEANUP_';
  const TOKEN_VALIDITY_SECS = 60;
  if (typeof args.confirmationToken !== 'string' || !args.confirmationToken.startsWith(TOKEN_PREFIX)) {
    throw new Error('审计清理令牌格式无效，需要 AUDIT_CLEANUP_{unix_timestamp}');
  }
  const tokenTsExact = parseI64(args.confirmationToken.slice(TOKEN_PREFIX.length));
  if (tokenTsExact === null) throw new Error('审计清理令牌中的时间戳无效');
  const delta = BigInt(Math.floor(Date.now() / 1000)) - tokenTsExact;
  const diff = delta < 0n ? -delta : delta;
  if (diff > BigInt(TOKEN_VALIDITY_SECS)) {
    throw new Error(`审计清理令牌已过期（差值 ${diff}s，允许 ${TOKEN_VALIDITY_SECS}s 内）`);
  }

  const MIN_KEEP_RECENT = 100;
  const MIN_BEFORE_DAYS = 7;
  if (args.keepRecent != null && args.keepRecent < MIN_KEEP_RECENT) {
    throw new Error(`keep_recent 不得低于 ${MIN_KEEP_RECENT}，当前值: ${args.keepRecent}`);
  }
  if (args.beforeDays != null && args.beforeDays < MIN_BEFORE_DAYS) {
    throw new Error(`before_days 不得低于 ${MIN_BEFORE_DAYS} 天，当前值: ${args.beforeDays}`);
  }

  ensureAuditTable(db);
  saveMobileAuditEntry(db, {
    id: args.generateId(),
    operationType: 'Maintenance',
    operationData: { type: 'Maintenance', action: 'cleanup_audit_logs' },
    target: 'cleanup_audit_logs_initiated',
    status: 'Completed',
    durationMs: 0,
    details: {
      keep_recent: args.keepRecent ?? null,
      before_days: args.beforeDays ?? null,
      confirmation_token_ts: Number(tokenTsExact),
    },
  });

  const DEFAULT_MAX_AGE_DAYS = 90;
  if (args.keepRecent != null) {
    return db.run(
      `DELETE FROM __audit_log WHERE id NOT IN (
         SELECT id FROM __audit_log ORDER BY timestamp DESC LIMIT ?1
       )`,
      [Math.trunc(args.keepRecent)],
    ).changes;
  }
  const days = Math.trunc(args.beforeDays ?? DEFAULT_MAX_AGE_DAYS);
  const cutoffMs = Date.now() - days * 86_400_000;
  const beforeIso = toRfc3339(BigInt(cutoffMs) * 1_000_000n);
  return db.run('DELETE FROM __audit_log WHERE timestamp < ?1', [beforeIso]).changes;
}
