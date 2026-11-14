import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { AppError } from '../../../platform/errors/api.ts';
import { applyMasteryDueBias, masteryDueBiasDeltaMs, MAX_ADVANCE_MS } from '../src/bias.ts';
import { FsrsReviewService, applyMasteryBiasToOutcome, scheduleReviewOutcome } from '../src/review.ts';
import {
  DEFAULT_DESIRED_RETENTION, DEFAULT_NEW_PER_DAY, DEFAULT_REVIEWS_PER_DAY,
  FSRS_PARAMS_VERSION, MS_PER_DAY, defaultSchedulerConfig, stateBeforeSnapshot,
  type FsrsAgentReviewMutationOutcome, type FsrsAgentReviewStateSnapshot,
  type FsrsCardState, type FsrsLibraryEnqueueCard,
} from '../src/fsrs-types.ts';
import {
  DEFAULT_PARAMETERS, Fsrs6, forgettingCurveConstants, logicalDayBoundsMs, logicalDayKey, retrievability,
} from '../src/fsrs-scheduler.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  return { ...fixture, service: new FsrsReviewService(fixture.db) };
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  // Each test synchronously replays the full SQLite migration chain. Let the
  // worker service Vitest's pending RPC replies between tests, not after all 64.
  await setImmediate();
});

type Db = ReturnType<typeof mistakesFixture>['db'];

function insertTaskAndCard(db: Db, documentId: string, taskId: string, cardId: string): void {
  db.run(`INSERT INTO document_tasks (
    id, document_id, original_document_name, segment_index,
    content_segment, status, anki_generation_options_json
  ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}')`, [taskId, documentId]);
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`, [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

function insertCardForTask(db: Db, documentId: string, taskId: string, cardId: string): void {
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`, [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

function setTaskOwner(db: Db, taskId: string, sessionId: string): void {
  const result = db.run('UPDATE document_tasks SET source_session_id = ?1 WHERE id = ?2', [sessionId, taskId]);
  expect(result.changes).toBe(1);
}

function enqueueAndRate(db: Db, cardId: string): string {
  const service = new FsrsReviewService(db);
  const result = service.enqueueCards([cardId]);
  expect(result.enqueued).toBe(1);
  const stateId = result.states[0]!.id;
  expect(stateId).not.toBe(cardId);
  service.rate(stateId, 3, 250, null);
  return stateId;
}

function localNoonMs(dayOffset: number): number {
  return new Date(2026, 7, 1, 12, 0, 0, 0).getTime() + dayOffset * MS_PER_DAY;
}

function insertReviewLog(
  db: Db, stateId: string, cardId: string, rating: number, stateBefore: number, reviewMs: number,
): void {
  db.run(`INSERT INTO fsrs_review_logs (
    id, card_state_id, anki_card_id, rating, state_before, state_after,
    review_ms, fsrs_params_version, created_at, updated_at
  ) VALUES (?1, ?2, ?3, ?4, ?5, 2, ?6, ?7, ?8, ?8)`, [
    crypto.randomUUID(), stateId, cardId, rating, stateBefore, reviewMs,
    FSRS_PARAMS_VERSION, `2026-08-01T00:00:${String(reviewMs % 60).padStart(2, '0')}Z`,
  ]);
}

function seedReviewState(db: Db, stateId: string, lastReviewMs: number, dueMs: number): void {
  db.run(`UPDATE fsrs_card_states
    SET state = 2, stability = 99.0, difficulty = 9.0, reps = 3,
        last_review_ms = ?1, due_ms = ?2 WHERE id = ?3`, [lastReviewMs, dueMs, stateId]);
}

function loadMemory(db: Db, stateId: string): [number, number, number] {
  const row = db.get<{ stability: number; difficulty: number; due_ms: number }>(
    'SELECT stability, difficulty, due_ms FROM fsrs_card_states WHERE id = ?1', [stateId],
  );
  return [row!.stability, row!.difficulty, row!.due_ms];
}

function blankNewCard(nowMs = 1_700_000_000_000): FsrsCardState {
  return {
    id: 'blank-state', ankiCardId: 'blank-card', deckId: 'deck_default', state: 0,
    stability: null, difficulty: null, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0,
    dueMs: nowMs, lastReviewMs: null, suspended: false, fsrsParamsVersion: FSRS_PARAMS_VERSION,
    desiredRetention: DEFAULT_DESIRED_RETENTION, createdAt: '2026-01-01T00:00:00+00:00',
    updatedAt: '2026-01-01T00:00:00+00:00', leech: false, buriedUntilMs: null, learningStep: 0,
  };
}

function stateOf(states: readonly FsrsCardState[], cardId: string): string {
  return states.find(state => state.ankiCardId === cardId)!.id;
}

function dueStateIds(service: FsrsReviewService): string[] {
  return service.getDue(100).map(card => card.id);
}

function assertNoFsrsRows(db: Db, cardIds: readonly string[]): void {
  for (const cardId of cardIds) {
    expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId]))).toBe(0);
    expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', [cardId]))).toBe(0);
  }
}

function assertSameSchedulingState(actual: FsrsCardState, expected: FsrsCardState): void {
  for (const key of [
    'id', 'ankiCardId', 'deckId', 'state', 'stability', 'difficulty', 'elapsedDays',
    'scheduledDays', 'reps', 'lapses', 'dueMs', 'lastReviewMs', 'suspended',
    'fsrsParamsVersion', 'desiredRetention', 'createdAt', 'leech', 'buriedUntilMs', 'learningStep',
  ] as const) {
    expect(actual[key]).toEqual(expected[key]);
  }
}

function undoFingerprint(db: Db, stateId: string, logId: string): [unknown, unknown] {
  const state = db.get(`SELECT deck_id, state, stability, difficulty, elapsed_days, scheduled_days,
      reps, lapses, due_ms, last_review_ms, suspended, fsrs_params_version, desired_retention,
      updated_at, local_version, deleted_at FROM fsrs_card_states WHERE id = ?1`, [stateId]);
  const log = db.get(`SELECT card_state_id, anki_card_id, review_ms, state_before_json,
      updated_at, local_version, deleted_at FROM fsrs_review_logs WHERE id = ?1`, [logId]);
  return [state, log];
}

function expectAgentUpdated(
  outcome: FsrsAgentReviewMutationOutcome, expectedChanged: boolean,
): FsrsAgentReviewStateSnapshot {
  expect(outcome.status).toBe('updated');
  if (outcome.status !== 'updated') throw new Error('unreachable');
  expect(outcome.changed).toBe(expectedChanged);
  return outcome.state;
}

function appErrorValue(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandError) return error.value as AppError;
    throw error;
  }
  throw new Error('expected an AppError');
}

function errorMessage(fn: () => unknown): string {
  return appErrorValue(fn).message;
}

// ---------------------------------------------------------------- scheduler core

it('new_good_enters_learning_ten_minutes', () => {
  const before = blankNewCard();
  const now = 1_700_000_000_000;
  const out = scheduleReviewOutcome(before, 3, now, defaultSchedulerConfig());
  expect(out.state).toBe(1);
  expect(out.scheduledDays).toBe(0);
  expect(out.dueMs).toBe(now + 10 * 60_000);
  expect(out.reps).toBe(1);
  expect(out.stability).toBeGreaterThan(0);
  expect(out.difficulty).toBeGreaterThan(0);
});

it('again_on_review_relearns_after_ten_minutes', () => {
  const now = 1_700_000_000_000;
  const before = {
    ...blankNewCard(now), state: 2, stability: 5, difficulty: 5, scheduledDays: 5,
    dueMs: now, lastReviewMs: now - 5 * MS_PER_DAY,
  };
  const out = scheduleReviewOutcome(before, 1, now, defaultSchedulerConfig());
  expect(out.state).toBe(3);
  expect(out.lapses).toBe(1);
  expect(out.dueMs).toBe(now + 10 * 60_000);
  expect(out.scheduledDays).toBe(0);
});

it('hard_and_easy_adjust_intervals', () => {
  const now = 1_700_000_000_000;
  const before = {
    ...blankNewCard(now), state: 2, stability: 4, difficulty: 5, scheduledDays: 4,
    dueMs: now, lastReviewMs: now - 4 * MS_PER_DAY,
  };
  const hard = scheduleReviewOutcome(before, 2, now, defaultSchedulerConfig());
  expect(hard.state).toBe(2);
  expect(hard.scheduledDays).toBeGreaterThanOrEqual(1);
  const easy = scheduleReviewOutcome(before, 4, now, defaultSchedulerConfig());
  expect(easy.state).toBe(2);
  expect(easy.scheduledDays).toBeGreaterThan(hard.scheduledDays);
});

it('preview_intervals_returns_four_ratings', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-preview', 'task-preview', 'card-preview');
  const enqueued = service.enqueueCards(['card-preview']);
  const stateId = enqueued.states[0]!.id;
  const preview = service.previewIntervals(stateId, null);
  expect(preview.intervals).toHaveLength(4);
  expect(preview.intervals.map(interval => interval.rating)).toEqual([1, 2, 3, 4]);
  for (const interval of preview.intervals) {
    expect(interval.intervalMs).toBeGreaterThanOrEqual(0);
    expect(interval.dueMs - interval.intervalMs + interval.intervalMs).toBe(interval.dueMs);
  }
  expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1', [stateId]))).toBe(0);
});

it('rate_with_same_client_op_id_is_idempotent', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-idem', 'task-idem', 'card-idem');
  const enqueued = service.enqueueCards(['card-idem']);
  const stateId = enqueued.states[0]!.id;
  const clientOpId = crypto.randomUUID();
  const first = service.rate(stateId, 3, 10, clientOpId);
  expect(first.logId).toBe(clientOpId);
  const second = service.rate(stateId, 3, 10, clientOpId);
  expect(second.logId).toBe(first.logId);
  expect(second.dueMs).toBe(first.dueMs);
  expect(second.scheduledDays).toBe(first.scheduledDays);
  expect(second.cardState.reps).toBe(first.cardState.reps);
  expect(second.cardState.dueMs).toBe(first.dueMs);
  expect(Number(db.pluck(
    'SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1 AND deleted_at IS NULL',
    [stateId],
  ))).toBe(1);
});

it('malformed_client_op_id_is_rejected_without_rating', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-bad-op', 'task-bad-op', 'card-bad-op');
  const stateId = service.enqueueCards(['card-bad-op']).states[0]!.id;
  const error = appErrorValue(() => service.rate(stateId, 3, 10, 'not-a-uuid'));
  expect(error.message).toContain('valid UUID');
  expect(service.getCardState(stateId)!.reps).toBe(0);
  service.rate(stateId, 3, 10, null);
});

it('rate_client_op_id_rejects_card_mismatch', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-op-a', 'task-op-a', 'card-op-a');
  insertTaskAndCard(db, 'doc-op-b', 'task-op-b', 'card-op-b');
  const stateA = service.enqueueCards(['card-op-a']).states[0]!.id;
  const stateB = service.enqueueCards(['card-op-b']).states[0]!.id;
  const clientOpId = crypto.randomUUID();
  service.rate(stateA, 3, 10, clientOpId);
  const error = appErrorValue(() => service.rate(stateB, 3, 10, clientOpId));
  expect(error.message.includes('different card') || error.message.includes('conflict')).toBe(true);
});

it('rate_client_op_id_rejects_reuse_after_undo', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-op-undo', 'task-op-undo', 'card-op-undo');
  const stateId = service.enqueueCards(['card-op-undo']).states[0]!.id;
  const clientOpId = crypto.randomUUID();
  const first = service.rate(stateId, 3, 10, clientOpId);
  service.undoLastReview(first.logId, stateId);
  const error = appErrorValue(() => service.rate(stateId, 3, 10, clientOpId));
  expect(error.message.includes('undone') || error.message.includes('conflict')).toBe(true);
});

it('rate_cas_rejects_stale_expected_last_review', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-cas', 'task-cas', 'card-cas');
  const stateId = service.enqueueCards(['card-cas']).states[0]!.id;
  service.rateWithMasteryBiasCas(stateId, 3, 10, null, null, false, null);
  const error = appErrorValue(() =>
    service.rateWithMasteryBiasCas(stateId, 2, 10, null, null, true, null));
  expect(error.message.includes('rated elsewhere') || error.message.includes('conflict')).toBe(true);
});

