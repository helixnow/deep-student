import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle, Row, SqlParams } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/api.ts';
import { SEGMENT_SOURCE_IMPORT, SEGMENT_STATUS_DONE } from '../repository/media-transcripts.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-media-transcript-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const media = () => host.ctx.vfsRepo.mediaTranscripts;
const spans = (n: number) => Array.from({ length: n }, (_, i) => ({
  startMs: i * 1000,
  endMs: i * 1000 + 900,
}));

describe('media_transcript_repo.rs', { timeout: 120_000 }, () => {
  it('rebuild_threshold_is_twenty_percent', () => {
    expect(media().planNeedsRebuild(10, 10)).toBe(false);
    expect(media().planNeedsRebuild(10, 12)).toBe(false);
    expect(media().planNeedsRebuild(10, 8)).toBe(false);
    expect(media().planNeedsRebuild(10, 13)).toBe(true);
    expect(media().planNeedsRebuild(10, 7)).toBe(true);
    expect(media().planNeedsRebuild(0, 3)).toBe(true);
  });

  it('plan_create_resume_and_rebuild', () => {
    const rid = 'file_media_1';
    let outcome = media().applyPlan(db, rid, spans(10));
    expect(outcome).toEqual({ status: 'created', planVersion: 1 });
    expect(media().markDone(db, rid, 0, 1, '你好')).toBe(true);
    expect(media().markDone(db, rid, 3, 1, 'world')).toBe(true);
    expect(media().markFailed(db, rid, 4, 1)).toBe(true);
    // 已完成段不会被降级
    expect(media().markFailed(db, rid, 0, 1)).toBe(false);

    // 段数偏差 ≤ 20%：沿用，已完成段保留
    outcome = media().applyPlan(db, rid, spans(11));
    expect(outcome).toEqual({ status: 'reused', planVersion: 1 });
    expect(media().counts(db, rid)).toEqual({ total: 10, done: 2, failed: 1, pending: 7 });
    const unfinished = media().listUnfinished(db, rid);
    expect(unfinished.length).toBe(8);
    expect(unfinished.every(segment => segment.idx !== 0 && segment.idx !== 3)).toBe(true);

    // 偏差 > 20%：重建，plan_version+1，旧结果丢弃
    outcome = media().applyPlan(db, rid, spans(20));
    expect(outcome).toEqual({ status: 'rebuilt', planVersion: 2 });
    let counts = media().counts(db, rid);
    expect(counts.total).toBe(20);
    expect(counts.done).toBe(0);
    // 旧版本迟到的结果被 plan_version 守卫拒绝
    expect(media().markDone(db, rid, 1, 1, 'late')).toBe(false);
    expect(media().markDone(db, rid, 1, 2, 'fresh')).toBe(true);

    // 边界收紧：落在原段内才生效
    expect(media().markDoneWithBounds(db, rid, 2, 2, 'tight', [2100, 2800])).toBe(true);
    expect(media().markDoneWithBounds(db, rid, 5, 2, 'loose', [0, 99_999])).toBe(true);
    const rows = media().listSegments(db, rid);
    expect([rows[2]!.startMs, rows[2]!.endMs]).toEqual([2100, 2800]);
    expect([rows[5]!.startMs, rows[5]!.endMs]).toEqual([5000, 5900]);
  });

  it('imported_segments_replace_plan_and_are_not_overwritten_by_asr_plan', () => {
    const rid = 'file_media_2';
    media().applyPlan(db, rid, spans(3));
    const imported = [
      [{ startMs: 0, endMs: 1500 }, '第一句'],
      [{ startMs: 1500, endMs: 4000 }, '第二句'],
    ] as const;
    const version = media().setImportedSegments(db, rid, imported);
    expect(version).toBe(2);
    const rows = media().listSegments(db, rid);
    expect(rows.length).toBe(2);
    expect(rows.every(row => row.status === SEGMENT_STATUS_DONE
      && row.source === SEGMENT_SOURCE_IMPORT)).toBe(true);

    const outcome = media().applyPlan(db, rid, spans(30));
    expect(outcome).toEqual({ status: 'reused', planVersion: 2 });
    expect(media().listSegments(db, rid).length).toBe(2);
    const ranged = media().listSegmentsInRange(db, rid, 2000, 3000);
    expect(ranged.length).toBe(1);
    expect(ranged[0]!.text).toBe('第二句');
  });

  it('invalid_spans_are_rejected', () => {
    expect(() => media().applyPlan(db, 'file_x', [{ startMs: 500, endMs: 100 }]))
      .toThrow(/Invalid argument 'spans': segment 0 has invalid range 500\.\.100/);
  });

  it('progress_merge_semantics', () => {
    const rid = 'file_media_3';
    expect(media().getProgress(db, rid)).toBeNull();

    media().recordDuration(db, rid, 600_000);
    let progress = media().setProgress(db, rid, {
      positionMs: 10_000,
      watchedDeltaMs: 10_000,
    });
    expect(progress.durationMs).toBe(600_000);
    expect(progress.watchedMs).toBe(10_000);
    expect(progress.finished).toBe(false);

    // 增量截断到 120 s；负数忽略
    progress = media().setProgress(db, rid, { watchedDeltaMs: 10_000_000 });
    expect(progress.watchedMs).toBe(130_000);
    expect(progress.lastPositionMs).toBe(10_000);
    progress = media().setProgress(db, rid, { watchedDeltaMs: -5 });
    expect(progress.watchedMs).toBe(130_000);

    // 位置 ≥ 95% 自动看完，之后保持
    progress = media().setProgress(db, rid, { positionMs: 590_000 });
    expect(progress.finished).toBe(true);
    progress = media().setProgress(db, rid, { positionMs: 0 });
    expect(progress.finished).toBe(true);
    const stored = media().getProgress(db, rid)!;
    expect(stored.lastPositionMs).toBe(0);
    expect(stored.finished).toBe(true);
  });
});

