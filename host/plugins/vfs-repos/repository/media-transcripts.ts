/** Port of dstu-vfs media_transcript_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type MediaProgressRow,
  type MediaProgressRowExact,
  type MediaProgressUpdate,
  type MediaSegmentRow,
  type MediaTranscriptRepository,
  type PlanOutcome,
  type PlannedSpan,
  type SegmentCounts,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { safeIntegerQuery } from './sql-integers.ts';

export const SEGMENT_STATUS_PENDING = 0;
export const SEGMENT_STATUS_DONE = 1;
export const SEGMENT_STATUS_FAILED = 2;
export const SEGMENT_SOURCE_ASR = 'asr';
export const SEGMENT_SOURCE_IMPORT = 'import';
export const PLAN_REBUILD_DEVIATION = 0.20;
export const MAX_WATCHED_DELTA_MS = 120_000;

const SEGMENT_COLUMNS = 'idx, start_ms, end_ms, text, status, source, plan_version';

function nowMs(): number { return Date.now(); }

function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}

function readInteger(row: Row, name: string): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    throw new VfsRepositoryError('VFS_STORAGE', `Database error: Invalid column type at ${name}`);
  }
  return number;
}
function readText(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new VfsRepositoryError('VFS_STORAGE', `Database error: Invalid column type at ${name}`);
  }
  return value;
}

const I64_MAX = 9_223_372_036_854_775_807n;
const MAX_WATCHED_DELTA_MS_I64 = BigInt(MAX_WATCHED_DELTA_MS);
const SELECT_PROGRESS = safeIntegerQuery(
  `SELECT resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at
   FROM media_progress WHERE resource_id = ?1`, 'vfsRepos.mediaProgress.get');

/** rusqlite reports `value.data_type()`; under safeIntegers INTEGER is bigint, so any number is REAL (even 1e20). */
function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function progressColumnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE',
    `Database error: Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
/** rusqlite `i64: FromSql` on a safeIntegers row: only INTEGER (bigint) is accepted. */
function readI64(row: Row, index: number, name: string): bigint {
  const value = row[name];
  if (typeof value !== 'bigint') throw progressColumnError(index, name, value);
  return value;
}
function readProgressText(row: Row, index: number, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw progressColumnError(index, name, value);
  return value;
}
function optionalI64(value: number | bigint | null | undefined): bigint | null {
  return value === undefined || value === null ? null : BigInt(value);
}
function wireProgress(row: MediaProgressRowExact): MediaProgressRow {
  return {
    resourceId: row.resourceId,
    lastPositionMs: Number(row.lastPositionMs),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    watchedMs: Number(row.watchedMs),
    finished: row.finished,
    updatedAt: Number(row.updatedAt),
  };
}

function rowToSegment(row: Row): MediaSegmentRow {
  return {
    idx: readInteger(row, 'idx'),
    startMs: readInteger(row, 'start_ms'),
    endMs: readInteger(row, 'end_ms'),
    text: readText(row, 'text'),
    status: readInteger(row, 'status'),
    source: readText(row, 'source'),
    planVersion: readInteger(row, 'plan_version'),
  };
}

function planNeedsRebuild(existingCount: number, newCount: number): boolean {
  if (existingCount === 0) return true;
  const diff = Math.abs(existingCount - newCount);
  return diff / existingCount > PLAN_REBUILD_DEVIATION;
}

function validateSpans(spans: readonly PlannedSpan[]): void {
  for (const [index, span] of spans.entries()) {
    if (span.startMs < 0 || span.endMs < span.startMs) {
      throw invalidArgument('spans',
        `segment ${index} has invalid range ${span.startMs}..${span.endMs}`);
    }
  }
}

function listSegments(conn: SqlExecutor, resourceId: string): MediaSegmentRow[] {
  return conn.all<Row>(
    `SELECT ${SEGMENT_COLUMNS} FROM media_transcript_segments
     WHERE resource_id = ?1 ORDER BY idx ASC`, [resourceId]).map(rowToSegment);
}

function planInfo(conn: SqlExecutor, resourceId: string): [number, string] | null {
  const row = conn.get<Row>(
    `SELECT MAX(plan_version) AS version, MIN(source) AS source FROM media_transcript_segments
     WHERE resource_id = ?1 HAVING COUNT(*) > 0`, [resourceId]);
  return row === undefined ? null : [readInteger(row, 'version'), readText(row, 'source')];
}

function insertSpans(conn: SqlExecutor, resourceId: string, spans: readonly PlannedSpan[],
  texts: readonly string[] | null, status: number, source: string, planVersion: number,
  now: number): void {
  for (const [index, span] of spans.entries()) {
    const text = texts !== null && index < texts.length ? texts[index]! : '';
    conn.run(`INSERT INTO media_transcript_segments
        (resource_id, idx, start_ms, end_ms, text, status, source, plan_version, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [resourceId, index, span.startMs, span.endMs, text, status, source, planVersion, now]);
  }
}