it('mastery_bias_advances_low_score_and_caps_high_interval', () => {
  const now = 1_700_000_000_000;
  const before = {
    ...blankNewCard(now), state: 2, stability: 10, difficulty: 5, scheduledDays: 10,
    reps: 5, dueMs: now, lastReviewMs: now - 10 * MS_PER_DAY,
  };
  const fsrsOut = scheduleReviewOutcome(before, 3, now, defaultSchedulerConfig());
  const interval = fsrsOut.dueMs - now;
  expect(interval).toBeGreaterThanOrEqual(60 * 60 * 1000);
  const lowDue = applyMasteryDueBias(0, now, fsrsOut.dueMs);
  const highDue = applyMasteryDueBias(0.95, now, fsrsOut.dueMs);
  expect(lowDue).toBeLessThan(fsrsOut.dueMs);
  expect(lowDue).toBe(fsrsOut.dueMs + masteryDueBiasDeltaMs(0, interval));
  expect(highDue).toBeGreaterThanOrEqual(fsrsOut.dueMs);
  const capped = applyMasteryDueBias(0, now, now + 100 * MS_PER_DAY) - (now + 100 * MS_PER_DAY);
  expect(capped).toBe(-MAX_ADVANCE_MS);
  const biased = { ...fsrsOut };
  applyMasteryBiasToOutcome(biased, 0, now);
  expect(biased.dueMs).toBe(lowDue);
});

it('rate_with_mastery_bias_persists_advanced_due', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-bias', 'task-bias', 'card-bias');
  const stateId = service.enqueueCards(['card-bias']).states[0]!.id;
  const seedNow = Date.now();
  db.run(`UPDATE fsrs_card_states SET
      state = 2, stability = 10.0, difficulty = 5.0,
      scheduled_days = 10.0, reps = 5, lapses = 0,
      due_ms = ?1, last_review_ms = ?2, suspended = 0
    WHERE id = ?3`, [seedNow, seedNow - 10 * MS_PER_DAY, stateId]);
  const before = service.getCardState(stateId)!;
  const rateNow = Date.now();
  const fsrsOnly = scheduleReviewOutcome(before, 3, rateNow, defaultSchedulerConfig());
  const expectedDue = applyMasteryDueBias(0, rateNow, fsrsOnly.dueMs);
  const biased = service.rateWithMasteryBias(stateId, 3, 10, 0, null);
  expect(biased.dueMs).toBeLessThan(fsrsOnly.dueMs);
  const delta = fsrsOnly.dueMs - biased.dueMs;
  const expectedDelta = fsrsOnly.dueMs - expectedDue;
  expect(Math.abs(delta - expectedDelta)).toBeLessThan(5_000);

  insertCardForTask(db, 'doc-bias', 'task-bias', 'card-bias-hi');
  const stateHi = service.enqueueCards(['card-bias-hi']).states[0]!.id;
  db.run(`UPDATE fsrs_card_states SET
      state = 2, stability = 10.0, difficulty = 5.0,
      scheduled_days = 10.0, reps = 5, lapses = 0,
      due_ms = ?1, last_review_ms = ?2, suspended = 0
    WHERE id = ?3`, [seedNow, seedNow - 10 * MS_PER_DAY, stateHi]);
  const beforeHi = service.getCardState(stateHi)!;
  const rateNowHi = Date.now();
  const fsrsHi = scheduleReviewOutcome(beforeHi, 3, rateNowHi, defaultSchedulerConfig());
  const high = service.rateWithMasteryBias(stateHi, 3, 10, 0.95, null);
  expect(high.dueMs).toBeGreaterThanOrEqual(fsrsHi.dueMs - 5_000);
});

it('committed_review_remains_in_mastery_outbox_until_marked', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-outbox', 'task-outbox', 'card-outbox');
  const enqueued = service.enqueueCards(['card-outbox']);
  const rated = service.rate(enqueued.states[0]!.id, 3, null, null);
  expect(service.pendingMasteryReviews(10).some(row => row.logId === rated.logId)).toBe(true);
  service.markMasteryReviewSynced(rated.logId);
  expect(service.pendingMasteryReviews(10).some(row => row.logId === rated.logId)).toBe(false);
});

it('undo_still_works_after_mastery_outbox_mark_synced', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-undo-sync', 'task-undo-sync', 'card-undo-sync');
  const enqueued = service.enqueueCards(['card-undo-sync']);
  const stateId = enqueued.states[0]!.id;
  const rated = service.rate(stateId, 3, null, null);
  service.markMasteryReviewSynced(rated.logId);
  service.undoLastReview(rated.logId, stateId);
});

it('undo_of_unsynced_review_remains_a_durable_revert_pending', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-revert', 'task-revert', 'card-revert');
  const enqueued = service.enqueueCards(['card-revert']);
  const stateId = enqueued.states[0]!.id;
  const rated = service.rate(stateId, 3, null, null);
  service.undoLastReview(rated.logId, stateId);
  const row = service.pendingMasteryReviews(10).find(item => item.logId === rated.logId);
  expect(row).toBeDefined();
  expect(row!.revert).toBe(true);
});

it('params_version_marks_fsrs_rs_scheduler', () => {
  expect(FSRS_PARAMS_VERSION.startsWith('fsrs-rs-')).toBe(true);
});

it('review_day_bounds_follow_user_timezone', () => {
  const timezoneOffsetMinutes = 8 * 60;
  const nowMs = Date.UTC(2026, 6, 10, 17, 30, 0, 0);
  const [start, nextStart] = logicalDayBoundsMs(nowMs, 0, timezoneOffsetMinutes);
  expect(start).toBe(1_783_699_200_000);
  expect(nextStart).toBe(1_783_785_600_000);
  const [rolloverStart, rolloverNext] = logicalDayBoundsMs(nowMs, 4, timezoneOffsetMinutes);
  expect(rolloverStart).toBe(1_783_627_200_000);
  expect(rolloverNext).toBe(1_783_713_600_000);
});

it('untagged_cards_fall_back_to_document_name_for_mastery_concepts', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc_concept', 'task_concept', 'card_untagged');
  expect(service.getCardConceptTags('card_untagged')).toEqual(['test.md']);
  db.run(`UPDATE anki_cards SET tags_json = '["导数"]' WHERE id = 'card_untagged'`, []);
  expect(service.getCardConceptTags('card_untagged')).toEqual(['导数']);
  db.run(`UPDATE anki_cards SET tags_json = '[]' WHERE id = 'card_untagged'`, []);
  db.run(`UPDATE document_tasks SET original_document_name = 'Default' WHERE id = 'task_concept'`, []);
  expect(service.getCardConceptTags('card_untagged')).toEqual([]);
});

// ---------------------------------------------------------------- config / stats

it('v2_s2_scheduler_config_reads_json_like_serde_value_accessors', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-config-serde', 'task-config-serde', 'card-config-serde');
  service.enqueueCards(['card-config-serde']);
  const defaults = defaultSchedulerConfig();
  const load = (json: string) => {
    db.run("UPDATE anki_decks SET config_json = ?1 WHERE id = 'deck_default'", [json]);
    return service.getSchedulerConfig();
  };
  // A present snake key wins even when null: Rust `get(snake).or_else(get(camel))` never reaches camel.
  const nullSnake = load('{"new_per_day":null,"newPerDay":7,"enable_fuzz":null,"enableFuzz":false}');
  expect(nullSnake.newPerDay).toBe(defaults.newPerDay);
  expect(nullSnake.enableFuzz).toBe(defaults.enableFuzz);
  expect(load('{"newPerDay":7}').newPerDay).toBe(7);
  // `as_u64` is None for float literals; JSON.parse would have accepted 7.0 and 7.9.
  // dstu-anki enables serde_json `arbitrary_precision`, so `-0` is stored as i64 0 and reads as 0.
  const floats = load('{"new_per_day":7.0,"reviews_per_day":7.9,"leech_threshold":-0,"day_rollover_hour":1e1,"max_answer_seconds":60.5}');
  expect(floats.newPerDay).toBe(defaults.newPerDay);
  expect(floats.reviewsPerDay).toBe(defaults.reviewsPerDay);
  expect(floats.leechThreshold).toBe(0);
  expect(floats.dayRolloverHour).toBe(defaults.dayRolloverHour);
  expect(floats.maxAnswerSeconds).toBe(defaults.maxAnswerSeconds);
  // u64 values saturate at u32::MAX; integers past u64 are floats to serde and are ignored.
  const big = load('{"new_per_day":18446744073709551615,"reviews_per_day":18446744073709551616,"fsrs_optimized_review_count":9007199254740993}');
  expect(big.newPerDay).toBe(4_294_967_295);
  expect(big.reviewsPerDay).toBe(defaults.reviewsPerDay);
  expect(big.fsrsOptimizedReviewCount).toBe(4_294_967_295);
  // as_f64 accepts integer literals; steps keep sanitize_steps semantics.
  const steps = load('{"desired_retention":0.8,"learning_steps":[1,10.5],"relearning_steps":[5,"x"]}');
  expect(steps.desiredRetention).toBe(0.8);
  expect(steps.learningSteps).toEqual([1, 10.5]);
  expect(steps.relearningSteps).toEqual(defaults.relearningSteps);
  // Under arbitrary_precision an overflowing float parses (kept as text) and only `as_f64` filters it.
  const overflow = load('{"new_per_day":3,"desired_retention":1e400,"x":1e400}');
  expect(overflow.newPerDay).toBe(3);
  expect(overflow.desiredRetention).toBe(defaults.desiredRetention);
  // A lone surrogate escape is a parse error: warn and fall back to defaults.
  const warnings: string[] = [];
  const watched = new FsrsReviewService(db, message => { warnings.push(message); });
  db.run("UPDATE anki_decks SET config_json = ?1 WHERE id = 'deck_default'", ['{"new_per_day":3,"x":"\\ud800"}']);
  expect(watched.getSchedulerConfig()).toEqual(defaults);
  expect(warnings).toEqual(['[FsrsReviewService] 牌组 deck_default 的 config_json 解析失败，使用默认调度配置']);
  expect(load('[1,2]')).toEqual(defaults);
});

it('scheduler_config_partial_update_preserves_unknown_keys', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-config', 'task-config', 'card-config');
  service.enqueueCards(['card-config']);
  db.run(`UPDATE anki_decks
    SET config_json = '{"desired_retention":0.9,"custom_key":"keep","newPerDay":50}'
    WHERE id = 'deck_default'`, []);
  const updated = service.updateSchedulerConfig({
    newPerDay: 5, learnAheadMinutes: 0, desiredRetention: 0.85,
  });
  expect(updated.newPerDay).toBe(5);
  expect(updated.learnAheadMinutes).toBe(0);
  expect(updated.reviewsPerDay).toBe(DEFAULT_REVIEWS_PER_DAY);
  expect(Math.abs(updated.desiredRetention - 0.85)).toBeLessThan(1e-9);
  const raw = db.pluck<string>('SELECT config_json FROM anki_decks WHERE id = ?1', ['deck_default'])!;
  const value = JSON.parse(raw) as Record<string, unknown>;
  expect(value.custom_key).toBe('keep');
  expect(value.new_per_day).toBe(5);
  expect('newPerDay' in value).toBe(false);
  expect(service.getSchedulerConfig()).toEqual(updated);
  expect(() => service.updateSchedulerConfig({ learnAheadMinutes: 61 })).toThrow();
  expect(() => service.updateSchedulerConfig({ desiredRetention: 1.2 })).toThrow();
  expect(() => service.updateSchedulerConfig({ leechAction: 'explode' })).toThrow();
});

it('scheduler_config_update_writes_serde_json_value_text_and_order', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-config-text', 'task-config-text', 'card-config-text');
  service.enqueueCards(['card-config-text']);
  db.run(`UPDATE anki_decks
    SET config_json = '{"newPerDay":5,"x":1.0,"y":1e2,"desired_retention":0.9,"learningSteps":[3],"tail":true}'
    WHERE id = 'deck_default'`, []);
  service.updateSchedulerConfig({
    newPerDay: 7, desiredRetention: 0.8, learningSteps: [1, 10, 525_600], relearningSteps: [10], fsrsParams: [],
  });
  const raw = () => db.pluck<string>('SELECT config_json FROM anki_decks WHERE id = ?1', ['deck_default'])!;
  // arbitrary_precision 保留已有数字原文；json!(f64) 用 zmij 输出（整数值补 `.0`）；
  // preserve_order 下 `Map::remove` 是 swap_remove（末项补到被删位置），insert 已有键原位替换。
  expect(raw()).toBe('{"tail":true,"x":1.0,"y":1e2,"desired_retention":0.8,"new_per_day":7,'
    + '"learning_steps":[1.0,10.0,525600.0],"relearning_steps":[10.0],"fsrs_params":[]}');

  // json!(Vec<f32>)：按 f32 最短表示写出（0.123456789 → 0.12345679，整数值 → `1.0`）。
  service.updateSchedulerConfig({ fsrsParams: [...DEFAULT_PARAMETERS.slice(0, 19), 1, 0.123456789] });
  expect(raw()).toMatch(/"fsrs_params":\[0\.212,[^\]]*,1\.0,0\.12345679\]/);
});