const I64_MAX = 9_223_372_036_854_775_807n;
const I64_MIN = -9_223_372_036_854_775_808n;
const persisted = (rid: string) => db.get(defineQuery<SqlParams, Row>(
  `SELECT last_position_ms, duration_ms, watched_ms, finished, updated_at
   FROM media_progress WHERE resource_id = ?1`, { options: { safeIntegers: true } }), [rid]);
const seed = (rid: string, position: bigint, duration: bigint | null, watched: bigint, finished: 0 | 1, updatedAt: bigint) =>
  db.run(`INSERT INTO media_progress
      (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, [rid, position, duration, watched, finished, updatedAt]);

describe('WP-100 media_progress i64 (media_transcript_repo.rs:454-535)', { timeout: 120_000 }, () => {
  it('set_progress_with_conn reads 2^53+1 exactly and persists +1 as 2^53+2 (R2 probe 143026-3bd7be)', () => {
    const rid = 'file_media_i64';
    seed(rid, 9_007_199_254_740_993n, 9_007_199_254_740_995n, 9_007_199_254_740_993n, 0, 9_007_199_254_740_993n);
    expect(media().getProgressExact(db, rid)).toEqual({
      resourceId: rid, lastPositionMs: 9_007_199_254_740_993n, durationMs: 9_007_199_254_740_995n,
      watchedMs: 9_007_199_254_740_993n, finished: false, updatedAt: 9_007_199_254_740_993n,
    });

    const wire = media().setProgress(db, rid, { watchedDeltaMs: 1 });
    expect(wire.watchedMs).toBe(9_007_199_254_740_994);
    expect(persisted(rid)).toMatchObject({
      last_position_ms: 9_007_199_254_740_993n, duration_ms: 9_007_199_254_740_995n,
      watched_ms: 9_007_199_254_740_994n, finished: 1n,
    });
    // position 2^53+1 ≥ 95% of duration → Rust auto-finishes in f64.
    expect(wire.finished).toBe(true);

    const exact = media().setProgressExact(db, rid, {
      positionMs: 9_007_199_254_740_997n, durationMs: 9_007_199_254_740_999n, watchedDeltaMs: 120_001n,
    });
    expect(exact).toMatchObject({
      lastPositionMs: 9_007_199_254_740_997n, durationMs: 9_007_199_254_740_999n,
      watchedMs: 9_007_199_254_860_994n, finished: true,
    });
    expect(persisted(rid)).toMatchObject({
      last_position_ms: 9_007_199_254_740_997n, duration_ms: 9_007_199_254_740_999n,
      watched_ms: 9_007_199_254_860_994n,
    });
    expect(persisted(rid)!.updated_at).toBe(exact.updatedAt);
  });

  it('set_progress_with_conn saturating_add stops at i64::MAX, not MAX_SAFE_INTEGER', () => {
    const rid = 'file_media_max';
    seed(rid, 0n, null, I64_MAX - 5n, 0, 1n);
    expect(media().setProgressExact(db, rid, { watchedDeltaMs: 3 }).watchedMs).toBe(I64_MAX - 2n);
    expect(media().setProgressExact(db, rid, { watchedDeltaMs: 120_000 }).watchedMs).toBe(I64_MAX);
    expect(media().setProgressExact(db, rid, { watchedDeltaMs: 1 }).watchedMs).toBe(I64_MAX);
    expect(persisted(rid)!.watched_ms).toBe(I64_MAX);

    const full = media().setProgressExact(db, rid, { positionMs: I64_MAX, durationMs: I64_MAX });
    expect(full).toMatchObject({ lastPositionMs: I64_MAX, durationMs: I64_MAX, watchedMs: I64_MAX, finished: true });
    expect(persisted(rid)).toMatchObject({ last_position_ms: I64_MAX, duration_ms: I64_MAX, watched_ms: I64_MAX, finished: 1n });
    expect(media().getProgress(db, rid)).toMatchObject({
      lastPositionMs: Number(I64_MAX), durationMs: Number(I64_MAX), watchedMs: Number(I64_MAX), finished: true,
    });
  });

  it('set_progress_with_conn keeps i64::MIN columns and applies max(0)/filter(>0) to i64::MIN input', () => {
    const rid = 'file_media_min';
    seed(rid, I64_MIN, I64_MIN, I64_MIN, 0, I64_MIN);
    expect(media().getProgressExact(db, rid)).toEqual({
      resourceId: rid, lastPositionMs: I64_MIN, durationMs: I64_MIN, watchedMs: I64_MIN,
      finished: false, updatedAt: I64_MIN,
    });
    // All None: position/duration kept, delta 0, d > 0 fails so no auto-finish.
    expect(media().setProgressExact(db, rid, {})).toMatchObject({
      lastPositionMs: I64_MIN, durationMs: I64_MIN, watchedMs: I64_MIN, finished: false,
    });
    expect(persisted(rid)).toMatchObject({ last_position_ms: I64_MIN, duration_ms: I64_MIN, watched_ms: I64_MIN, finished: 0n });

    const clamped = media().setProgressExact(db, rid, {
      positionMs: I64_MIN, durationMs: I64_MIN, watchedDeltaMs: I64_MIN,
    });
    expect(clamped).toMatchObject({ lastPositionMs: 0n, durationMs: I64_MIN, watchedMs: I64_MIN, finished: false });
    expect(persisted(rid)).toMatchObject({ last_position_ms: 0n, duration_ms: I64_MIN, watched_ms: I64_MIN });

    const delta = media().setProgressExact(db, rid, { watchedDeltaMs: I64_MAX });
    expect(delta.watchedMs).toBe(I64_MIN + 120_000n);
  });

  it('set_progress_with_conn defaults, null fields, nullable duration and explicit finished', () => {
    const rid = 'file_media_default';
    const created = media().setProgressExact(db, rid, {
      positionMs: null, durationMs: null, watchedDeltaMs: null, finished: null,
    });
    expect(created).toMatchObject({ resourceId: rid, lastPositionMs: 0n, durationMs: null, watchedMs: 0n, finished: false });
    expect(persisted(rid)).toMatchObject({ last_position_ms: 0n, duration_ms: null, watched_ms: 0n, finished: 0n });
    expect(media().getProgressExact(db, rid)!.durationMs).toBeNull();
    expect(media().getProgress(db, rid)!.durationMs).toBeNull();

    // Unknown duration never auto-finishes; duration 0 is filtered and keeps None.
    expect(media().setProgressExact(db, rid, { positionMs: I64_MAX, durationMs: 0 })).toMatchObject({
      lastPositionMs: I64_MAX, durationMs: null, finished: false,
    });
    // Explicit finished wins over the 95% rule both ways.
    expect(media().setProgressExact(db, rid, { durationMs: 100, finished: false })).toMatchObject({
      durationMs: 100n, finished: false,
    });
    expect(media().setProgressExact(db, rid, { positionMs: 1, finished: true }).finished).toBe(true);
    expect(media().setProgressExact(db, rid, { finished: false }).finished).toBe(false);
    expect(media().setProgressExact(db, rid, { positionMs: 94 }).finished).toBe(false);
    expect(media().setProgressExact(db, rid, { positionMs: 95 }).finished).toBe(true);
    // finished stays true once set when the update omits it.
    expect(media().setProgressExact(db, rid, { positionMs: 0 }).finished).toBe(true);
    expect(persisted(rid)).toMatchObject({ last_position_ms: 0n, duration_ms: 100n, finished: 1n });
  });

  it('set_progress_with_conn compares position as f64 >= duration as f64 * 0.95', () => {
    const rid = 'file_media_f64';
    const duration = 18_014_398_509_481_984n; // 2^54
    // Exact integers: 17113678584007883 * 20 < 2^54 * 19; Rust's f64 rounds the position up and finishes.
    expect(media().setProgressExact(db, rid, { positionMs: 17_113_678_584_007_883n, durationMs: duration }))
      .toMatchObject({ lastPositionMs: 17_113_678_584_007_883n, durationMs: duration, finished: true });
    expect(persisted(rid)!.last_position_ms).toBe(17_113_678_584_007_883n);

    const other = 'file_media_f64_below';
    expect(media().setProgressExact(db, other, { positionMs: 17_113_678_584_007_882n, durationMs: duration }).finished)
      .toBe(false);
  });

  it('get_progress_with_conn rejects non-INTEGER columns with the rusqlite column error', () => {
    const rid = 'file_media_real';
    db.run(`INSERT INTO media_progress
        (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
      VALUES (?1, 0, 2.5, 1.5, 0, 1)`, [rid]);
    expect(() => media().getProgressExact(db, rid))
      .toThrow('Database error: Invalid column type Real at index: 2, name: duration_ms');
    db.run('UPDATE media_progress SET duration_ms = NULL WHERE resource_id = ?1', [rid]);
    expect(() => media().setProgress(db, rid, { watchedDeltaMs: 1 }))
      .toThrow('Database error: Invalid column type Real at index: 3, name: watched_ms');
    expect(persisted(rid)).toMatchObject({ watched_ms: 1.5, updated_at: 1n });
  });

  it('get_progress_with_conn reports integral REAL (1e20, -1e19) as Real like rusqlite data_type (WP-162, R2 VERIFY009 N1)', () => {
    const rid = 'file_media_integral_real';
    db.run(`INSERT INTO media_progress
        (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
      VALUES (?1, -1e19, NULL, 1e20, 0, 1)`, [rid]);
    const storedTypes = () => db.get(defineQuery<SqlParams, Row>(
      `SELECT typeof(last_position_ms) AS p, typeof(duration_ms) AS d, typeof(watched_ms) AS w
       FROM media_progress WHERE resource_id = ?1`), [rid]);
    expect(storedTypes()).toEqual({ p: 'real', d: 'null', w: 'real' });
    const failure = (run: () => unknown) => {
      try { run(); } catch (error) { return error as { name: string; code: string; message: string }; }
      throw new Error('expected a column type error');
    };
    const expectColumnError = (message: string) => {
      for (const run of [() => media().getProgressExact(db, rid), () => media().getProgress(db, rid),
        () => media().setProgress(db, rid, { positionMs: 5, watchedDeltaMs: 1 }),
        () => media().setProgressExact(db, rid, { watchedDeltaMs: 1 })]) {
        expect(failure(run)).toMatchObject({ name: 'VfsRepositoryError', code: 'VFS_STORAGE', message });
      }
    };

    expectColumnError('Database error: Invalid column type Real at index: 1, name: last_position_ms');
    expect(persisted(rid)).toEqual({
      last_position_ms: -1e19, duration_ms: null, watched_ms: 1e20, finished: 0n, updated_at: 1n,
    });

    db.run('UPDATE media_progress SET last_position_ms = 7 WHERE resource_id = ?1', [rid]);
    expectColumnError('Database error: Invalid column type Real at index: 3, name: watched_ms');
    expect(persisted(rid)).toEqual({
      last_position_ms: 7n, duration_ms: null, watched_ms: 1e20, finished: 0n, updated_at: 1n,
    });

    db.run('UPDATE media_progress SET watched_ms = ?2 WHERE resource_id = ?1', [rid, 'abc']);
    expectColumnError('Database error: Invalid column type Text at index: 3, name: watched_ms');
    db.run("UPDATE media_progress SET watched_ms = x'00' WHERE resource_id = ?1", [rid]);
    expectColumnError('Database error: Invalid column type Blob at index: 3, name: watched_ms');
    expect(db.get(defineQuery<SqlParams, Row>(
      'SELECT typeof(watched_ms) AS w, updated_at AS u FROM media_progress WHERE resource_id = ?1',
      { options: { safeIntegers: true } }), [rid])).toEqual({ w: 'blob', u: 1n });

    // INTEGER (bigint) is accepted and NULL duration_ms stays None.
    db.run('UPDATE media_progress SET watched_ms = ?2 WHERE resource_id = ?1', [rid, I64_MAX]);
    expect(media().getProgressExact(db, rid)).toEqual({
      resourceId: rid, lastPositionMs: 7n, durationMs: null, watchedMs: I64_MAX, finished: false, updatedAt: 1n,
    });
  });
});
