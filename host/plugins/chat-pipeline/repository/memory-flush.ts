/**
 * chat_v2/pipeline/compaction/memory_flush.rs — SQLite ledger for post-compaction
 * memory flushes. SQL stays in this repository module; pure helpers live in
 * `src/memory-flush.ts`.
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';

export const MEMORY_FLUSH_LEDGER_TABLE = 'chat_v2_compaction_memory_flushes';
export const MEMORY_FLUSH_SEGMENT_MAX_CHARS = 12_000;
export const MEMORY_FLUSH_LEASE_MS = 15 * 60 * 1_000;
export const MEMORY_FLUSH_RETRY_BACKOFF_MS = 30_000;
export const MEMORY_FLUSH_EXTRACTION_TIMEOUT_SECS = 30;
export const MEMORY_FLUSH_DRAIN_BATCH_SIZE = 16;

export interface PendingMemoryFlush {
  segmentId: string;
  compactionId: string;
  sessionId: string;
  segmentOrdinal: number;
  segmentText: string;
  extractionJson: string | null;
  factsCompleted: number;
  activitiesCompleted: number;
}

export type MemoryFlushPolicy =
  | { kind: 'enabled' }
  | { kind: 'disabled'; reason: 'privacy mode' | 'auto extract off' };

/** Creates the ledger and backfills ordinals for pre-segmentation installations. */
export function ensureMemoryFlushLedgerWithConn(db: SqlExecutor): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_FLUSH_LEDGER_TABLE} (
        segment_id          TEXT PRIMARY KEY,
        compaction_id       TEXT NOT NULL,
        session_id          TEXT NOT NULL,
        segment_ordinal     INTEGER NOT NULL DEFAULT 0,
        segment_text        TEXT NOT NULL,
        extraction_json     TEXT,
        facts_completed     INTEGER NOT NULL DEFAULT 0,
        activities_completed INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending', 'processing', 'completed', 'skipped')),
        lease_owner         TEXT,
        lease_expires_at    INTEGER,
        last_error          TEXT,
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        completed_at        INTEGER,
        FOREIGN KEY(compaction_id) REFERENCES chat_v2_compactions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_v2_compaction_memory_flush_pending
        ON ${MEMORY_FLUSH_LEDGER_TABLE}(session_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_compaction_memory_flush_compaction
        ON ${MEMORY_FLUSH_LEDGER_TABLE}(compaction_id);
  `);

  const columns = db.all<{ name: string }>(`PRAGMA table_info(${MEMORY_FLUSH_LEDGER_TABLE})`);
  const hasSegmentOrdinal = columns.some(column => column.name === 'segment_ordinal');
  if (!hasSegmentOrdinal) {
    db.run(`ALTER TABLE ${MEMORY_FLUSH_LEDGER_TABLE} ADD COLUMN segment_ordinal INTEGER NOT NULL DEFAULT 0`);
    db.run(`
      UPDATE ${MEMORY_FLUSH_LEDGER_TABLE}
      SET segment_ordinal = (
          SELECT COUNT(*)
          FROM ${MEMORY_FLUSH_LEDGER_TABLE} AS prior
          WHERE prior.compaction_id = ${MEMORY_FLUSH_LEDGER_TABLE}.compaction_id
            AND (
              prior.created_at < ${MEMORY_FLUSH_LEDGER_TABLE}.created_at
              OR (prior.created_at = ${MEMORY_FLUSH_LEDGER_TABLE}.created_at
                  AND prior.rowid < ${MEMORY_FLUSH_LEDGER_TABLE}.rowid)
            )
      )
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_v2_compaction_memory_flush_order
        ON ${MEMORY_FLUSH_LEDGER_TABLE}(session_id, created_at, compaction_id, segment_ordinal, status);
  `);
}

export function enqueueMemoryFlushWithConn(db: SqlExecutor, pending: PendingMemoryFlush,
  nowMs: number): boolean {
  ensureMemoryFlushLedgerWithConn(db);
  const result = db.run(`
    INSERT OR IGNORE INTO ${MEMORY_FLUSH_LEDGER_TABLE} (
        segment_id, compaction_id, session_id, segment_ordinal, segment_text,
        extraction_json, facts_completed, activities_completed,
        status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, 'pending', ?6, ?6)
  `, [pending.segmentId, pending.compactionId, pending.sessionId, pending.segmentOrdinal,
    pending.segmentText, nowMs]);
  return result.changes === 1;
}

export function readMemoryFlushPolicyWithConn(db: SqlExecutor): MemoryFlushPolicy {
  const readValue = (key: string): string | undefined => {
    try {
      return db.pluck<string>('SELECT value FROM memory_config WHERE key = ?1', [key]);
    } catch (error) {
      throw new Error(`read memory setting '${key}': ${String(error)}`);
    }
  };

  const privacyMode = readValue('privacy_mode');
  if (privacyMode === undefined || privacyMode === 'false') {
    // continue
  } else if (privacyMode === 'true') {
    return { kind: 'disabled', reason: 'privacy mode' };
  } else {
    throw new Error(`invalid memory setting 'privacy_mode': '${privacyMode}'`);
  }

  const frequency = readValue('auto_extract_frequency');
  if (frequency === undefined || frequency === 'balanced' || frequency === 'aggressive') {
    return { kind: 'enabled' };
  }
  if (frequency === 'off') return { kind: 'disabled', reason: 'auto extract off' };
  throw new Error(`invalid memory setting 'auto_extract_frequency': '${frequency}'`);
}

interface LedgerRow {
  segment_id: string;
  compaction_id: string;
  session_id: string;
  segment_ordinal: number;
  segment_text: string;
  extraction_json: string | null;
  facts_completed: number;
  activities_completed: number;
}

function toPending(row: LedgerRow): PendingMemoryFlush {
  return {
    segmentId: row.segment_id,
    compactionId: row.compaction_id,
    sessionId: row.session_id,
    segmentOrdinal: Math.max(row.segment_ordinal, 0),
    segmentText: row.segment_text,
    extractionJson: row.extraction_json,
    factsCompleted: Math.max(row.facts_completed, 0),
    activitiesCompleted: Math.max(row.activities_completed, 0),
  };
}

const CANDIDATE_FILTER = `
  WHERE (?1 IS NULL OR candidate.session_id = ?1)
    AND (
      candidate.status = 'pending'
      OR (candidate.status = 'processing'
          AND COALESCE(candidate.lease_expires_at, 0) <= ?2)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${MEMORY_FLUSH_LEDGER_TABLE} AS earlier
      WHERE earlier.session_id = candidate.session_id
        AND earlier.status NOT IN ('completed', 'skipped')
        AND (
          earlier.created_at < candidate.created_at
          OR (
            earlier.created_at = candidate.created_at
            AND earlier.compaction_id < candidate.compaction_id
          )
          OR (
            earlier.created_at = candidate.created_at
            AND earlier.compaction_id = candidate.compaction_id
            AND earlier.segment_ordinal < candidate.segment_ordinal
          )
        )
    )`;

/** Claims at most one row, never overtaking an earlier unfinished segment. */
export function claimNextPendingMemoryFlushWithConn(db: SqlExecutor, sessionId: string | null,
  workerId: string, nowMs: number): PendingMemoryFlush | null {
  ensureMemoryFlushLedgerWithConn(db);
  const segmentId = db.pluck<string>(`
    SELECT candidate.segment_id
    FROM ${MEMORY_FLUSH_LEDGER_TABLE} AS candidate
    ${CANDIDATE_FILTER}
    ORDER BY candidate.created_at ASC,
             candidate.compaction_id ASC,
             candidate.segment_ordinal ASC,
             candidate.segment_id ASC
    LIMIT 1
  `, [sessionId, nowMs]);
  if (segmentId === undefined) return null;

  const changed = db.run(`
    UPDATE ${MEMORY_FLUSH_LEDGER_TABLE}
    SET status = 'processing', lease_owner = ?1, lease_expires_at = ?2,
        attempt_count = attempt_count + 1, updated_at = ?3, last_error = NULL
    WHERE segment_id = ?4
      AND (
        status = 'pending'
        OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?3)
      )
  `, [workerId, nowMs + MEMORY_FLUSH_LEASE_MS, nowMs, segmentId]).changes;
  if (changed !== 1) return null;

  const row = db.get<LedgerRow>(`
    SELECT segment_id, compaction_id, session_id, segment_ordinal, segment_text,
           extraction_json, facts_completed, activities_completed
    FROM ${MEMORY_FLUSH_LEDGER_TABLE}
    WHERE segment_id = ?1 AND status = 'processing' AND lease_owner = ?2
  `, [segmentId, workerId]);
  return row === undefined ? null : toPending(row);
}

export function hasClaimableMemoryFlushWithConn(db: SqlExecutor, sessionId: string | null,
  nowMs: number): boolean {
  ensureMemoryFlushLedgerWithConn(db);
  const exists = db.pluck<number>(`
    SELECT EXISTS (
      SELECT 1
      FROM ${MEMORY_FLUSH_LEDGER_TABLE} AS candidate
      ${CANDIDATE_FILTER}
      LIMIT 1
    )
  `, [sessionId, nowMs]);
  return exists === 1;
}

export function saveMemoryFlushExtractionWithConn(db: SqlExecutor, segmentId: string,
  workerId: string, extractionJson: string, nowMs: number): boolean {
  return db.run(`
    UPDATE ${MEMORY_FLUSH_LEDGER_TABLE} SET extraction_json = ?1, updated_at = ?2, lease_expires_at = ?3
    WHERE segment_id = ?4 AND status = 'processing' AND lease_owner = ?5
  `, [extractionJson, nowMs, nowMs + MEMORY_FLUSH_LEASE_MS, segmentId, workerId]).changes === 1;
}

export function updateMemoryFlushProgressWithConn(db: SqlExecutor, segmentId: string,
  workerId: string, factsCompleted: number, activitiesCompleted: number, nowMs: number): boolean {
  return db.run(`
    UPDATE ${MEMORY_FLUSH_LEDGER_TABLE} SET facts_completed = ?1, activities_completed = ?2,
        updated_at = ?3, lease_expires_at = ?4
    WHERE segment_id = ?5 AND status = 'processing' AND lease_owner = ?6
  `, [factsCompleted, activitiesCompleted, nowMs, nowMs + MEMORY_FLUSH_LEASE_MS,
    segmentId, workerId]).changes === 1;
}

export function completeMemoryFlushWithConn(db: SqlExecutor, segmentId: string, workerId: string,
  nowMs: number): boolean {
  return db.run(`
    UPDATE ${MEMORY_FLUSH_LEDGER_TABLE} SET status = 'completed', lease_owner = NULL,
        lease_expires_at = NULL, last_error = NULL, segment_text = '', extraction_json = NULL,
        updated_at = ?1, completed_at = ?1
    WHERE segment_id = ?2 AND status = 'processing' AND lease_owner = ?3
  `, [nowMs, segmentId, workerId]).changes === 1;
}

export function releaseMemoryFlushWithConn(db: SqlExecutor, segmentId: string, workerId: string,
  error: string, nowMs: number): boolean {
  return db.run(`
    UPDATE ${MEMORY_FLUSH_LEDGER_TABLE} SET status = 'processing', lease_owner = NULL,
        lease_expires_at = ?2, last_error = ?1, updated_at = ?3
    WHERE segment_id = ?4 AND status = 'processing' AND lease_owner = ?5
  `, [error, nowMs + MEMORY_FLUSH_RETRY_BACKOFF_MS, nowMs, segmentId, workerId]).changes === 1;
}

/** Marks pending/expired rows as skipped in one transaction and returns their ids. */
export function skipPendingMemoryFlushesWithConn(db: DatabaseHandle, sessionId: string | null,
  reason: string, nowMs: number): string[] {
  return db.transaction(tx => {
    ensureMemoryFlushLedgerWithConn(tx);
    const segmentIds = tx.all<{ segment_id: string }>(`
      SELECT segment_id FROM ${MEMORY_FLUSH_LEDGER_TABLE}
      WHERE (?1 IS NULL OR session_id = ?1) AND (status = 'pending'
        OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?2))
    `, [sessionId, nowMs]).map(row => row.segment_id);
    tx.run(`
      UPDATE ${MEMORY_FLUSH_LEDGER_TABLE} SET status = 'skipped', lease_owner = NULL,
          lease_expires_at = NULL, last_error = ?1, segment_text = '',
          extraction_json = NULL, updated_at = ?2, completed_at = ?2
      WHERE (?3 IS NULL OR session_id = ?3) AND (status = 'pending'
        OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?2))
    `, [reason, nowMs, sessionId]);
    return segmentIds;
  });
}

export function memoryFlushFactIdempotencyKey(segmentId: string, index: number): string {
  return `compaction_flush:${segmentId}:fact:${index}`;
}