it('memory_state_upgrade_rewrites_config_json_without_touching_number_text', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-upgrade-text', 'task-upgrade-text', 'card-upgrade-text');
  service.enqueueCards(['card-upgrade-text']);
  db.run(`UPDATE anki_decks SET config_json = '{"x":1.0,"y":1e2,"desired_retention":0.9}'
    WHERE id = 'deck_default'`, []);
  service.ensureMemoryStatesCurrent();
  expect(db.pluck<string>('SELECT config_json FROM anki_decks WHERE id = ?1', ['deck_default']))
    .toBe(`{"x":1.0,"y":1e2,"desired_retention":0.9,"memory_state_version":${JSON.stringify(FSRS_PARAMS_VERSION)}}`);
});

it('memory_state_upgrade_seeds_the_default_deck_like_patch_config_json_in_tx', () => {
  const { db, service } = setup();
  db.run("DELETE FROM anki_decks WHERE id = 'deck_default'", []);
  service.ensureMemoryStatesCurrent();
  expect(db.pluck<string>('SELECT config_json FROM anki_decks WHERE id = ?1', ['deck_default']))
    .toBe(`{"desired_retention":0.9,"memory_state_version":${JSON.stringify(FSRS_PARAMS_VERSION)}}`);
});

it('desired_retention_config_flows_into_enqueue_rating_and_preview', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-ret', 'task-ret', 'card-ret');
  service.updateSchedulerConfig({ desiredRetention: 0.75 });
  const enqueued = service.enqueueCards(['card-ret']);
  expect(enqueued.enqueued).toBe(1);
  expect(Math.abs((enqueued.states[0]!.desiredRetention ?? 0) - 0.75)).toBeLessThan(1e-9);
  const stateId = enqueued.states[0]!.id;
  const now = Date.now();
  db.run(`UPDATE fsrs_card_states SET state = 2, stability = 10.0, difficulty = 5.0,
      scheduled_days = 10.0, reps = 5, lapses = 0, due_ms = ?1, last_review_ms = ?2
    WHERE id = ?3`, [now, now - 10 * MS_PER_DAY, stateId]);
  const low = service.previewIntervals(stateId, null);
  service.updateSchedulerConfig({ desiredRetention: 0.97 });
  const high = service.previewIntervals(stateId, null);
  const lowGood = low.intervals.find(interval => interval.rating === 3)!;
  const highGood = high.intervals.find(interval => interval.rating === 3)!;
  expect(highGood.intervalMs).toBeLessThan(lowGood.intervalMs);
  const rated = service.rate(stateId, 3, 10, null);
  expect(Math.abs((rated.cardState.desiredRetention ?? 0) - 0.97)).toBeLessThan(1e-9);
});

it('stats_expose_quota_hidden_backlog', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-backlog', 'task-backlog', 'card-backlog');
  service.updateSchedulerConfig({ newPerDay: 0, reviewsPerDay: 0 });
  service.enqueueCards(['card-backlog']);
  const stats = service.getStats();
  expect(stats.due).toBe(0);
  expect(stats.backlog).toBe(1);
  expect(stats.backlogNew).toBe(1);
  expect(stats.backlogReview).toBe(0);
  expect(stats.newCount).toBe(1);
});

it('review_statistics_aggregate_logs_limits_and_forecast', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-stats', 'task-stats', 'card-stats');
  enqueueAndRate(db, 'card-stats');
  insertCardForTask(db, 'doc-stats', 'task-stats', 'unseen-card');
  service.enqueueCards(['unseen-card']);
  const queue = service.getStats();
  expect(queue.dueNew).toBe(1);
  expect(queue.due).toBe(queue.dueReview + queue.dueLearning + queue.dueNew);
  const stats = service.getReviewStatistics(30);
  expect(stats.days).toBe(30);
  expect(stats.ratingDistribution.total).toBe(1);
  expect(stats.ratingDistribution.good).toBe(1);
  expect(stats.dailyReviews).toHaveLength(1);
  expect(stats.dailyReviews[0]!.total).toBe(1);
  expect(stats.dailyReviews[0]!.good).toBe(1);
  expect(stats.dailyReviews[0]!.newIntroduced).toBe(1);
  expect(stats.stateBreakdown.total).toBe(2);
  expect(stats.dailyLimits.newIntroducedToday).toBe(1);
  expect(stats.dailyLimits.newRemainingToday).toBe(DEFAULT_NEW_PER_DAY - 1);
  expect(stats.dueForecast.reduce((sum, day) => sum + day.count, 0)).toBe(1);
  expect(stats.scheduledForecast).toHaveLength(7);
  expect(stats.scheduledForecast.every((day) => day.date > logicalDayKey(stats.dayStartMs, 4))).toBe(true);
});

it('retention_counts_only_first_review_per_card_per_day', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-ret2', 'task-ret2', 'card-ret2');
  const stateId = service.enqueueCards(['card-ret2']).states[0]!.id;
  const now = Date.now();
  db.run(`UPDATE fsrs_card_states SET state = 2, stability = 30.0, difficulty = 5.0,
      scheduled_days = 30.0, reps = 5, lapses = 0, due_ms = ?1, last_review_ms = ?2
    WHERE id = ?3`, [now, now - 30 * MS_PER_DAY, stateId]);
  service.rate(stateId, 3, 10, null);
  service.rate(stateId, 1, 10, null);
  const stats = service.getReviewStatistics(7);
  expect(stats.retention.matureReviews).toBe(1);
  expect(stats.retention.maturePassed).toBe(1);
  expect(stats.ratingDistribution.total).toBe(2);
});

it('memory_overview_lists_recent_cards_and_average_retrievability', () => {
  const { db, service } = setup();
  for (const card of ['card-mem-a', 'card-mem-b', 'card-mem-new', 'card-mem-paused']) {
    insertTaskAndCard(db, `doc-${card}`, `task-${card}`, card);
  }
  const stateA = enqueueAndRate(db, 'card-mem-a');
  const stateB = service.enqueueCards(['card-mem-b']).states[0]!.id;
  service.rate(stateB, 4, 10, null);
  service.enqueueCards(['card-mem-new']);
  const statePaused = enqueueAndRate(db, 'card-mem-paused');
  const now = Date.now();
  const seed = (id: string, stability: number, daysAgo: number): void => {
    db.run(`UPDATE fsrs_card_states SET state = 2, stability = ?1, last_review_ms = ?2 WHERE id = ?3`,
      [stability, now - daysAgo * MS_PER_DAY, id]);
  };
  seed(stateA, 10, 10);
  seed(stateB, 2, 1);
  seed(statePaused, 5, 0);
  db.run('UPDATE fsrs_card_states SET suspended = 1 WHERE id = ?1', [statePaused]);
  const overview = service.getMemoryOverview(null);
  expect(overview.recent.map(card => card.cardStateId)).toEqual([stateB, stateA]);
  expect(overview.recent[0]!.lastRating).toBe(4);
  expect(overview.recent[1]!.lastRating).toBe(3);
  expect(overview.recent[0]!.front).toBe('front-card-mem-b');
  expect(overview.memorizedCount).toBe(2);
  const [decay, factor] = forgettingCurveConstants([]);
  const expected = (0.9 + retrievability(1, 2, decay, factor)) / 2;
  expect(Math.abs(overview.averageRetrievability! - expected)).toBeLessThan(1e-4);
  expect(Math.abs(overview.desiredRetention - DEFAULT_DESIRED_RETENTION)).toBeLessThan(1e-9);
  if (!('decay' in overview.curve)) throw new Error('Expected the default V6 curve');
  expect(Math.abs(overview.curve.decay + 0.1542)).toBeLessThan(1e-6);
  expect(Math.abs(overview.curve.factor - (0.9 ** (-1 / 0.1542) - 1))).toBeLessThan(1e-6);
  expect(overview.trueRetention).toEqual({ windowDays: 30, reviews: 0, passed: 0 });
  const limited = service.getMemoryOverview(1);
  expect(limited.recent).toHaveLength(1);
  expect(limited.memorizedCount).toBe(2);
});

it('memory_overview_without_reviews_has_no_average', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-mem-empty', 'task-mem-empty', 'card-mem-empty');
  service.enqueueCards(['card-mem-empty']);
  const overview = service.getMemoryOverview(5);
  expect(overview.recent).toEqual([]);
  expect(overview.memorizedCount).toBe(0);
  expect(overview.averageRetrievability).toBeNull();
});

it('card_memory_history_returns_reviews_in_order', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-mem-history', 'task-mem-history', 'card-mem-history');
  const stateId = enqueueAndRate(db, 'card-mem-history');
  service.rate(stateId, 3, 10, null);
  db.run(`UPDATE fsrs_review_logs SET review_ms=1000,
      id=CASE state_before WHEN 0 THEN 'z-first' ELSE 'a-second' END,
      created_at=CASE state_before WHEN 0 THEN '2026-10-27T00:00:00.000001Z' ELSE '2026-10-27T00:00:00.000002Z' END
    WHERE card_state_id=?1`, [stateId]);
  const history = service.getCardMemoryHistory(stateId);
  expect(history.card.cardStateId).toBe(stateId);
  expect(history.card.state).toBe(2);
  expect(history.card.lastRating).toBe(3);
  const [decay, factor] = forgettingCurveConstants([]);
  expect(history.curve).toEqual({ decay, factor });
  expect(history.reviews.map(review => review.rating)).toEqual([3, 3]);
  expect(history.reviews[0]!.reviewMs <= history.reviews[1]!.reviewMs).toBe(true);
  expect(history.reviews[0]!.stateBefore).toBe(0);
  expect(history.reviews[1]!.stateAfter).toBe(2);
  for (const review of history.reviews) expect(review.stabilityAfter ?? 0).toBeGreaterThan(0);
  expect(history.card.stability).toBe(history.reviews[1]!.stabilityAfter);
  expect(history.card.dueMs).toBe(history.reviews[1]!.dueAfterMs);
  const missing = appErrorValue(() => service.getCardMemoryHistory('missing-state'));
  expect(missing.error_type).toBe('NotFound');
});

it('reset_card_progress_clears_history_and_rebuilds_new_state', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-reset', 'task-reset', 'card-reset');
  const oldStateId = enqueueAndRate(db, 'card-reset');
  const result = service.resetCardProgress(oldStateId);
  expect(result.state.id).not.toBe(oldStateId);
  expect(result.clearedLogs).toBe(1);
  expect(result.state.ankiCardId).toBe('card-reset');
  expect(result.state.state).toBe(0);
  expect(result.state.reps).toBe(0);
  expect(result.state.lapses).toBe(0);
  expect(result.state.lastReviewMs).toBeNull();
  expect(result.state.suspended).toBe(false);
  expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', ['card-reset']))).toBe(0);
  expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', ['card-reset']))).toBe(1);
  expect(service.getDue(null)).toHaveLength(1);
  expect(() => service.resetCardProgress(oldStateId)).toThrow();
});

// ---------------------------------------------------------------- enqueue scopes

it('session_enqueue_succeeds_then_skips_existing_state', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-owned', 'task-owned', 'card-owned');
  setTaskOwner(db, 'task-owned', 'session-owner');
  const first = service.enqueueCardsForSession(['card-owned', ' card-owned '], 'session-owner', null);
  expect(first.enqueued).toBe(1);
  expect(first.skipped).toBe(0);
  expect(first.enqueuedStateIds).toEqual([first.states[0]!.id]);
  expect(first.states).toHaveLength(1);
  expect(first.reviewCards).toHaveLength(1);
  expect(first.reviewCards[0]!.id).toBe(first.states[0]!.id);
  expect(first.reviewCards[0]!.ankiCardId).toBe('card-owned');
  const repeated = service.enqueueCardsForSession(['card-owned'], 'session-owner', null);
  expect(repeated.enqueued).toBe(0);
  expect(repeated.skipped).toBe(1);
  expect(repeated.enqueuedStateIds).toEqual([]);
  expect(repeated.states).toHaveLength(1);
  expect(repeated.reviewCards).toHaveLength(1);
  expect(repeated.reviewCards[0]!.id).toBe(repeated.states[0]!.id);
  expect(service.getEnqueuedCards(repeated)).toEqual([]);
  const stats = service.getStats();
  expect(stats.total).toBe(1);
  expect(stats.due).toBe(1);
  expect(stats.newCount).toBe(1);
});