function applyPlan(conn: SqlExecutor, resourceId: string, spans: readonly PlannedSpan[]): PlanOutcome {
  validateSpans(spans);
  conn.exec('BEGIN');
  try {
    const existingCount = Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM media_transcript_segments WHERE resource_id = ?1',
      [resourceId]) ?? 0);
    const info = planInfo(conn, resourceId);
    const now = nowMs();
    let outcome: PlanOutcome;
    if (info === null) {
      insertSpans(conn, resourceId, spans, null, SEGMENT_STATUS_PENDING, SEGMENT_SOURCE_ASR, 1, now);
      outcome = { status: 'created', planVersion: 1 };
    } else {
      const [version, source] = info;
      if (source === SEGMENT_SOURCE_IMPORT || !planNeedsRebuild(existingCount, spans.length)) {
        outcome = { status: 'reused', planVersion: version };
      } else {
        const next = version + 1;
        conn.run('DELETE FROM media_transcript_segments WHERE resource_id = ?1', [resourceId]);
        insertSpans(conn, resourceId, spans, null, SEGMENT_STATUS_PENDING, SEGMENT_SOURCE_ASR, next, now);
        outcome = { status: 'rebuilt', planVersion: next };
      }
    }
    conn.exec('COMMIT');
    return outcome;
  } catch (error) {
    try { conn.exec('ROLLBACK'); }
    catch (rollbackError) { logWarn('[VFS::MediaTranscriptRepo] apply_plan rollback failed:', rollbackError); }
    throw error;
  }
}

export class MediaTranscriptRepo implements MediaTranscriptRepository {
  planNeedsRebuild(existingCount: number, newCount: number): boolean {
    return planNeedsRebuild(existingCount, newCount);
  }

  listSegments(conn: SqlExecutor, resourceId: string): MediaSegmentRow[] {
    return databaseResult(() => listSegments(conn, resourceId));
  }

  listSegmentsInRange(conn: SqlExecutor, resourceId: string, startMs: number, endMs: number): MediaSegmentRow[] {
    return databaseResult(() => conn.all<Row>(
      `SELECT ${SEGMENT_COLUMNS} FROM media_transcript_segments
       WHERE resource_id = ?1 AND end_ms > ?2 AND start_ms < ?3
       ORDER BY idx ASC`, [resourceId, startMs, endMs]).map(rowToSegment));
  }

  listUnfinished(conn: SqlExecutor, resourceId: string): MediaSegmentRow[] {
    return databaseResult(() => conn.all<Row>(
      `SELECT ${SEGMENT_COLUMNS} FROM media_transcript_segments
       WHERE resource_id = ?1 AND status != 1 ORDER BY idx ASC`, [resourceId]).map(rowToSegment));
  }

