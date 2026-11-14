/**
 * L21 audit seeds (backup equivalence README §9.5): `databases/audit.db` rows in the exact
 * `AuditRepository::save` encoding (dstu-storage src/audit/mod.rs:227-288): `operation_data` is the
 * serde `#[serde(tag = "type")]` JSON of `AuditOperation` (fields in declaration order), `details` is
 * `serde_json::to_string(&Value)`, `timestamp` is `DateTime<Utc>::to_rfc3339()`.
 *
 * A cannot produce this history by running operations: `save` folds the terminal row into the open
 * Started row (mod.rs:239-273), Sync needs a cloud endpoint and Partial is rare, so 5 types x 4 statuses
 * x 8 rows are constructed. Timestamps are fixed (the seed must build byte-identically): 144 rows lie in
 * 2025 and 16 in 2099, so `before_days` cleanup splits them the same way on any recording date.
 * `auditShapeMismatches` checks the encoding against rows A wrote during the a-produced run.
 *
 * Startup writes one Migration/Completed row per core database without a job_id; `save` folds it into
 * the latest Started Migration row of that target (w21-audit-080/100/120/140), so the recorded history
 * has 36 Started and 44 Completed rows and those four rows carry a measured `duration_ms`. Without open
 * Started rows for these targets startup would insert four rows stamped with the recording time instead.
 */
import { join } from 'node:path';
import { buildOwnerDatabase, type SeedRow } from './fixtures.ts';
import { historicalSql } from './owner-fixtures.ts';
import { replaySlot, writeSlotState } from './slot-seeds.ts';

export const AUDIT_SEED_NAMES = ['l21-audit-history-v1', 'l21-audit-corrupt-rows-v1'] as const;
export type AuditSeedName = typeof AUDIT_SEED_NAMES[number];
/** `active_app_data_dir.join("databases").join("audit.db")` (src-tauri/src/lib.rs:1157). */
export const AUDIT_DB = 'databases/audit.db';

export const AUDIT_TYPES = ['Migration', 'Backup', 'Restore', 'Sync', 'Maintenance'] as const;
export const AUDIT_STATUSES = ['Started', 'Completed', 'Failed', 'Partial'] as const;
export const ROWS_PER_COMBINATION = 8;
export const FUTURE_ROWS = 16;
/** Row 81 repeats row 80's timestamp (README §9.5: two rows with the same timestamp). */
export const TIED_ROWS = ['w21-audit-080', 'w21-audit-081'] as const;
export const CORRUPT_OPERATION_TYPES = ['CorruptTimestamp', 'CorruptOperationData', 'NegativeDuration', 'CorruptDetails', 'UnknownStatus'] as const;

const HOUR = 3_600_000;
const PAST_BASE = Date.UTC(2025, 5, 1);
const FUTURE_BASE = Date.UTC(2099, 0, 1);

/** `to_rfc3339()` of a whole-second `DateTime<Utc>`: no fraction, `+00:00`. */
const rfc3339 = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+00:00');

function operationData(type: typeof AUDIT_TYPES[number], n: number): { data: string; target: string } {
  switch (type) {
    case 'Migration': return { data: `{"type":"Migration","from_version":${20260100 + n},"to_version":${20260101 + n},"applied_count":1}`,
      target: ['vfs', 'chat_v2', 'mistakes', 'llm_usage'][n % 4]! };
    case 'Backup': return { data: `{"type":"Backup","backup_type":"${['Full', 'Auto', 'Incremental'][n % 3]}","file_count":${5 + n},"total_size":${1_048_576 * (n + 1)}}`,
      target: `2025060${n % 8 + 1}_000000_w21` };
    case 'Restore': return { data: `{"type":"Restore","backup_path":"recovery/backups/2025060${n % 8 + 1}_000000_w21"}`, target: 'slotB' };
    case 'Sync': return { data: `{"type":"Sync","direction":"${['Upload', 'Download', 'Bidirectional'][n % 3]}","records_affected":${n * 3}}`, target: 'webdav' };
    case 'Maintenance': return { data: `{"type":"Maintenance","action":"${['cleanup_audit_logs', 'vacuum', 'cache_cleanup'][n % 3]}"}`, target: 'audit' };
  }
}

/** `AuditLog::new/complete/fail/partial/with_details` shapes (mod.rs:105-149). */
function statusColumns(status: typeof AUDIT_STATUSES[number], i: number, n: number): Pick<SeedRow, 'duration_ms' | 'details' | 'error_message'> {
  switch (status) {
    case 'Started': return { duration_ms: null, details: n % 4 === 3 ? null : 'null', error_message: null };
    case 'Completed': return { duration_ms: 100 + 7 * i, details: n % 2 === 0 ? `{"job_id":"job-w21-${i}"}` : 'null', error_message: null };
    case 'Failed': return { duration_ms: null, details: 'null', error_message: `W21 审计失败 #${i}` };
    case 'Partial': return { duration_ms: 50 + 3 * i, details: `{"skipped":${n + 1},"job_id":"job-w21-${i}"}`, error_message: `W21 部分完成 #${i}` };
  }
}