it('enqueue_result_and_event_cards_distinguish_new_from_skipped_states', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-mixed', 'task-mixed', 'card-skipped');
  insertCardForTask(db, 'doc-mixed', 'task-mixed', 'card-new');
  db.run(`UPDATE anki_cards SET tags_json = '["new-tag"]', text = 'new {{c1::text}}' WHERE id = 'card-new'`, []);
  db.run(`UPDATE anki_cards SET tags_json = '["skipped-tag"]', text = 'skipped {{c1::text}}' WHERE id = 'card-skipped'`, []);
  const initial = service.enqueueCards(['card-skipped']);
  const skippedStateId = initial.states[0]!.id;
  const mixed = service.enqueueCards(['card-skipped', 'card-new']);
  expect(mixed.enqueued).toBe(1);
  expect(mixed.skipped).toBe(1);
  expect(mixed.states).toHaveLength(2);
  expect(mixed.reviewCards).toHaveLength(2);
  expect(mixed.reviewCards[0]!.id).toBe(skippedStateId);
  expect(mixed.reviewCards[0]!.ankiCardId).toBe('card-skipped');
  expect(mixed.reviewCards[0]!.front).toBe('front-card-skipped');
  expect(mixed.reviewCards[0]!.back).toBe('back-card-skipped');
  expect(mixed.reviewCards[0]!.tags).toEqual(['skipped-tag']);
  expect(mixed.reviewCards[0]!.text).toBe('skipped {{c1::text}}');
  expect(mixed.enqueuedStateIds).toHaveLength(1);
  expect(mixed.enqueuedStateIds[0]).not.toBe(skippedStateId);
  expect(mixed.states.find(state => state.id === mixed.enqueuedStateIds[0])!.ankiCardId).toBe('card-new');
  const eventCards = service.getEnqueuedCards(mixed);
  expect(eventCards).toHaveLength(1);
  expect(eventCards[0]!.id).toBe(mixed.enqueuedStateIds[0]);
  expect(eventCards[0]!.ankiCardId).toBe('card-new');
  expect(eventCards[0]!.front).toBe('front-card-new');
  expect(eventCards[0]!.back).toBe('back-card-new');
  expect(eventCards[0]!.tags).toEqual(['new-tag']);
  expect(eventCards[0]!.text).toBe('new {{c1::text}}');
  const serialized = JSON.parse(JSON.stringify(mixed)) as {
    enqueuedStateIds: string[]; reviewCards: Array<Record<string, unknown>>;
  };
  expect(serialized.enqueuedStateIds).toEqual(mixed.enqueuedStateIds);
  expect(serialized.reviewCards).toHaveLength(2);
  expect(serialized.reviewCards[0]!.ankiCardId).toBe('card-skipped');
  expect(serialized.reviewCards[0]!.front).toBe('front-card-skipped');
  expect(serialized.reviewCards[1]!.ankiCardId).toBe('card-new');
  expect(serialized.reviewCards[1]!.text).toBe('new {{c1::text}}');
  const skippedOnly = service.enqueueCards(['card-skipped', 'card-new']);
  expect(skippedOnly.enqueued).toBe(0);
  expect(skippedOnly.skipped).toBe(2);
  expect(skippedOnly.states).toHaveLength(2);
  expect(skippedOnly.reviewCards).toHaveLength(2);
  expect(service.getEnqueuedCards(skippedOnly)).toEqual([]);
  const skippedSerialized = JSON.parse(JSON.stringify(skippedOnly)) as { reviewCards: Array<Record<string, unknown>> };
  expect(skippedSerialized.reviewCards).toHaveLength(2);
  expect(skippedSerialized.reviewCards[0]!.front).toBe('front-card-skipped');
});

it('enqueue_rolls_back_when_review_card_snapshot_is_invalid', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-invalid-content', 'task-invalid-content', 'card-invalid');
  db.run(`UPDATE anki_cards SET tags_json = 'not-json' WHERE id = 'card-invalid'`, []);
  const error = appErrorValue(() => service.enqueueCards(['card-invalid']));
  expect(error.message).toContain('解析入队卡片标签失败');
  expect(service.getStats().total).toBe(0);

  db.run(`UPDATE anki_cards SET tags_json = '[]', extra_fields_json = 'not-json' WHERE id = 'card-invalid'`, []);
  const extraError = appErrorValue(() => service.enqueueCards(['card-invalid']));
  expect(extraError.message).toContain('解析入队卡片扩展字段失败');
  expect(service.getStats().total).toBe(0);

  db.run(`UPDATE anki_cards SET extra_fields_json = '{"source":"book"}', images_json = 'not-json' WHERE id = 'card-invalid'`, []);
  const imageError = appErrorValue(() => service.enqueueCards(['card-invalid']));
  expect(imageError.message).toContain('解析入队卡片图片失败');
  expect(service.getStats().total).toBe(0);

  db.run(`UPDATE anki_cards SET images_json = '[]', extra_fields_json = '{"source":1}' WHERE id = 'card-invalid'`, []);
  const nonStringError = appErrorValue(() => service.enqueueCards(['card-invalid']));
  expect(nonStringError.message).toContain('解析入队卡片扩展字段失败');
  expect(service.getStats().total).toBe(0);
});

it('session_enqueue_rolls_back_mixed_owner_batch', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-owner', 'task-owner', 'card-owner');
  setTaskOwner(db, 'task-owner', 'session-owner');
  insertTaskAndCard(db, 'doc-foreign', 'task-foreign', 'card-foreign');
  setTaskOwner(db, 'task-foreign', 'session-foreign');
  const error = appErrorValue(() =>
    service.enqueueCardsForSession(['card-owner', 'card-foreign'], 'session-owner', null));
  expect(error.message).toBe('blocks.ankiCards.errors.statusNotFound');
  expect(service.getStats().total).toBe(0);
});

it('document_selector_reloads_more_than_one_hundred_live_cards', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-large', 'task-large', 'card-large-0');
  setTaskOwner(db, 'task-large', 'session-owner');
  for (let index = 1; index <= 100; index++) {
    insertCardForTask(db, 'doc-large', 'task-large', `card-large-${index}`);
  }
  const explicitIds = Array.from({ length: 101 }, (_, index) => `card-large-${index}`);
  const explicitError = appErrorValue(() =>
    service.enqueueCardsForSession(explicitIds, 'session-owner', null));
  expect(explicitError.message).toContain('at most 100');
  const documentResult = service.enqueueCardsForSession([], 'session-owner', 'doc-large');
  expect(documentResult.enqueued).toBe(101);
  expect(documentResult.skipped).toBe(0);
  expect(documentResult.states).toHaveLength(101);
  expect(service.getStats().total).toBe(101);
});

it('document_selector_ignores_soft_deleted_cards_during_transaction_reload', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-live', 'task-live', 'card-live');
  insertCardForTask(db, 'doc-live', 'task-live', 'card-soft-deleted');
  setTaskOwner(db, 'task-live', 'session-owner');
  db.run('UPDATE anki_cards SET deleted_at = ?1 WHERE id = ?2', ['2026-07-13T00:00:00Z', 'card-soft-deleted']);
  const result = service.enqueueCardsForSession(['card-soft-deleted'], 'session-owner', 'doc-live');
  expect(result.enqueued).toBe(1);
  expect(result.skipped).toBe(0);
  expect(result.states).toHaveLength(1);
  expect(result.states[0]!.ankiCardId).toBe('card-live');
  expect(service.getStats().total).toBe(1);
});

it('document_selector_excludes_diagnostic_cards', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-diagnostic', 'task-diagnostic', 'card-reviewable');
  insertCardForTask(db, 'doc-diagnostic', 'task-diagnostic', 'card-diagnostic');
  setTaskOwner(db, 'task-diagnostic', 'session-owner');
  db.run(`UPDATE anki_cards SET is_error_card = 1, error_content = 'generation failed' WHERE id = 'card-diagnostic'`, []);
  const result = service.enqueueCardsForSession(['card-diagnostic'], 'session-owner', 'doc-diagnostic');
  expect(result.enqueued).toBe(1);
  expect(result.skipped).toBe(0);
  expect(result.states).toHaveLength(1);
  expect(result.states[0]!.ankiCardId).toBe('card-reviewable');
  assertNoFsrsRows(db, ['card-diagnostic']);
});

it('explicit_card_ids_reject_diagnostic_card_atomically', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-explicit-diagnostic', 'task-explicit-diagnostic', 'card-reviewable');
  insertCardForTask(db, 'doc-explicit-diagnostic', 'task-explicit-diagnostic', 'card-diagnostic');
  setTaskOwner(db, 'task-explicit-diagnostic', 'session-owner');
  db.run(`UPDATE anki_cards SET is_error_card = 1, error_content = 'generation failed' WHERE id = 'card-diagnostic'`, []);
  const error = appErrorValue(() =>
    service.enqueueCardsForSession(['card-reviewable', 'card-diagnostic'], 'session-owner', null));
  expect(error.error_type).toBe('Validation');
  expect((error.details as Record<string, unknown>).errorCode).toBe('fsrs_diagnostic_card_not_reviewable');
  expect((error.details as Record<string, unknown>).cardId).toBe('card-diagnostic');
  assertNoFsrsRows(db, ['card-reviewable', 'card-diagnostic']);
});

it('rate_rejects_card_that_became_diagnostic_without_mutating_state_or_logs', () => {
  const { db, service } = setup();
  const cardId = 'card-stale-diagnostic';
  insertTaskAndCard(db, 'doc-stale-diagnostic', 'task-stale-diagnostic', cardId);
  const enqueued = service.enqueueCards([cardId]);
  expect(enqueued.enqueued).toBe(1);
  const stateId = enqueued.states[0]!.id;
  db.run(`UPDATE anki_cards SET is_error_card = 1, error_content = 'late generation diagnostic' WHERE id = ?1`, [cardId]);
  const fingerprint = (): [unknown, number] => [db.get('SELECT * FROM fsrs_card_states WHERE id = ?1', [stateId]),
    Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1 OR anki_card_id = ?2', [stateId, cardId]))];
  const before = fingerprint();
  expect(before[1]).toBe(0);
  const error = appErrorValue(() => service.rate(stateId, 3, 125, null));
  expect(error.error_type).toBe('Validation');
  expect((error.details as Record<string, unknown>).errorCode).toBe('fsrs_diagnostic_card_not_reviewable');
  expect((error.details as Record<string, unknown>).cardId).toBe(cardId);
  expect(fingerprint()).toEqual(before);
});

it('due_and_stats_hide_card_that_became_diagnostic_after_enqueue', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-due-diagnostic', 'task-due-diagnostic', 'card-due-diagnostic');
  const result = service.enqueueCards(['card-due-diagnostic']);
  expect(result.enqueued).toBe(1);
  service.rate(result.states[0]!.id, 3, 25, null);
  db.run(`UPDATE fsrs_card_states SET state = 0, suspended = 0, due_ms = ?1
    WHERE anki_card_id = 'card-due-diagnostic'`, [Date.now() - 1]);
  expect(service.getDue(null)).toHaveLength(1);
  const initial = service.getStats();
  expect(initial.total).toBe(1);
  expect(initial.due).toBe(1);
  expect(initial.newCount).toBe(1);
  expect(initial.reviewsToday).toBe(1);
  db.run(`UPDATE anki_cards SET is_error_card = 1, error_content = 'late diagnostic' WHERE id = 'card-due-diagnostic'`, []);
  expect(service.getDue(null)).toEqual([]);
  const diagnostic = service.getStats();
  expect(diagnostic.total).toBe(0);
  expect(diagnostic.due).toBe(0);
  expect(diagnostic.newCount).toBe(0);
  expect(diagnostic.learning).toBe(0);
  expect(diagnostic.review).toBe(0);
  expect(diagnostic.relearning).toBe(0);
  expect(diagnostic.suspended).toBe(0);
  expect(diagnostic.reviewsToday).toBe(0);
  db.run(`UPDATE fsrs_card_states SET suspended = 1 WHERE anki_card_id = 'card-due-diagnostic'`, []);
  const suspendedStats = service.getStats();
  expect(suspendedStats.total).toBe(0);
  expect(suspendedStats.suspended).toBe(0);
  expect(suspendedStats.reviewsToday).toBe(0);
});

