/** Rust `memory_write_idempotency` receipt store (V20260303). */
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { FlushReceipt, SmartWriteOutput } from '../api.ts';

const IN_PROGRESS = 'IN_PROGRESS';
const RETENTION_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

export interface Reservation { key: string; ownerToken: string }

const deleteExpiredQuery = defineQuery<[number, string]>(
  `DELETE FROM memory_write_idempotency
   WHERE created_at < ?1 AND event != ?2
     AND substr(idempotency_key, 1, length('compaction_flush:')) != 'compaction_flush:'`,
  { name: 'memory.idempotency.expire' });
const getCachedQuery = defineQuery<[string, string], {
  noteId: string | null; event: string; isNew: number; confidence: number;
  reason: string; resourceId: string | null; downgraded: number;
}>(
  `SELECT note_id AS noteId, event, is_new AS isNew, confidence, reason,
          resource_id AS resourceId, downgraded
   FROM memory_write_idempotency WHERE idempotency_key = ?1 AND event != ?2 LIMIT 1`,
  { name: 'memory.idempotency.get' });

export function getCachedResult(db: SqlExecutor, key: string): SmartWriteOutput | undefined {
  db.run(deleteExpiredQuery, [Date.now() - RETENTION_MS, IN_PROGRESS]);
  const row = db.get(getCachedQuery, [key, IN_PROGRESS]);
  if (row === undefined) return undefined;
  return {
    noteId: row.noteId ?? '', event: row.event, isNew: row.isNew !== 0,
    confidence: row.confidence, reason: row.reason, resourceId: row.resourceId,
    downgraded: row.downgraded !== 0,
  };
}

const insertReservationQuery = defineQuery<[string, string, number]>(
  `INSERT OR IGNORE INTO memory_write_idempotency
     (idempotency_key, note_id, event, is_new, confidence, reason, resource_id, downgraded, created_at)
   VALUES (?1, '', ?2, 0, 1.0, ?3, NULL, 0, ?4)`, { name: 'memory.idempotency.reserve' });
const reclaimQuery = defineQuery<[string, number, string, string, number]>(
  `UPDATE memory_write_idempotency SET reason = ?1, created_at = ?2
   WHERE idempotency_key = ?3 AND event = ?4 AND created_at <= ?5`,
  { name: 'memory.idempotency.reclaim' });

/** Rust `try_reserve_smart_write_key`: insert-or-reclaim an expired lease. */
export function tryReserve(db: SqlExecutor, key: string): Reservation | undefined {
  const now = Date.now();
  const ownerToken = nanoid(21);
  if (db.run(insertReservationQuery, [key, IN_PROGRESS, ownerToken, now]).changes > 0) {
    return { key, ownerToken };
  }
  const reclaimed = db.run(reclaimQuery, [ownerToken, now, key, IN_PROGRESS, now - LEASE_MS]).changes;
  return reclaimed > 0 ? { key, ownerToken } : undefined;
}

const renewQuery = defineQuery<[number, string, string, string]>(
  `UPDATE memory_write_idempotency SET created_at = ?1
   WHERE idempotency_key = ?2 AND event = ?3 AND reason = ?4`,
  { name: 'memory.idempotency.renew' });

export function renewReservation(db: SqlExecutor, reservation: Reservation): void {
  const changes = db.run(renewQuery, [Date.now(), reservation.key, IN_PROGRESS, reservation.ownerToken]).changes;
  if (changes === 0) {
    throw new Error('CONFLICT(memory.idempotency.lease_lost): 幂等写入租约已失效，已阻止旧执行者提交');
  }
}

const clearQuery = defineQuery<[string, string, string]>(
  'DELETE FROM memory_write_idempotency WHERE idempotency_key = ?1 AND event = ?2 AND reason = ?3',
  { name: 'memory.idempotency.clear' });

export function clearReservation(db: SqlExecutor, reservation: Reservation): void {
  db.run(clearQuery, [reservation.key, IN_PROGRESS, reservation.ownerToken]);
}

const cacheQuery = defineQuery<[string | null, string, number, number, string, string | null,
  number, number, string, string, string]>(
  `UPDATE memory_write_idempotency
   SET note_id = ?1, event = ?2, is_new = ?3, confidence = ?4, reason = ?5,
       resource_id = ?6, downgraded = ?7, created_at = ?8
   WHERE idempotency_key = ?9 AND event = ?10 AND reason = ?11`,
  { name: 'memory.idempotency.cache' });

/** Rust `cache_smart_write_result_with_conn` (service.rs:3105-3152): fenced by owner token. */
export function cacheResult(db: SqlExecutor, reservation: Reservation, output: SmartWriteOutput): void {
  const updated = db.run(cacheQuery, [output.noteId === '' ? null : output.noteId, output.event,
    output.isNew ? 1 : 0, output.confidence, output.reason, output.resourceId ?? null,
    output.downgraded ? 1 : 0, Date.now(), reservation.key, IN_PROGRESS, reservation.ownerToken]).changes;
  if (updated === 0) {
    throw new Error('CONFLICT(memory.idempotency.lease_lost): 幂等写入租约已失效，拒绝覆盖其他执行者的结果');
  }
}

