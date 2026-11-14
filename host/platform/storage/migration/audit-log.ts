/**
 * 迁移协调器的审计写入，移植自：
 * - `dstu-storage/src/audit/mod.rs`：`AuditLog`（new/complete/fail/with_details）、`AuditOperation`
 *   （serde `tag = "type"`）、`AuditRepository::{CREATE_TABLE_SQL, init, save, log_migration_complete}`；
 * - `migration/coordinator.rs`：`log_migration_audit`、`log_migration_failure`、`log_checksum_repair_audit`。
 *
 * 行格式与 Rust 一致：`operation_data` = `serde_json::to_string(&operation)`，`details` =
 * `serde_json::to_string(&details)`（workspace 启用 `preserve_order`，对象键保持插入顺序），
 * `timestamp` = chrono `to_rfc3339()`。审计失败只记日志，不影响迁移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { errorText } from './errors.ts';
import type { MigrationLog } from './helpers.ts';
import { chronoRfc3339Now } from './refinery.ts';

export const AUDIT_CREATE_TABLE_SQL = `
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

const AUDIT_INSERT_SQL = `
        INSERT INTO __audit_log (
            id, timestamp, operation_type, operation_data, target,
            status, duration_ms, details, error_message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `;

const AUDIT_CLOSE_STARTED_SQL = `UPDATE __audit_log
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
                     )`;

/** 迁移协调器只产生 `Migration` 操作；字段顺序即 serde 输出顺序。 */
export interface MigrationAuditOperation {
  type: 'Migration';
  from_version: number;
  to_version: number;
  applied_count: number;
}

export type AuditStatus = 'Started' | 'Completed' | 'Failed' | 'Partial';

export class AuditLog {
  id = randomUUID();
  timestamp = chronoRfc3339Now();
  status: AuditStatus = 'Started';
  durationMs: number | null = null;
  details: unknown = null;
  errorMessage: string | null = null;

  readonly operation: MigrationAuditOperation;
  readonly target: string;

  constructor(
    operation: MigrationAuditOperation,
    target: string,
  ) {
    this.operation = operation;
    this.target = target;
  }

  complete(durationMs: number): this {
    this.status = 'Completed';
    this.durationMs = durationMs;
    return this;
  }

  fail(error: string): this {
    this.status = 'Failed';
    this.errorMessage = error;
    return this;
  }

  withDetails(details: unknown): this {
    this.details = details;
    return this;
  }
}

export function migrationOperation(fromVersion: number, toVersion: number, appliedCount: number): MigrationAuditOperation {
  return { type: 'Migration', from_version: fromVersion, to_version: toVersion, applied_count: appliedCount };
}

/** `AuditRepository::init`。 */
export function initAuditTable(conn: Connection): void {
  conn.exec(AUDIT_CREATE_TABLE_SQL);
}

/** `AuditRepository::save`：非 Started 状态先尝试关闭最近的同类 Started 行，否则插入。 */
export function saveAuditLog(conn: Connection, log: AuditLog): void {
  const operationType = 'Migration';
  const operationData = JSON.stringify(log.operation);
  const detailsStr = JSON.stringify(log.details);
  const details = log.details;
  const jobId =
    typeof details === 'object' && details !== null && !Array.isArray(details) && typeof (details as Record<string, unknown>).job_id === 'string'
      ? ((details as Record<string, unknown>).job_id as string)
      : null;
  if (log.status !== 'Started') {
    const updated = conn.run(AUDIT_CLOSE_STARTED_SQL, [
      log.target,
      operationData,
      log.status,
      log.durationMs,
      detailsStr,
      log.errorMessage,
      operationType,
      log.target,
      jobId,
    ]);
    if (updated.changes === 1) return;
  }
  conn.run(AUDIT_INSERT_SQL, [
    log.id,
    log.timestamp,
    operationType,
    operationData,
    log.target,
    log.status,
    log.durationMs,
    detailsStr,
    log.errorMessage,
  ]);
}