it('document_selector_rechecks_all_task_owners_before_writing', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-race', 'task-race-owner', 'card-race-owner');
  setTaskOwner(db, 'task-race-owner', 'session-owner');
  const previouslyResolved = ['card-race-owner'];
  insertTaskAndCard(db, 'doc-race', 'task-race-foreign', 'card-race-foreign');
  setTaskOwner(db, 'task-race-foreign', 'session-foreign');
  const error = appErrorValue(() =>
    service.enqueueCardsForSession(previouslyResolved, 'session-owner', 'doc-race'));
  expect(error.message).toBe('blocks.ankiCards.errors.statusNotFound');
  expect(service.getStats().total).toBe(0);
});

it('stats_report_every_fsrs_bucket_and_reviews_today', () => {
  const { db, service } = setup();
  const cardIds = Array.from({ length: 5 }, (_, index) => `card-stats-${index}`);
  cardIds.forEach((cardId, index) => {
    insertTaskAndCard(db, `doc-stats-${index}`, `task-stats-${index}`, cardId);
  });
  const enqueued = service.enqueueCards(cardIds);
  service.rate(enqueued.states[0]!.id, 3, 50, null);
  const now = Date.now();
  const buckets: Array<[number, number, number]> = [
    [0, 0, now - 1],
    [1, 0, now + MS_PER_DAY],
    [2, 0, now + MS_PER_DAY],
    [3, 0, now + MS_PER_DAY],
    [2, 1, now - 1],
  ];
  buckets.forEach(([state, suspended, dueMs], index) => {
    db.run(`UPDATE fsrs_card_states SET state = ?1, suspended = ?2, due_ms = ?3 WHERE anki_card_id = ?4`,
      [state, suspended, dueMs, cardIds[index]!]);
  });
  const stats = service.getStats();
  expect(stats.total).toBe(5);
  expect(stats.due).toBe(1);
  expect(stats.newCount).toBe(1);
  expect(stats.learning).toBe(1);
  expect(stats.review).toBe(1);
  expect(stats.relearning).toBe(1);
  expect(stats.suspended).toBe(1);
  expect(stats.reviewsToday).toBe(1);
});

// ---------------------------------------------------------------- undo

it('undo_snapshot_migration_is_registered_and_idempotent', () => {
  const { db } = setup();
  const columns = db.all<{ name: string }>('PRAGMA table_info(fsrs_review_logs)').map(row => row.name);
  expect(columns).toContain('state_before_json');
  expect(Number(db.pluck(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_fsrs_logs_state_active'`))).toBe(1);
});

it('rate_captures_complete_snapshot_and_undo_restores_every_field', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-undo', 'task-undo', 'card-undo');
  const stateId = service.enqueueCards(['card-undo']).states[0]!.id;
  db.run(`UPDATE fsrs_card_states SET
      deck_id = 'deck_default', state = 2, stability = 8.25,
      difficulty = 4.75, elapsed_days = 6.0, scheduled_days = 7.0,
      reps = 9, lapses = 2, due_ms = 1700000000000,
      last_review_ms = 1699395200000, suspended = 0,
      fsrs_params_version = 'legacy-fixture', desired_retention = 0.87,
      updated_at = '2020-01-01T00:00:00Z', local_version = 7
    WHERE id = ?1`, [stateId]);
  const before = service.getCardState(stateId)!;
  expect(service.getStats().reviewsToday).toBe(0);
  const rated = service.rate(stateId, 1, 321, null);
  const snapshotJson = db.pluck<string>('SELECT state_before_json FROM fsrs_review_logs WHERE id = ?1', [rated.logId])!;
  expect(JSON.parse(snapshotJson)).toEqual(stateBeforeSnapshot(before));
  expect(service.getStats().reviewsToday).toBe(1);
  const undone = service.undoLastReview(rated.logId, stateId);
  expect(undone.changed).toBe(true);
  expect(undone.undoneLogId).toBe(rated.logId);
  assertSameSchedulingState(undone.state, before);
  expect(undone.state.updatedAt).not.toBe(before.updatedAt);
  expect(service.getStats().reviewsToday).toBe(0);
  expect(Number(db.pluck('SELECT local_version FROM fsrs_card_states WHERE id = ?1', [stateId]))).toBe(9);
  const log = db.get<{ deleted_at: string | null; updated_at: string | null; local_version: number }>(
    'SELECT deleted_at, updated_at, local_version FROM fsrs_review_logs WHERE id = ?1', [rated.logId],
  )!;
  expect(log.deleted_at).not.toBeNull();
  expect(log.updated_at).toBe(log.deleted_at);
  expect(log.local_version).toBe(1);
});

it('consecutive_ratings_only_allow_the_latest_log_to_be_undone', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-chain', 'task-chain', 'card-chain');
  const stateId = service.enqueueCards(['card-chain']).states[0]!.id;
  const first = service.rate(stateId, 3, null, null);
  const second = service.rate(stateId, 2, null, null);
  const beforeStale = undoFingerprint(db, stateId, first.logId);
  const error = appErrorValue(() => service.undoLastReview(first.logId, stateId));
  expect(error.message.includes('过期') || error.message.includes('stale')).toBe(true);
  expect(undoFingerprint(db, stateId, first.logId)).toEqual(beforeStale);
  const undone = service.undoLastReview(second.logId, stateId);
  assertSameSchedulingState(undone.state, first.cardState);
  expect(Number(db.pluck(
    'SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1 AND deleted_at IS NULL', [stateId],
  ))).toBe(1);
});

it('undo_with_another_cards_log_is_a_conflict_not_a_missing_log', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-cross', 'task-cross', 'card-cross-a');
  insertCardForTask(db, 'doc-cross', 'task-cross', 'card-cross-b');
  const [stateA, stateB] = service.enqueueCards(['card-cross-a', 'card-cross-b']).states.map(state => state.id);
  const rated = service.rate(stateA!, 3, null, null);
  expect(appErrorValue(() => service.undoLastReview(rated.logId, stateB!))).toMatchObject({
    error_type: 'Conflict', message: 'review log does not belong to the requested card state',
  });
  expect(appErrorValue(() => service.undoLastReview('missing-log', stateA!))).toMatchObject({
    error_type: 'NotFound', message: 'active fsrs review log not found: missing-log',
  });
});

it('undo_rejects_a_post_rating_suspension_without_overwriting_it', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-undo-suspended', 'task-undo-suspended', 'card-undo-suspended');
  const stateId = service.enqueueCards(['card-undo-suspended']).states[0]!.id;
  const rated = service.rate(stateId, 3, null, null);
  service.suspendCard(stateId);
  const before = undoFingerprint(db, stateId, rated.logId);
  const error = appErrorValue(() => service.undoLastReview(rated.logId, stateId));
  expect(error.message.includes('过期') || error.message.includes('stale')).toBe(true);
  expect(undoFingerprint(db, stateId, rated.logId)).toEqual(before);
  expect(service.getDue(null)).toEqual([]);
});

it('undo_rejects_wrong_null_damaged_and_state_stale_inputs_without_writes', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-reject-a', 'task-reject-a', 'card-reject-a');
  insertTaskAndCard(db, 'doc-reject-b', 'task-reject-b', 'card-reject-b');
  const states = service.enqueueCards(['card-reject-a', 'card-reject-b']).states;
  const stateA = stateOf(states, 'card-reject-a');
  const stateB = stateOf(states, 'card-reject-b');
  const rated = service.rate(stateA, 3, null, null);
  const baseline = undoFingerprint(db, stateA, rated.logId);
  expect(() => service.undoLastReview(rated.logId, stateB)).toThrow();
  expect(undoFingerprint(db, stateA, rated.logId)).toEqual(baseline);
  expect(() => service.undoLastReview('missing-log', stateA)).toThrow();
  expect(undoFingerprint(db, stateA, rated.logId)).toEqual(baseline);
  for (const damaged of [null, '{', '{}']) {
    db.run('UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2', [damaged, rated.logId]);
    const before = undoFingerprint(db, stateA, rated.logId);
    expect(() => service.undoLastReview(rated.logId, stateA)).toThrow();
    expect(undoFingerprint(db, stateA, rated.logId)).toEqual(before);
  }
  const original = states.find(state => state.id === stateA)!;
  db.run('UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2', [
    JSON.stringify(stateBeforeSnapshot(original)), rated.logId,
  ]);
  db.run('UPDATE fsrs_card_states SET last_review_ms = last_review_ms - 1 WHERE id = ?1', [stateA]);
  const before = undoFingerprint(db, stateA, rated.logId);
  expect(() => service.undoLastReview(rated.logId, stateA)).toThrow();
  expect(undoFingerprint(db, stateA, rated.logId)).toEqual(before);
});

it('suspend_and_unsuspend_are_atomic_idempotent_and_control_due_visibility', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-suspend', 'task-suspend', 'card-suspend');
  const initial = service.enqueueCards(['card-suspend']).states[0]!;
  expect(service.getDue(null)).toHaveLength(1);
  const suspended = service.suspendCard(initial.id);
  expect(suspended.changed).toBe(true);
  expect(suspended.state.suspended).toBe(true);
  expect(suspended.state.dueMs).toBe(initial.dueMs);
  expect(service.getDue(null)).toEqual([]);
  expect(() => service.rate(initial.id, 3, null, null)).toThrow();
  const fingerprint = (): [string, number] => [db.pluck<string>('SELECT updated_at FROM fsrs_card_states WHERE id = ?1', [initial.id])!,
    Number(db.pluck('SELECT local_version FROM fsrs_card_states WHERE id = ?1', [initial.id]))];
  const suspendedFingerprint = fingerprint();
  const repeated = service.suspendCard(initial.id);
  expect(repeated.changed).toBe(false);
  expect(fingerprint()).toEqual(suspendedFingerprint);
  const stats = service.getStats();
  expect(stats.suspended).toBe(1);
  expect(stats.due).toBe(0);
  const unsuspended = service.unsuspendCard(initial.id);
  expect(unsuspended.changed).toBe(true);
  expect(unsuspended.state.suspended).toBe(false);
  expect(unsuspended.state.dueMs).toBe(initial.dueMs);
  expect(service.getDue(null)).toHaveLength(1);
  expect(service.unsuspendCard(initial.id).changed).toBe(false);
  expect(Number(db.pluck('SELECT local_version FROM fsrs_card_states WHERE id = ?1', [initial.id]))).toBe(2);
});

// ---------------------------------------------------------------- agent scopes

it('agent_review_state_batch_read_distinguishes_unenqueued_and_latest_review', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-agent-read', 'task-agent-read', 'card-agent-a');
  insertCardForTask(db, 'doc-agent-read', 'task-agent-read', 'card-agent-b');
  setTaskOwner(db, 'task-agent-read', 'session-owner');
  expect(service.getReviewStatesForSession(['card-agent-a', 'card-agent-b'], 'session-owner')).toEqual([]);
  expect(service.setSuspendedForSession('card-agent-a', 'session-owner', 0, true).status).toBe('not_found');
  const enqueued = service.enqueueCardsForSession(['card-agent-a'], 'session-owner', null);
  const initial = service.getReviewStatesForSession(
    ['card-agent-a', 'card-agent-b', 'card-agent-a'], 'session-owner',
  );
  expect(initial).toHaveLength(1);
  expect(initial[0]!.ankiCardId).toBe('card-agent-a');
  expect(initial[0]!.cardStateId).toBe(enqueued.states[0]!.id);
  expect(initial[0]!.reviewVersion).toBe(0n);
  expect(initial[0]!.latestReview).toBeNull();
  const rated = service.rate(initial[0]!.cardStateId, 3, 125, null);
  const reviewed = service.getReviewStatesForSession(['card-agent-a'], 'session-owner');
  expect(reviewed[0]!.reviewVersion).toBe(1n);
  expect(reviewed[0]!.lastReviewMs).toBe(reviewed[0]!.latestReview!.reviewMs);
  expect(reviewed[0]!.latestReview).toEqual({
    logId: rated.logId, rating: 3, reviewMs: reviewed[0]!.lastReviewMs, undoable: true,
  });
});