export function auditHistoryRows(): SeedRow[] {
  const combos = AUDIT_TYPES.flatMap(type => AUDIT_STATUSES.map(status => [type, status] as const));
  const total = combos.length * ROWS_PER_COMBINATION;
  const rows: SeedRow[] = [];
  for (let i = 0; i < total; i++) {
    const [type, status] = combos[i % combos.length]!, n = Math.floor(i / combos.length);
    const ms = i < total - FUTURE_ROWS ? PAST_BASE + i * 19 * HOUR + (i % 7) * 60_000 : FUTURE_BASE + (i - total + FUTURE_ROWS) * 5 * HOUR;
    const { data, target } = operationData(type, n);
    rows.push({ id: `w21-audit-${String(i).padStart(3, '0')}`, timestamp: rfc3339(ms), operation_type: type, operation_data: data,
      target, status, ...statusColumns(status, i, n) });
  }
  rows.find(row => row.id === TIED_ROWS[1])!.timestamp = rows.find(row => row.id === TIED_ROWS[0])!.timestamp!;
  return rows;
}

/** One row per `row_to_audit_log` branch (mod.rs:767-816); `operation_type` isolates each through the filter. */
export function auditCorruptRows(): SeedRow[] {
  const valid = (action: string) => `{"type":"Maintenance","action":"${action}"}`;
  return [
    { id: 'w21-corrupt-timestamp', timestamp: '2025/12/31 00:00:00', operation_type: 'CorruptTimestamp', operation_data: valid('corrupt_timestamp'),
      target: 'audit', status: 'Completed', duration_ms: 1, details: 'null', error_message: null },
    { id: 'w21-corrupt-operation-data', timestamp: '2025-12-31T01:00:00+00:00', operation_type: 'CorruptOperationData', operation_data: 'not json',
      target: 'audit', status: 'Completed', duration_ms: 1, details: 'null', error_message: null },
    { id: 'w21-negative-duration', timestamp: '2025-12-31T02:00:00+00:00', operation_type: 'NegativeDuration', operation_data: valid('negative_duration'),
      target: 'audit', status: 'Completed', duration_ms: -1, details: 'null', error_message: null },
    { id: 'w21-corrupt-details', timestamp: '2025-12-31T03:00:00+00:00', operation_type: 'CorruptDetails', operation_data: valid('corrupt_details'),
      target: 'audit', status: 'Completed', duration_ms: 1, details: 'not json', error_message: null },
    { id: 'w21-unknown-status', timestamp: '2025-12-31T04:00:00+00:00', operation_type: 'UnknownStatus', operation_data: valid('unknown_status'),
      target: 'audit', status: 'Weird', duration_ms: null, details: 'null', error_message: null },
  ];
}

export interface AuditSampleRow { operation_type: string; status: string; operation_data: string; details: string | null; timestamp: string }
const RFC3339_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?\+00:00$/;
const jsonShape = (text: string) => {
  const value: unknown = JSON.parse(text);
  return value && typeof value === 'object' ? Object.entries(value).map(([key, v]) => `${key}:${v === null ? 'null' : typeof v}`).join(',') : String(value);
};

/**
 * Where rows A wrote itself (a-produced PROVENANCE `audit.rows`) are encoded differently from the
 * constructed rows of the same `operation_type`: key order and value types of `operation_data`,
 * timestamp shape, status spelling, `details` JSON. [] = the constructed history reads like A's.
 */
export function auditShapeMismatches(sample: AuditSampleRow[]): string[] {
  const constructed = new Map<string, string>();
  for (const row of auditHistoryRows()) if (!constructed.has(row.operation_type as string)) constructed.set(row.operation_type as string, row.operation_data as string);
  const out: string[] = [];
  for (const row of sample) {
    const label = `${row.operation_type}/${row.status}`;
    if (!RFC3339_UTC.test(row.timestamp)) out.push(`${label}: timestamp ${row.timestamp}`);
    if (!(AUDIT_STATUSES as readonly string[]).includes(row.status)) out.push(`${label}: status`);
    if (row.details !== null) { try { JSON.parse(row.details); } catch { out.push(`${label}: details not JSON`); } }
    const mine = constructed.get(row.operation_type);
    if (!mine) { out.push(`${label}: operation_type not constructed`); continue; }
    try {
      if (jsonShape(row.operation_data) !== jsonShape(mine)) out.push(`${label}: operation_data ${jsonShape(row.operation_data)} vs ${jsonShape(mine)}`);
    } catch { out.push(`${label}: operation_data not JSON`); }
  }
  return out;
}

/** `app` is the app data root both G3 sides open; slotA has been started once, like the other L21 seeds. */
export function writeAuditSeed(name: AuditSeedName, app: string): void {
  const slotA = join(app, 'slots/slotA');
  replaySlot(slotA);
  writeSlotState(app, { legacyMigrationComplete: true });
  const rows = name === 'l21-audit-corrupt-rows-v1' ? [...auditHistoryRows(), ...auditCorruptRows()] : auditHistoryRows();
  buildOwnerDatabase(join(slotA, AUDIT_DB), historicalSql('audit'), { __audit_log: rows });
}