/** 等价 rusqlite `Connection::open(audit_db_path)`：父目录不存在时打开失败（不自动建目录）。 */
function openAuditDb(auditDbPath: string): Connection {
  if (!fs.existsSync(path.dirname(auditDbPath))) {
    throw new Error(`unable to open database file: ${auditDbPath}`);
  }
  return new Connection(auditDbPath, { label: 'audit', profile: PROFILES.plain });
}

/** 打开审计库 → init → `write`；任何失败只告警（与 Rust 相同，不影响迁移）。 */
function withAuditDb(
  auditDbPath: string,
  log: MigrationLog,
  messages: { open: string; init: string; save: string },
  fields: Record<string, unknown>,
  write: (conn: Connection) => void,
): void {
  let conn: Connection;
  try {
    conn = openAuditDb(auditDbPath);
  } catch (error) {
    log('warn', messages.open, { error: errorText(error), path: auditDbPath });
    return;
  }
  try {
    try {
      initAuditTable(conn);
    } catch (error) {
      log('warn', messages.init, { error: errorText(error) });
      return;
    }
    try {
      write(conn);
    } catch (error) {
      log('warn', messages.save, { ...fields, error: errorText(error) });
    }
  } finally {
    conn.close();
  }
}

/** `log_migration_audit`（始终成功）。 */
export function logMigrationAudit(
  auditDbPath: string | undefined,
  log: MigrationLog,
  database: string,
  fromVersion: number,
  toVersion: number,
  appliedCount: number,
  durationMs: number,
): void {
  if (auditDbPath === undefined) {
    log('debug', 'Migration audit (no audit db configured)', {
      database,
      from_version: fromVersion,
      to_version: toVersion,
      applied_count: appliedCount,
    });
    return;
  }
  withAuditDb(
    auditDbPath,
    log,
    {
      open: 'Failed to open audit database for logging',
      init: 'Failed to init audit table, skipping audit log',
      save: 'Failed to save migration audit log',
    },
    { database },
    (conn) => {
      // AuditRepository::log_migration_complete
      const entry = new AuditLog(migrationOperation(fromVersion, toVersion, appliedCount), database).complete(durationMs);
      saveAuditLog(conn, entry);
      log('info', 'Migration audit log saved to database', {
        database,
        from_version: fromVersion,
        to_version: toVersion,
        applied_count: appliedCount,
        audit_id: entry.id,
      });
    },
  );
}

/** `log_migration_failure`。 */
export function logMigrationFailure(
  auditDbPath: string | undefined,
  log: MigrationLog,
  database: string,
  fromVersion: number,
  errorMessage: string,
  durationMs: number,
): void {
  if (auditDbPath === undefined) {
    log('warn', 'Migration failed (no audit db configured)', { database, error: errorMessage });
    return;
  }
  const entry = new AuditLog(migrationOperation(fromVersion, fromVersion, 0), database)
    .fail(errorMessage)
    .withDetails({ database, from_version: fromVersion, error: errorMessage });
  entry.durationMs = durationMs;
  withAuditDb(
    auditDbPath,
    log,
    {
      open: 'Failed to open audit database for migration failure logging',
      init: 'Failed to init audit table for migration failure',
      save: 'Failed to save migration failure audit log',
    },
    { database },
    (conn) => saveAuditLog(conn, entry),
  );
}

/** `log_checksum_repair_audit`。 */
export function logChecksumRepairAudit(
  auditDbPath: string | undefined,
  log: MigrationLog,
  database: string,
  repairDetails: readonly string[],
): void {
  if (auditDbPath === undefined) return;
  const entry = new AuditLog(migrationOperation(0, 0, 0), `checksum_repair:${database}`)
    .withDetails({ action: 'checksum_repair', database, repairs: [...repairDetails], count: repairDetails.length })
    .complete(0);
  withAuditDb(
    auditDbPath,
    log,
    {
      open: 'Failed to open audit db for checksum repair logging',
      init: 'Failed to init audit table for checksum repair logging',
      save: 'Failed to save checksum repair audit log',
    },
    { database },
    (conn) => saveAuditLog(conn, entry),
  );
}