it('agent_review_access_hides_mixed_owner_and_tombstoned_cards', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-agent-guard', 'task-agent-owner', 'card-agent-owner');
  insertTaskAndCard(db, 'doc-agent-guard', 'task-agent-foreign', 'card-agent-foreign');
  setTaskOwner(db, 'task-agent-owner', 'session-owner');
  setTaskOwner(db, 'task-agent-foreign', 'session-foreign');
  service.enqueueCards(['card-agent-owner', 'card-agent-foreign']);
  expect(appErrorValue(() => service.getReviewStatesForSession(['card-agent-owner'], 'session-owner')).error_type).toBe('NotFound');
  expect(service.setSuspendedForSession('card-agent-owner', 'session-owner', 0, true).status).toBe('not_found');
  setTaskOwner(db, 'task-agent-foreign', 'session-owner');
  db.run(`UPDATE anki_cards SET deleted_at = '2026-07-14T00:00:00Z' WHERE id = 'card-agent-owner'`, []);
  expect(appErrorValue(() => service.getReviewStatesForSession(['card-agent-owner'], 'session-owner')).error_type).toBe('NotFound');
  expect(service.undoLastReviewForSession('card-agent-owner', 'session-owner', 0, 'missing-log').status).toBe('not_found');
  insertTaskAndCard(db, 'doc-agent-task-tombstone', 'task-agent-tombstone', 'card-agent-task-tombstone');
  setTaskOwner(db, 'task-agent-tombstone', 'session-owner');
  service.enqueueCardsForSession(['card-agent-task-tombstone'], 'session-owner', null);
  db.run(`UPDATE document_tasks SET deleted_at = '2026-07-14T00:00:00Z' WHERE id = 'task-agent-tombstone'`, []);
  expect(appErrorValue(() => service.getReviewStatesForSession(['card-agent-task-tombstone'], 'session-owner')).error_type).toBe('NotFound');
  expect(service.setSuspendedForSession('card-agent-task-tombstone', 'session-owner', 0, true).status).toBe('not_found');
});

it('agent_suspension_is_versioned_idempotent_and_stale_safe', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-agent-suspend', 'task-agent-suspend', 'card-agent-suspend');
  setTaskOwner(db, 'task-agent-suspend', 'session-owner');
  service.enqueueCardsForSession(['card-agent-suspend'], 'session-owner', null);
  const unchanged = expectAgentUpdated(
    service.setSuspendedForSession('card-agent-suspend', 'session-owner', 0, false), false,
  );
  expect(unchanged.reviewVersion).toBe(0n);
  expect(unchanged.suspended).toBe(false);
  const suspended = expectAgentUpdated(
    service.setSuspendedForSession('card-agent-suspend', 'session-owner', 0, true), true,
  );
  expect(suspended.suspended).toBe(true);
  expect(suspended.reviewVersion).toBe(1n);
  const repeated = expectAgentUpdated(
    service.setSuspendedForSession('card-agent-suspend', 'session-owner', 1, true), false,
  );
  expect(repeated).toEqual(suspended);
  const resumed = expectAgentUpdated(
    service.setSuspendedForSession('card-agent-suspend', 'session-owner', 1, false), true,
  );
  expect(resumed.suspended).toBe(false);
  expect(resumed.reviewVersion).toBe(2n);
  const stale = service.setSuspendedForSession('card-agent-suspend', 'session-owner', 1, true);
  expect(stale.status).toBe('conflict');
  if (stale.status === 'conflict') expect(stale.current).toEqual(resumed);
});

it('agent_undo_restores_snapshot_and_publishes_a_new_version', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-agent-undo', 'task-agent-undo', 'card-agent-undo');
  setTaskOwner(db, 'task-agent-undo', 'session-owner');
  const initialState = service.enqueueCardsForSession(['card-agent-undo'], 'session-owner', null).states[0]!;
  const rated = service.rate(initialState.id, 4, 500, null);
  const current = service.getReviewStatesForSession(['card-agent-undo'], 'session-owner')[0]!;
  expect(current.reviewVersion).toBe(1n);
  expect(current.latestReview!.undoable).toBe(true);
  const restored = expectAgentUpdated(
    service.undoLastReviewForSession('card-agent-undo', 'session-owner', current.reviewVersion, rated.logId),
    true,
  );
  expect(restored.reviewVersion).toBe(2n);
  expect(restored.state).toBe(initialState.state);
  expect(restored.dueMs).toBe(initialState.dueMs);
  expect(restored.lastReviewMs).toBe(initialState.lastReviewMs);
  expect(restored.latestReview).toBeNull();
  expect(db.pluck('SELECT deleted_at FROM fsrs_review_logs WHERE id = ?1', [rated.logId])).not.toBeNull();
  assertSameSchedulingState(service.getCardState(initialState.id)!, initialState);
});

it('agent_undo_conflicts_on_stale_tokens_and_blocks_invalid_snapshots', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-agent-stale', 'task-agent-stale', 'card-agent-stale');
  setTaskOwner(db, 'task-agent-stale', 'session-owner');
  const stateId = service.enqueueCardsForSession(['card-agent-stale'], 'session-owner', null).states[0]!.id;
  const first = service.rate(stateId, 3, null, null);
  const second = service.rate(stateId, 2, null, null);
  const current = service.getReviewStatesForSession(['card-agent-stale'], 'session-owner')[0]!;
  expect(current.reviewVersion).toBe(2n);
  expect(service.undoLastReviewForSession('card-agent-stale', 'session-owner', 1, second.logId).status).toBe('conflict');
  expect(service.undoLastReviewForSession('card-agent-stale', 'session-owner', 2, first.logId).status).toBe('conflict');
  const before = undoFingerprint(db, stateId, second.logId);
  const snapshotJson = db.pluck<string>('SELECT state_before_json FROM fsrs_review_logs WHERE id = ?1', [second.logId])!;
  const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
  snapshot.snapshotVersion = 99;
  db.run('UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2', [JSON.stringify(snapshot), second.logId]);
  const damaged = undoFingerprint(db, stateId, second.logId);
  const blocked = service.undoLastReviewForSession('card-agent-stale', 'session-owner', 2, second.logId);
  expect(blocked.status).toBe('blocked');
  if (blocked.status === 'blocked') {
    expect(blocked.reason).toBe('undo_snapshot_invalid');
    expect(blocked.current.reviewVersion).toBe(2n);
    expect(blocked.current.latestReview!.undoable).toBe(false);
  }
  expect(undoFingerprint(db, stateId, second.logId)).toEqual(damaged);
  expect(damaged).not.toEqual(before);
});

it('v2_s1_due_card_json_fields_fail_whole_like_serde_not_per_entry', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-due-json', 'task-due-json', 'card-due-json');
  service.enqueueCards(['card-due-json']);
  const due = (tags: string, extra: string, images: string) => {
    db.run('UPDATE anki_cards SET tags_json = ?1, extra_fields_json = ?2, images_json = ?3 WHERE id = ?4',
      [tags, extra, images, 'card-due-json']);
    const card = service.getDue(null)[0]!;
    return { tags: card.tags, extraFields: card.extraFields, images: card.images };
  };
  // Rust `serde_json::from_str::<HashMap<String, String>>(..).ok().unwrap_or_default()`: one bad
  // entry empties the whole map instead of being filtered out.
  expect(due('["a",1]', '{"keep":"x","bad":1}', '["i.png",null]')).toEqual({ tags: [], extraFields: {}, images: [] });
  expect(due('["a","\\ud800"]', '{"k":"\\udc00"}', '["ok.png"]')).toEqual({ tags: [], extraFields: {}, images: ['ok.png'] });
  expect(due('["a","b"]', '{"k":"v","k":"w"}', '[]')).toEqual({ tags: ['a', 'b'], extraFields: { k: 'w' }, images: [] });
});

it('v2_s1_undo_decodes_legacy_snapshot_defaults_like_serde', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-legacy-snap', 'task-legacy-snap', 'card-legacy-snap');
  const initial = service.enqueueCards(['card-legacy-snap']).states[0]!;
  const rated = service.rate(initial.id, 3, null, null);
  // Pre-V20260722 / pre-V20261005 snapshots lack leech, buriedUntilMs and learningStep.
  const { leech: _l, buriedUntilMs: _b, learningStep: _s, ...legacy } = stateBeforeSnapshot(initial);
  db.run('UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2', [
    JSON.stringify({ ...legacy, futureField: 'ignored' }), rated.logId,
  ]);
  db.run('UPDATE fsrs_card_states SET leech = 1, learning_step = 2 WHERE id = ?1', [initial.id]);
  const undone = service.undoLastReview(rated.logId, initial.id);
  expect(undone.changed).toBe(true);
  expect(undone.state.leech).toBe(false);
  expect(undone.state.buriedUntilMs).toBeNull();
  expect(undone.state.learningStep).toBe(0);
  assertSameSchedulingState(undone.state, initial);
});

it('v2_s1_undo_and_agent_state_reject_snapshots_serde_cannot_decode', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-strict-snap', 'task-strict-snap', 'card-strict-snap');
  setTaskOwner(db, 'task-strict-snap', 'session-owner');
  const initial = service.enqueueCardsForSession(['card-strict-snap'], 'session-owner', null).states[0]!;
  const rated = service.rate(initial.id, 3, null, null);
  const good = JSON.stringify(stateBeforeSnapshot(initial));
  const reps = `"reps":${initial.reps}`;
  const due = `"dueMs":${initial.dueMs}`;
  expect(good.includes(reps) && good.includes(due)).toBe(true);
  const damaged = [
    good.replace(reps, '"reps":"0"'),
    good.replace(reps, `"reps":${initial.reps}.0`),
    good.replace(reps, '"reps":2147483648'),
    good.replace(due, `"dueMs":${initial.dueMs}.5`),
    good.replace(due, '"dueMs":9223372036854775808'),
    good.replace('"snapshotVersion":1', '"snapshotVersion":1e0'),
    good.replace('"suspended":false', '"suspended":0'),
    good.replace('"leech":false', '"leech":null'),
    good.replace('"learningStep":0', '"learningStep":-1'),
    good.replace('"elapsedDays":', '"elapsedDays":1e400,"x":'),
    good.replace(`"cardStateId":"${initial.id}"`, '"cardStateId":"\\ud800"'),
    good.replace(/"state":\d+,/, ''),
    '[]',
    'null',
  ];
  for (const json of damaged) {
    expect(json).not.toBe(good);
    db.run('UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2', [json, rated.logId]);
    const before = undoFingerprint(db, initial.id, rated.logId);
    const agent = service.getReviewStatesForSession(['card-strict-snap'], 'session-owner')[0]!;
    expect(agent.latestReview!.undoable, json).toBe(false);
    const blocked = service.undoLastReviewForSession('card-strict-snap', 'session-owner', agent.reviewVersion, rated.logId);
    expect(blocked.status === 'blocked' && blocked.reason, json).toBe('undo_snapshot_damaged');
    const error = appErrorValue(() => service.undoLastReview(rated.logId, initial.id));
    expect(error.message, json).toBe('review log contains a damaged FSRS snapshot');
    expect(undoFingerprint(db, initial.id, rated.logId)).toEqual(before);
  }
  // serde also accepts the struct in sequence form, with trailing #[serde(default)] fields omitted.
  const snapshot = stateBeforeSnapshot(initial);
  const positional = [
    snapshot.snapshotVersion, snapshot.cardStateId, snapshot.ankiCardId, snapshot.deckId, snapshot.state,
    snapshot.stability, snapshot.difficulty, snapshot.elapsedDays, snapshot.scheduledDays, snapshot.reps,
    snapshot.lapses, snapshot.dueMs, snapshot.lastReviewMs, snapshot.suspended, snapshot.fsrsParamsVersion,
    snapshot.desiredRetention,
  ];
  db.run('UPDATE fsrs_review_logs SET state_before_json = ?1 WHERE id = ?2', [JSON.stringify(positional), rated.logId]);
  const agent = service.getReviewStatesForSession(['card-strict-snap'], 'session-owner')[0]!;
  expect(agent.latestReview!.undoable).toBe(true);
  const restored = expectAgentUpdated(
    service.undoLastReviewForSession('card-strict-snap', 'session-owner', agent.reviewVersion, rated.logId),
    true,
  );
  expect(restored.dueMs).toBe(initial.dueMs);
  assertSameSchedulingState(service.getCardState(initial.id)!, initial);
});