  counts(conn: SqlExecutor, resourceId: string): SegmentCounts {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) AS done,
                COALESCE(SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END), 0) AS failed
         FROM media_transcript_segments WHERE resource_id = ?1`, [resourceId]);
      if (row === undefined) return { total: 0, done: 0, failed: 0, pending: 0 };
      const total = readInteger(row, 'total');
      const done = readInteger(row, 'done');
      const failed = readInteger(row, 'failed');
      return { total, done, failed, pending: total - done - failed };
    });
  }

  planInfo(conn: SqlExecutor, resourceId: string): [number, string] | null {
    return databaseResult(() => planInfo(conn, resourceId));
  }

  applyPlan(conn: SqlExecutor, resourceId: string, spans: readonly PlannedSpan[]): PlanOutcome {
    return databaseResult(() => applyPlan(conn, resourceId, spans));
  }

  markDone(conn: SqlExecutor, resourceId: string, idx: number, planVersion: number, text: string): boolean {
    return this.markDoneWithBounds(conn, resourceId, idx, planVersion, text, null);
  }

  markDoneWithBounds(conn: SqlExecutor, resourceId: string, idx: number, planVersion: number,
    text: string, bounds: readonly [number, number] | null): boolean {
    return databaseResult(() => {
      let changed: number;
      if (bounds !== null && bounds[0] <= bounds[1]) {
        changed = conn.run(
          `UPDATE media_transcript_segments
           SET text = ?1, status = 1, updated_at = ?2,
               start_ms = CASE WHEN ?6 >= start_ms AND ?7 <= end_ms THEN ?6 ELSE start_ms END,
               end_ms   = CASE WHEN ?6 >= start_ms AND ?7 <= end_ms THEN ?7 ELSE end_ms END
           WHERE resource_id = ?3 AND idx = ?4 AND plan_version = ?5`,
          [text, nowMs(), resourceId, idx, planVersion, bounds[0], bounds[1]]).changes;
      } else {
        changed = conn.run(
          `UPDATE media_transcript_segments
           SET text = ?1, status = 1, updated_at = ?2
           WHERE resource_id = ?3 AND idx = ?4 AND plan_version = ?5`,
          [text, nowMs(), resourceId, idx, planVersion]).changes;
      }
      return changed > 0;
    });
  }

  markFailed(conn: SqlExecutor, resourceId: string, idx: number, planVersion: number): boolean {
    return databaseResult(() => conn.run(
      `UPDATE media_transcript_segments
       SET status = 2, updated_at = ?1
       WHERE resource_id = ?2 AND idx = ?3 AND plan_version = ?4 AND status != 1`,
      [nowMs(), resourceId, idx, planVersion]).changes > 0);
  }

  resetFailed(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => conn.run(
      `UPDATE media_transcript_segments SET status = 0, updated_at = ?1
       WHERE resource_id = ?2 AND status = 2`, [nowMs(), resourceId]).changes);
  }

  setImportedSegments(conn: SqlExecutor, resourceId: string,
    segments: readonly (readonly [PlannedSpan, string])[]): number {
    return databaseResult(() => {
      const spans = segments.map(([span]) => span);
      validateSpans(spans);
      const texts = segments.map(([, text]) => text);
      conn.exec('SAVEPOINT import_media_segments');
      try {
        const info = planInfo(conn, resourceId);
        const version = info === null ? 1 : info[0] + 1;
        conn.run('DELETE FROM media_transcript_segments WHERE resource_id = ?1', [resourceId]);
        insertSpans(conn, resourceId, spans, texts, SEGMENT_STATUS_DONE, SEGMENT_SOURCE_IMPORT,
          version, nowMs());
        conn.exec('RELEASE import_media_segments');
        return version;
      } catch (error) {
        try {
          conn.exec('ROLLBACK TO import_media_segments; RELEASE import_media_segments');
        } catch (rollbackError) {
          logWarn('[VFS::MediaTranscriptRepo] import rollback failed:', rollbackError);
        }
        throw error;
      }
    });
  }

  deleteSegments(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => conn.run(
      'DELETE FROM media_transcript_segments WHERE resource_id = ?1', [resourceId]).changes);
  }

  getProgress(conn: SqlExecutor, resourceId: string): MediaProgressRow | null {
    const row = this.getProgressExact(conn, resourceId);
    return row === null ? null : wireProgress(row);
  }

  setProgress(conn: SqlExecutor, resourceId: string, update: MediaProgressUpdate): MediaProgressRow {
    return wireProgress(this.setProgressExact(conn, resourceId, update));
  }

  getProgressExact(conn: SqlExecutor, resourceId: string): MediaProgressRowExact | null {
    return databaseResult(() => {
      const row = conn.get(SELECT_PROGRESS, [resourceId]);
      if (row === undefined) return null;
      return {
        resourceId: readProgressText(row, 0, 'resource_id'),
        lastPositionMs: readI64(row, 1, 'last_position_ms'),
        durationMs: row.duration_ms === null ? null : readI64(row, 2, 'duration_ms'),
        watchedMs: readI64(row, 3, 'watched_ms'),
        finished: readI64(row, 4, 'finished') !== 0n,
        updatedAt: readI64(row, 5, 'updated_at'),
      };
    });
  }

  setProgressExact(conn: SqlExecutor, resourceId: string, update: MediaProgressUpdate): MediaProgressRowExact {
    return databaseResult(() => {
      const existing: MediaProgressRowExact = this.getProgressExact(conn, resourceId) ?? {
        resourceId: '', lastPositionMs: 0n, durationMs: null, watchedMs: 0n,
        finished: false, updatedAt: 0n,
      };
      const positionMs = optionalI64(update.positionMs);
      const position = positionMs !== null ? (positionMs < 0n ? 0n : positionMs) : existing.lastPositionMs;
      const durationMs = optionalI64(update.durationMs);
      const duration = durationMs !== null && durationMs > 0n ? durationMs : existing.durationMs;
      const deltaMs = optionalI64(update.watchedDeltaMs) ?? 0n;
      const delta = deltaMs < 0n ? 0n : deltaMs > MAX_WATCHED_DELTA_MS_I64 ? MAX_WATCHED_DELTA_MS_I64 : deltaMs;
      const sum = existing.watchedMs + delta;
      const watched = sum > I64_MAX ? I64_MAX : sum;
      const autoFinished = duration !== null && duration > 0n
        && Number(position) >= Number(duration) * 0.95;
      const finished = update.finished !== undefined && update.finished !== null
        ? update.finished : (existing.finished || autoFinished);
      const now = BigInt(nowMs());
      conn.run(`INSERT INTO media_progress
          (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(resource_id) DO UPDATE SET
            last_position_ms = excluded.last_position_ms,
            duration_ms = excluded.duration_ms,
            watched_ms = excluded.watched_ms,
            finished = excluded.finished,
            updated_at = excluded.updated_at`,
      [resourceId, position, duration, watched, finished ? 1 : 0, now]);
      return {
        resourceId, lastPositionMs: position, durationMs: duration,
        watchedMs: watched, finished, updatedAt: now,
      };
    });
  }

  recordDuration(conn: SqlExecutor, resourceId: string, durationMs: number | bigint): void {
    databaseResult(() => {
      conn.run(`INSERT INTO media_progress (resource_id, duration_ms, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(resource_id) DO UPDATE SET duration_ms = excluded.duration_ms`,
      [resourceId, durationMs, nowMs()]);
    });
  }
}