function sameOutput(a: SmartWriteOutput, b: SmartWriteOutput): boolean {
  return a.noteId === b.noteId && a.event === b.event && a.isNew === b.isNew
    && a.confidence === b.confidence && a.reason === b.reason
    && (a.resourceId ?? null) === (b.resourceId ?? null) && a.downgraded === b.downgraded;
}

/** Rust `finalize_idempotency_result` (service.rs:3154-3172). */
export function finalizeResult(db: SqlExecutor, reservation: Reservation | undefined,
  output: SmartWriteOutput): void {
  if (reservation === undefined) return;
  const cached = getCachedResult(db, reservation.key);
  if (cached !== undefined) {
    if (sameOutput(cached, output)) return;
    throw new Error('CONFLICT(memory.idempotency.result_mismatch): 同一幂等键已提交不同结果');
  }
  cacheResult(db, reservation, output);
}

const clearPrefixQuery = defineQuery<[string]>(
  'DELETE FROM memory_write_idempotency WHERE substr(idempotency_key, 1, length(?1)) = ?1',
  { name: 'memory.idempotency.clearPrefix' });

/** Rust `cleanup_memory_flush_receipts`: GLOB, not a literal prefix comparison. */
const cleanupFlushReceiptsQuery = defineQuery<[string]>(
  'DELETE FROM memory_write_idempotency WHERE idempotency_key GLOB ?1',
  { name: 'memory.idempotency.cleanupFlush' });

/** Rust `clear_completed_idempotency_receipts_with_prefix` (ledger cleanup). */
export function clearCompletedReceiptsWithPrefix(db: SqlExecutor, prefix: string): number {
  return db.run(clearPrefixQuery, [prefix]).changes;
}

/** `compaction_flush:<segmentId>:fact:` — shared by L03's ledger and L17 receipts. */
export function flushFactReceiptPrefix(segmentId: string): string {
  return `compaction_flush:${segmentId}:fact:`;
}

/** Rust `cleanup_memory_flush_receipts` GLOB pattern (SQLite wildcards). */
export function flushFactReceiptGlob(segmentId: string): string {
  return `compaction_flush:${segmentId}:fact:*`;
}

/** `compaction_flush:<segmentId>:fact:<index>` (Rust `memory_flush_fact_idempotency_key`). */
export function flushFactReceiptKey(segmentId: string, index: number): string {
  return `${flushFactReceiptPrefix(segmentId)}${index}`;
}

const flushReceiptColumns = `idempotency_key AS idempotencyKey, note_id AS noteId,
  event, is_new AS isNew, confidence, reason, resource_id AS resourceId,
  downgraded, created_at AS createdAt`;

const listFlushReceiptsQuery = defineQuery<[string], {
  idempotencyKey: string; noteId: string | null; event: string; isNew: number;
  confidence: number; reason: string; resourceId: string | null;
  downgraded: number; createdAt: number;
}>(
  `SELECT ${flushReceiptColumns} FROM memory_write_idempotency
   WHERE substr(idempotency_key, 1, length(?1)) = ?1
   ORDER BY created_at, idempotency_key`,
  { name: 'memory.idempotency.listFlush' });

function toFlushReceipt(row: {
  idempotencyKey: string; noteId: string | null; event: string; isNew: number;
  confidence: number; reason: string; resourceId: string | null;
  downgraded: number; createdAt: number;
}): FlushReceipt {
  return {
    idempotencyKey: row.idempotencyKey, noteId: row.noteId, event: row.event,
    isNew: row.isNew !== 0, confidence: row.confidence, reason: row.reason,
    resourceId: row.resourceId, downgraded: row.downgraded !== 0,
    createdAt: row.createdAt, inProgress: row.event === IN_PROGRESS,
  };
}

/** All receipts (including in-progress leases) for one compaction segment. */
export function listFlushReceipts(db: SqlExecutor, segmentId: string): FlushReceipt[] {
  return db.all(listFlushReceiptsQuery, [flushFactReceiptPrefix(segmentId)])
    .map(toFlushReceipt);
}

const getFlushReceiptQuery = defineQuery<[string], {
  idempotencyKey: string; noteId: string | null; event: string; isNew: number;
  confidence: number; reason: string; resourceId: string | null;
  downgraded: number; createdAt: number;
}>(
  `SELECT ${flushReceiptColumns} FROM memory_write_idempotency
   WHERE idempotency_key = ?1 LIMIT 1`,
  { name: 'memory.idempotency.getFlush' });

export function getFlushReceipt(db: SqlExecutor, segmentId: string,
  index: number): FlushReceipt | undefined {
  const row = db.get(getFlushReceiptQuery, [flushFactReceiptKey(segmentId, index)]);
  return row === undefined ? undefined : toFlushReceipt(row);
}

/** Deletes every receipt for the segment (Rust `cleanup_memory_flush_receipts`). */
export function cleanupFlushReceipts(db: SqlExecutor, segmentId: string): number {
  return db.run(cleanupFlushReceiptsQuery, [flushFactReceiptGlob(segmentId)]).changes;
}