it('v2_s4_agent_cas_rejects_non_i64_inputs_and_non_integer_sqlite_cells', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-cas-big', 'task-cas-big', 'card-cas-big');
  setTaskOwner(db, 'task-cas-big', 'session-owner');
  const stateId = service.enqueueCardsForSession(['card-cas-big'], 'session-owner', null).states[0]!.id;
  const rated = service.rate(stateId, 3, null, null);
  const fingerprint = () => undoFingerprint(db, stateId, rated.logId);

  const baseline = fingerprint();
  for (const bad of [Number.NaN, 0.5, Number.POSITIVE_INFINITY, 2 ** 63, -1, -1n, 9223372036854775808n]) {
    expect(appErrorValue(() => service.setSuspendedForSession('card-cas-big', 'session-owner', bad, true)).message, String(bad))
      .toBe('cardId and a non-negative expectedReviewVersion are required');
    expect(appErrorValue(() => service.undoLastReviewForSession('card-cas-big', 'session-owner', bad, rated.logId)).message, String(bad))
      .toBe('cardId, non-negative expectedReviewVersion, and expectedLogId are required');
    expect(fingerprint()).toEqual(baseline);
  }

  // A JS number input remains supported, but owner output/SQL comparisons stay exact bigint.
  const nearLimit = 9007199254740992;
  db.run('UPDATE fsrs_card_states SET local_version = ?1 WHERE id = ?2', [BigInt(nearLimit), stateId]);
  expect(service.getReviewStatesForSession(['card-cas-big'], 'session-owner')[0]!.reviewVersion).toBe(9007199254740992n);
  const suspended = expectAgentUpdated(service.setSuspendedForSession('card-cas-big', 'session-owner', nearLimit, true), true);
  expect(suspended.reviewVersion).toBe(9007199254740993n);

  // A neighbouring (rounded) token conflicts, not a Database failure or an accidental match.
  const before = fingerprint();
  expect(service.setSuspendedForSession('card-cas-big', 'session-owner', nearLimit, false)).toMatchObject({
    status: 'conflict', current: { reviewVersion: 9007199254740993n },
  });
  expect(fingerprint()).toEqual(before);

  // Rust `row.get::<i64>` rejects a REAL cell rather than truncating it.
  db.run('UPDATE fsrs_card_states SET local_version = 1.5 WHERE id = ?1', [stateId]);
  const real = appErrorValue(() => service.getReviewStatesForSession(['card-cas-big'], 'session-owner'));
  expect(real.error_type).toBe('Database');
  expect(real.message).toContain('local_version has SQLite type real, expected integer');
});

it('agent_review_mutations_block_diagnostic_cards_without_writes', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-agent-diagnostic', 'task-agent-diagnostic', 'card-agent-diagnostic');
  setTaskOwner(db, 'task-agent-diagnostic', 'session-owner');
  const stateId = service.enqueueCardsForSession(['card-agent-diagnostic'], 'session-owner', null).states[0]!.id;
  const rated = service.rate(stateId, 3, null, null);
  db.run(`UPDATE anki_cards SET is_error_card = 1, error_content = 'late diagnostic' WHERE id = 'card-agent-diagnostic'`, []);
  const current = service.getReviewStatesForSession(['card-agent-diagnostic'], 'session-owner')[0]!;
  expect(current.latestReview!.undoable).toBe(false);
  const before = undoFingerprint(db, stateId, rated.logId);
  for (const outcome of [
    service.setSuspendedForSession('card-agent-diagnostic', 'session-owner', current.reviewVersion, true),
    service.undoLastReviewForSession('card-agent-diagnostic', 'session-owner', current.reviewVersion, rated.logId),
  ]) {
    expect(outcome.status).toBe('blocked');
    if (outcome.status === 'blocked') {
      expect(outcome.reason).toBe('diagnostic_card');
      expect(outcome.current.reviewVersion).toBe(1n);
    }
  }
  expect(undoFingerprint(db, stateId, rated.logId)).toEqual(before);
});

it('due_and_enqueue_serialize_complete_template_metadata_with_legacy_defaults', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-meta', 'task-meta', 'card-meta');
  db.run(`UPDATE anki_cards SET
      text = 'Prompt {{c1::answer::hint}}',
      tags_json = '["tag-a"]',
      template_id = 'design-redaction',
      extra_fields_json = '{"source":"book"}',
      images_json = '["image.png"]',
      is_error_card = 0,
      error_content = NULL
    WHERE id = 'card-meta'`, []);
  const enqueued = service.enqueueCards(['card-meta']).reviewCards[0]!;
  expect(enqueued.text).toBe('Prompt {{c1::answer::hint}}');
  expect(enqueued.templateId).toBe('design-redaction');
  expect(enqueued.extraFields.source).toBe('book');
  expect(enqueued.images).toEqual(['image.png']);
  expect(enqueued.isErrorCard).toBe(false);
  expect(enqueued.errorContent).toBeUndefined();
  const due = service.getDue(null);
  expect(due).toHaveLength(1);
  const dueJson = JSON.parse(JSON.stringify(due[0])) as Record<string, unknown>;
  expect(dueJson.templateId).toBe('design-redaction');
  expect((dueJson.extraFields as Record<string, unknown>).source).toBe('book');
  expect(dueJson.images).toEqual(['image.png']);
  expect(dueJson.isErrorCard).toBe(false);
  expect('errorContent' in dueJson).toBe(false);
  expect('template_id' in dueJson).toBe(false);
  const enqueueJson = JSON.parse(JSON.stringify(enqueued)) as Record<string, unknown>;
  expect(enqueueJson.templateId).toBe('design-redaction');
  expect((enqueueJson.extraFields as Record<string, unknown>).source).toBe('book');
  expect(enqueueJson.isErrorCard).toBe(false);
});

// ---------------------------------------------------------------- library scope

it('library_scope_handles_null_and_foreign_sources_while_session_scope_rejects_them', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-library-null', 'task-library-null', 'card-library-null');
  insertTaskAndCard(db, 'doc-library-foreign', 'task-library-foreign', 'card-library-foreign');
  setTaskOwner(db, 'task-library-foreign', 'session-foreign');
  const versions = new Map(db.all<{ id: string; updated_at: string }>(
    `SELECT id, updated_at FROM anki_cards WHERE id IN ('card-library-null', 'card-library-foreign')`,
  ).map(row => [row.id, row.updated_at]));
  const cards: FsrsLibraryEnqueueCard[] = ['card-library-null', 'card-library-foreign'].map(cardId => ({
    cardId, expectedContentVersion: versions.get(cardId)!,
  }));
  const outcome = service.enqueueCardsForLibrary('agent', cards);
  expect(outcome.status).toBe('enqueued');
  if (outcome.status === 'enqueued') expect(outcome.result.enqueued).toBe(2);
  const snapshots = service.getReviewStatesForLibrary('agent', ['card-library-null', 'card-library-foreign']);
  expect(snapshots).toHaveLength(2);
  for (const cardId of ['card-library-null', 'card-library-foreign']) {
    expect(appErrorValue(() => service.getReviewStatesForSession([cardId], 'session-owner')).error_type).toBe('NotFound');
  }
  const suspended = expectAgentUpdated(
    service.setSuspendedForLibrary('agent', 'card-library-foreign', 0, true), true,
  );
  expect(suspended.suspended).toBe(true);
  expect(suspended.reviewVersion).toBe(1n);
  expect(service.setSuspendedForLibrary('agent', 'card-library-foreign', 0, false).status).toBe('conflict');
  const owners = db.get<{ nullOwner: string | null; foreignOwner: string | null }>(`SELECT
      (SELECT source_session_id FROM document_tasks WHERE id = 'task-library-null') AS nullOwner,
      (SELECT source_session_id FROM document_tasks WHERE id = 'task-library-foreign') AS foreignOwner`);
  expect(owners!.nullOwner).toBeNull();
  expect(owners!.foreignOwner).toBe('session-foreign');
});

it('library_enqueue_content_cas_is_all_or_nothing', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-library-batch-a', 'task-library-batch-a', 'card-library-batch-a');
  insertTaskAndCard(db, 'doc-library-batch-b', 'task-library-batch-b', 'card-library-batch-b');
  const currentA = db.pluck<string>(`SELECT updated_at FROM anki_cards WHERE id = 'card-library-batch-a'`)!;
  const outcome = service.enqueueCardsForLibrary('agent', [
    { cardId: 'card-library-batch-a', expectedContentVersion: currentA },
    { cardId: 'card-library-batch-b', expectedContentVersion: 'stale-version' },
  ]);
  expect(outcome.status).toBe('conflict');
  if (outcome.status === 'conflict') {
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]!.cardId).toBe('card-library-batch-b');
    expect(outcome.conflicts[0]!.expectedVersion).toBe('stale-version');
  }
  expect(Number(db.pluck(`SELECT COUNT(*) FROM fsrs_card_states
    WHERE anki_card_id IN ('card-library-batch-a', 'card-library-batch-b')`))).toBe(0);
});

it('library_undo_requires_both_current_review_version_and_latest_log', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-library-undo', 'task-library-undo', 'card-library-undo');
  const contentVersion = db.pluck<string>(`SELECT updated_at FROM anki_cards WHERE id = 'card-library-undo'`)!;
  const outcome = service.enqueueCardsForLibrary('agent', [
    { cardId: 'card-library-undo', expectedContentVersion: contentVersion },
  ]);
  expect(outcome.status).toBe('enqueued');
  if (outcome.status !== 'enqueued') throw new Error('unreachable');
  const stateId = outcome.result.states[0]!.id;
  const first = service.rate(stateId, 3, 100, null);
  const second = service.rate(stateId, 2, 100, null);
  const current = service.getReviewStatesForLibrary('agent', ['card-library-undo'])[0]!;
  expect(current.reviewVersion).toBe(2n);
  expect(current.latestReview!.logId).toBe(second.logId);
  expect(service.undoLastReviewForLibrary('agent', 'card-library-undo', 1, second.logId).status).toBe('conflict');
  expect(service.undoLastReviewForLibrary('agent', 'card-library-undo', 2, first.logId).status).toBe('conflict');
  const restored = expectAgentUpdated(
    service.undoLastReviewForLibrary('agent', 'card-library-undo', 2, second.logId), true,
  );
  expect(restored.reviewVersion).toBe(3n);
  expect(restored.lastReviewMs).toBe(first.cardState.lastReviewMs);
});

// ---------------------------------------------------------------- scheduler config / recompute

it('scheduler_config_validates_and_round_trips_scheduling_fields', () => {
  const { service } = setup();
  const defaults = service.getSchedulerConfig();
  expect(defaults.learningSteps).toEqual([1, 10]);
  expect(defaults.relearningSteps).toEqual([10]);
  expect(defaults.dayRolloverHour).toBe(4);
  expect(defaults.enableFuzz).toBe(true);
  expect(defaults.fsrsParams).toEqual([]);
  const updated = service.updateSchedulerConfig({
    learningSteps: [1, 10, 60], relearningSteps: [], maximumInterval: 365,
    dayRolloverHour: 0, enableFuzz: false,
  });
  expect(updated.learningSteps).toEqual([1, 10, 60]);
  expect(updated.relearningSteps).toEqual([]);
  expect(updated.maximumInterval).toBe(365);
  expect(updated.dayRolloverHour).toBe(0);
  expect(updated.enableFuzz).toBe(false);
  expect(service.getSchedulerConfig()).toEqual(updated);
  for (const invalid of [
    { learningSteps: [0] },
    { maximumInterval: 0 },
    { dayRolloverHour: 24 },
    { fsrsParams: [1, 2] },
  ]) {
    expect(() => service.updateSchedulerConfig(invalid)).toThrow();
  }
  expect(service.getSchedulerConfig()).toEqual(updated);
});

it('rate_follows_configured_learning_steps_and_undo_restores_step', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-steps', 'task-steps', 'card-steps');
  const hour = new Date().getHours();
  service.updateSchedulerConfig({ learningSteps: [2, 20, 60], dayRolloverHour: (hour + 12) % 24 });
  const stateId = service.enqueueCards(['card-steps']).states[0]!.id;
  const near = (dueMs: number, minutes: number): boolean =>
    Math.abs(dueMs - (Date.now() + minutes * 60_000)) < 5_000;
  const first = service.rate(stateId, 3, null, null);
  expect(first.cardState.state).toBe(1);
  expect(first.cardState.learningStep).toBe(1);
  expect(near(first.dueMs, 20)).toBe(true);
  const second = service.rate(stateId, 3, null, null);
  expect(second.cardState.learningStep).toBe(2);
  expect(near(second.dueMs, 60)).toBe(true);
  const again = service.rate(stateId, 1, null, null);
  expect(again.cardState.state).toBe(1);
  expect(again.cardState.learningStep).toBe(0);
  expect(near(again.dueMs, 2)).toBe(true);
  const undone = service.undoLastReview(again.logId, stateId);
  expect(undone.state.learningStep).toBe(2);
  expect(undone.state.dueMs).toBe(second.dueMs);
  const third = service.rate(stateId, 3, null, null);
  expect(third.cardState.state).toBe(2);
  expect(third.cardState.learningStep).toBe(0);
  expect(third.scheduledDays).toBeGreaterThanOrEqual(1);
});

