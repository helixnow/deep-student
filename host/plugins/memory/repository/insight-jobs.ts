import { nanoid } from 'nanoid';
import { AppError } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { StorageError } from '../../../platform/storage/errors.ts';
import type { InsightJobQueue } from '../api.ts';
import { nowIso } from './insight-cards.ts';

function databaseResult<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof StorageError) throw AppError.database(error.message);
    throw error;
  }
}

export function enqueueWithConn(conn: SqlExecutor, jobType: string, dedupeKey: string, payloadJson: string): string | null {
  let existing: string | undefined;
  try {
    existing = conn.get<{ id: string }>(`SELECT id FROM insight_jobs
      WHERE dedupe_key = ?1 AND status IN ('queued', 'running') AND deleted_at IS NULL`, [dedupeKey])?.id;
  } catch (error) {
    // Rust query_row(...).ok() deliberately discards lookup errors; the insert still runs.
    existing = undefined;
  }
  if (existing !== undefined) return null;
  const id = `ijob_${nanoid(10)}`;
  databaseResult(() => conn.run(`INSERT INTO insight_jobs
    (id, job_type, dedupe_key, status, payload_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?5)`, [id, jobType, dedupeKey, payloadJson, nowIso()]));
  return id;
}
export function recoverStaleLeasesWithConn(conn: SqlExecutor): number {
  return databaseResult(() => conn.run(`UPDATE insight_jobs
    SET status = 'queued', lease_owner = NULL, leased_at = NULL, updated_at = ?1
    WHERE status = 'running' AND deleted_at IS NULL
      AND (leased_at IS NULL OR leased_at < datetime('now', ?2))`, [nowIso(), '-120 seconds']).changes);
}
export function claimDueWithConn(conn: SqlExecutor, workerId: string, limit: number): ReturnType<InsightJobQueue['claimDue']> {
  return databaseResult(() => {
    const now = nowIso();
    const rows = conn.all<{ id: string; job_type: string; payload_json: string; attempt: number }>(
      `SELECT id, job_type, payload_json, attempt FROM insight_jobs
       WHERE status = 'queued' AND deleted_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
       ORDER BY created_at ASC LIMIT ?2`, [now, limit]);
    const claimed: ReturnType<InsightJobQueue['claimDue']> = [];
    for (const row of rows) {
      const result = conn.run(`UPDATE insight_jobs
        SET status = 'running', lease_owner = ?2, leased_at = ?3,
          attempt = attempt + 1, updated_at = ?3
        WHERE id = ?1 AND status = 'queued'`, [row.id, workerId, now]);
      if (result.changes === 1) claimed.push([row.id, row.job_type, row.payload_json, row.attempt + 1]);
    }
    return claimed;
  });
}
export function completeWithConn(conn: SqlExecutor, jobId: string): void {
  databaseResult(() => conn.run(`UPDATE insight_jobs
    SET status = 'done', lease_owner = NULL, leased_at = NULL, updated_at = ?2
    WHERE id = ?1`, [jobId, nowIso()]));
}
export function failWithConn(conn: SqlExecutor, jobId: string, error: string): void {
  databaseResult(() => {
    const { attempt, max_attempts } = conn.one<{ attempt: number; max_attempts: number }>(
      'SELECT attempt, max_attempts FROM insight_jobs WHERE id = ?1', [jobId]);
    if (attempt < max_attempts) {
      const backoff = 30 * 2 ** Math.min(attempt, 7);
      conn.run(`UPDATE insight_jobs
        SET status = 'queued', lease_owner = NULL, leased_at = NULL,
          next_attempt_at = datetime('now', ?2), last_error = ?3, updated_at = ?4
        WHERE id = ?1`, [jobId, `+${backoff} seconds`, error, nowIso()]);
    } else {
      conn.run(`UPDATE insight_jobs
        SET status = 'error', lease_owner = NULL, leased_at = NULL,
          last_error = ?2, updated_at = ?3 WHERE id = ?1`, [jobId, error, nowIso()]);
    }
  });
}

export function createInsightJobQueue(database: () => SqlExecutor): InsightJobQueue {
  const conn = (): SqlExecutor => databaseResult(database);
  return {
    enqueue: (type, key, payload) => enqueueWithConn(conn(), type, key, payload),
    recoverStaleLeases: () => recoverStaleLeasesWithConn(conn()),
    claimDue: (worker, limit) => claimDueWithConn(conn(), worker, limit),
    complete: id => completeWithConn(conn(), id),
    fail: (id, error) => failWithConn(conn(), id, error),
  };
}