it('changing_parameters_recomputes_memory_states_without_moving_due', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-recompute', 'task-recompute', 'card-recompute');
  const stateId = service.enqueueCards(['card-recompute']).states[0]!.id;
  insertReviewLog(db, stateId, 'card-recompute', 3, 0, localNoonMs(0));
  insertReviewLog(db, stateId, 'card-recompute', 3, 2, localNoonMs(2));
  insertReviewLog(db, stateId, 'card-recompute', 3, 2, localNoonMs(7));
  const due = localNoonMs(20);
  seedReviewState(db, stateId, localNoonMs(7), due);
  service.updateSchedulerConfig({ fsrsParams: [...DEFAULT_PARAMETERS] });
  const expected = new Fsrs6().memoryState(
    [{ rating: 3, deltaT: 0 }, { rating: 3, deltaT: 2 }, { rating: 3, deltaT: 5 }],
    null,
  );
  const [stability, difficulty, dueAfter] = loadMemory(db, stateId);
  expect(Math.abs(stability - expected.stability)).toBeLessThan(1e-4);
  expect(Math.abs(difficulty - expected.difficulty)).toBeLessThan(1e-4);
  expect(dueAfter).toBe(due);
});

it('memory_state_upgrade_runs_once_per_scheduler_version', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-upgrade', 'task-upgrade', 'card-upgrade');
  const stateId = service.enqueueCards(['card-upgrade']).states[0]!.id;
  insertReviewLog(db, stateId, 'card-upgrade', 3, 0, localNoonMs(0));
  insertReviewLog(db, stateId, 'card-upgrade', 3, 2, localNoonMs(3));
  seedReviewState(db, stateId, localNoonMs(3), localNoonMs(10));
  expect(service.ensureMemoryStatesCurrent()).toBe(1);
  const [stability] = loadMemory(db, stateId);
  expect(stability).toBeLessThan(99);
  seedReviewState(db, stateId, localNoonMs(3), localNoonMs(10));
  expect(service.ensureMemoryStatesCurrent()).toBe(0);
  expect(loadMemory(db, stateId)[0]).toBe(99);
});

it('optimizer_reports_not_enough_data_for_a_tiny_history', async () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-tiny', 'task-tiny', 'card-tiny');
  const stateId = service.enqueueCards(['card-tiny']).states[0]!.id;
  insertReviewLog(db, stateId, 'card-tiny', 3, 0, localNoonMs(0));
  insertReviewLog(db, stateId, 'card-tiny', 3, 2, localNoonMs(2));
  // Rust returns before touching fsrs-rs when items < MIN_TRAINING_ITEMS; any engine call fails the test.
  const untouched = (): never => { throw new Error('not_enough_data must not reach the fsrs trainer'); };
  const result = await service.optimizeParameters({ optimize: untouched, evaluate: untouched });
  expect(result.status).toBe('not_enough_data');
  expect(result.itemCount).toBe(1);
  expect(service.getSchedulerConfig().fsrsParams).toEqual([]);
});

it('review_statistics_report_true_retention_periods_distributions_and_study_time', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-ret', 'task-ret', 'card-ret-a');
  insertCardForTask(db, 'doc-ret', 'task-ret', 'card-ret-b');
  const states = service.enqueueCards(['card-ret-a', 'card-ret-b']).states;
  const a = states[0]!;
  const b = states[1]!;
  const now = Date.now();
  const [dayStart] = logicalDayBoundsMs(now, 4);
  const insert = (state: FsrsCardState, rating: number, reviewMs: number, stabilityBefore: number): void => {
    db.run(`INSERT INTO fsrs_review_logs (
        id, card_state_id, anki_card_id, rating, state_before, state_after,
        stability_before, review_ms, duration_ms, fsrs_params_version,
        created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 2, 2, ?5, ?6, 4000, ?7, 't', 't')`, [
      crypto.randomUUID(), state.id, state.ankiCardId, rating, stabilityBefore, reviewMs, FSRS_PARAMS_VERSION,
    ]);
  };
  insert(a, 3, dayStart + 60_000, 5);
  insert(a, 1, dayStart + 120_000, 5);
  insert(b, 1, dayStart + 60_000, 30);
  insert(a, 3, dayStart - MS_PER_DAY + 60_000, 4);
  insert(b, 4, dayStart - 10 * MS_PER_DAY + 60_000, 25);
  db.run(`UPDATE fsrs_card_states SET state = 2, stability = 2.5, difficulty = 4.2,
      last_review_ms = ?1 WHERE id = ?2`, [now, a.id]);
  db.run(`UPDATE fsrs_card_states SET state = 2, stability = 40.0, difficulty = 8.7,
      last_review_ms = ?1 WHERE id = ?2`, [now - 80 * MS_PER_DAY, b.id]);
  const stats = service.getReviewStatistics(30);
  const row = (period: string) => stats.trueRetention.find(item => item.period === period)!;
  const today = row('today');
  expect([today.youngReviews, today.youngPassed]).toEqual([1, 1]);
  expect([today.matureReviews, today.maturePassed]).toEqual([1, 0]);
  const yesterday = row('yesterday');
  expect([yesterday.youngReviews, yesterday.youngPassed]).toEqual([1, 1]);
  expect(yesterday.matureReviews).toBe(0);
  const month = row('month');
  expect([month.youngReviews, month.matureReviews]).toEqual([2, 2]);
  expect([month.youngPassed, month.maturePassed]).toEqual([2, 1]);
  const todayKey = logicalDayKey(now, 4);
  const todayStat = stats.dailyReviews.find(day => day.date === todayKey)!;
  expect(todayStat.studyMs).toBe(12_000);
  const dist = stats.memoryDistributions;
  expect(dist.cards).toBe(2);
  expect(dist.difficulty[3]).toBe(1);
  expect(dist.difficulty[7]).toBe(1);
  expect(dist.stability[1]).toBe(1);
  expect(dist.stability[5]).toBe(1);
  expect(dist.retrievability[9]).toBe(1);
  expect(dist.retrievability.reduce((sum, value) => sum + value, 0)).toBe(2);
});

// ---------------------------------------------------------------- burying / ordering

it('rating_buries_new_and_review_siblings_of_the_same_note', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-sib', 'task-sib', 'card-sib-a');
  insertCardForTask(db, 'doc-sib', 'task-sib', 'card-sib-b');
  insertCardForTask(db, 'doc-sib', 'task-sib', 'card-sib-c');
  insertCardForTask(db, 'doc-sib', 'task-sib', 'card-other');
  const setNoteKey = (cardId: string, noteId: string): void => {
    db.run('UPDATE anki_cards SET extra_fields_json = ?1 WHERE id = ?2', [JSON.stringify({ AnkiNoteId: noteId }), cardId]);
  };
  for (const card of ['card-sib-a', 'card-sib-b', 'card-sib-c']) setNoteKey(card, '42');
  setNoteKey('card-other', '43');
  const states = service.enqueueCards(['card-sib-a', 'card-sib-b', 'card-sib-c', 'card-other']).states;
  const now = Date.now();
  db.run(`UPDATE fsrs_card_states SET state = 2, stability = 5.0, difficulty = 5.0,
      reps = 3, due_ms = ?1, last_review_ms = ?2 WHERE id = ?3`,
  [now - 1000, now - 5 * MS_PER_DAY, stateOf(states, 'card-sib-c')]);
  const rated = service.rate(stateOf(states, 'card-sib-a'), 3, null, null);
  const buried = [...rated.buriedSiblings].sort();
  const expected = [stateOf(states, 'card-sib-b'), stateOf(states, 'card-sib-c')].sort();
  expect(buried).toEqual(expected);
  const due = dueStateIds(service);
  expect(due).not.toContain(stateOf(states, 'card-sib-b'));
  expect(due).not.toContain(stateOf(states, 'card-sib-c'));
  expect(due).toContain(stateOf(states, 'card-other'));
  expect(service.getStats().buried).toBe(2);
});

it('sibling_burying_can_be_disabled', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-nosib', 'task-nosib', 'card-nosib-a');
  insertCardForTask(db, 'doc-nosib', 'task-nosib', 'card-nosib-b');
  for (const card of ['card-nosib-a', 'card-nosib-b']) {
    db.run('UPDATE anki_cards SET extra_fields_json = ?1 WHERE id = ?2', [JSON.stringify({ AnkiNoteId: '7' }), card]);
  }
  service.updateSchedulerConfig({ buryNewSiblings: false, buryReviewSiblings: false });
  const states = service.enqueueCards(['card-nosib-a', 'card-nosib-b']).states;
  const rated = service.rate(states[0]!.id, 3, null, null);
  expect(rated.buriedSiblings).toEqual([]);
  expect(dueStateIds(service)).toContain(states[1]!.id);
});

it('manual_bury_hides_a_card_until_the_next_logical_day', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-bury', 'task-bury', 'card-bury');
  const stateId = service.enqueueCards(['card-bury']).states[0]!.id;
  const buried = service.setBuried(stateId, true);
  expect(buried.changed).toBe(true);
  const [, nextDayStart] = logicalDayBoundsMs(Date.now(), service.getSchedulerConfig().dayRolloverHour);
  expect(buried.state.buriedUntilMs).toBe(nextDayStart);
  expect(dueStateIds(service)).not.toContain(stateId);
  expect(service.setBuried(stateId, true).changed).toBe(false);
  const restored = service.setBuried(stateId, false);
  expect(restored.changed).toBe(true);
  expect(restored.state.buriedUntilMs).toBeNull();
  expect(dueStateIds(service)).toContain(stateId);
});

it('review_order_and_new_review_mix_follow_configuration', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-order', 'task-order', 'card-r0');
  const ids = ['card-r0'];
  for (const name of ['card-r1', 'card-r2', 'card-r3', 'card-n0', 'card-n1']) {
    insertCardForTask(db, 'doc-order', 'task-order', name);
    ids.push(name);
  }
  const states = service.enqueueCards(ids).states;
  const now = Date.now();
  const reviews: Array<[string, number, number, number]> = [
    ['card-r0', 2, 4, 4], ['card-r1', 40, 40, 3], ['card-r2', 1, 5, 2], ['card-r3', 10, 15, 1],
  ];
  for (const [card, stability, elapsed, early] of reviews) {
    db.run(`UPDATE fsrs_card_states SET state = 2, stability = ?1, difficulty = 5.0,
        reps = 3, due_ms = ?2, last_review_ms = ?3 WHERE id = ?4`,
    [stability, now - early * 60_000, now - elapsed * MS_PER_DAY, stateOf(states, card)]);
  }
  const order = (): string[] => dueStateIds(service).map(id => states.find(state => state.id === id)!.ankiCardId);
  expect(order()).toEqual(['card-r0', 'card-r1', 'card-r2', 'card-r3', 'card-n0', 'card-n1']);
  service.updateSchedulerConfig({ reviewOrder: 'retrievability', newReviewOrder: 'before' });
  expect(order()).toEqual(['card-n0', 'card-n1', 'card-r2', 'card-r0', 'card-r3', 'card-r1']);
  service.updateSchedulerConfig({ reviewOrder: 'due', newReviewOrder: 'mix' });
  expect(order()).toEqual(['card-r0', 'card-r1', 'card-n0', 'card-r2', 'card-r3', 'card-n1']);
  for (const invalid of [
    { reviewOrder: 'oldest' }, { newReviewOrder: 'never' }, { newReviewOrder: 'sometimes' }, { maxAnswerSeconds: 0 },
  ]) {
    expect(() => service.updateSchedulerConfig(invalid)).toThrow();
  }
});

// fsrs_review_service.rs:3311,3352 get_stats：两条统计查询 map_err(|e| AppError::database(e.to_string()))，不加前缀（V05-04）；
// load_daily_counters 自带「读取每日复习计数失败: 」前缀，保持不变。
it('get_stats_query_failures_report_the_bare_database_text', () => {
  const { db, service } = setup();
  db.run('ALTER TABLE fsrs_review_logs RENAME COLUMN card_state_id TO card_state_id_renamed');
  expect(appErrorValue(() => service.getStats())).toEqual({
    error_type: 'Database', message: 'no such column: l.card_state_id', details: null,
  });
  db.run('ALTER TABLE anki_cards RENAME COLUMN is_error_card TO is_error_card_renamed');
  expect(appErrorValue(() => service.getStats())).toEqual({
    error_type: 'Database', message: 'no such column: a.is_error_card', details: null,
  });
  db.run('ALTER TABLE fsrs_review_logs RENAME COLUMN state_before TO state_before_renamed');
  expect(appErrorValue(() => service.getStats()).message).toBe('读取每日复习计数失败: no such column: state_before');
});
