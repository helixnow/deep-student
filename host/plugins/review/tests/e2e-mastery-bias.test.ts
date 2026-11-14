import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import review from '../index.ts';
import { FsrsReviewService, scheduleReviewOutcome } from '../src/review.ts';
import { MS_PER_DAY, type FsrsSchedulerConfigUpdate } from '../src/fsrs-types.ts';
import {
  applyMasteryDueBias, masteryDueBiasDeltaMs, MAX_ADVANCE_MS,
} from '../src/bias.ts';
import { WEAK_SCORE_THRESHOLD, MIN_TOTAL_FOR_WEAK } from '../repository/mastery.ts';
import type { MasteryWeakPointEvidence } from '../api.ts';
import { mistakesFixture } from './storage.ts';

const RECOVER_SCORE_THRESHOLD = 0.75;
const MS_PER_MINUTE = 60_000;

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function installMasterySchema(conn: SqlExecutor): void {
  for (const name of [
    'V20260130__init.sql',
    'V20260131__add_change_log.sql',
    'V20260718__add_mastery_tables.sql',
    'V20260719__mastery_events_signal.sql',
    'V20260720__mastery_events_sync.sql',
    'V20260909__mastery_events_insight_source.sql',
  ]) {
    conn.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  }
}

async function setup(sink?: {
  upsertWeakPointFromMastery(conn: SqlExecutor, concept: string, evidence: MasteryWeakPointEvidence): void;
  removeWeakPointFromMastery(conn: SqlExecutor, concept: string): void;
}) {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  installMasterySchema(fixture.storage.database('vfs'));
  const host = await createTestHost({
    plugins: [review],
    provide: {
      storage: fixture.storage,
      ...(sink ? { masteryProfileSink: sink } : {}),
    },
  });
  hosts.push(host);
  return {
    ...fixture,
    host,
    mastery: host.ctx.mastery,
    vfs: fixture.storage.database('vfs'),
    service: new FsrsReviewService(fixture.db),
  };
}

type Db = ReturnType<typeof mistakesFixture>['db'];

function insertTaskAndCard(db: Db, documentId: string, taskId: string, cardId: string, concept?: string): void {
  db.run(`INSERT INTO document_tasks (
    id, document_id, original_document_name, segment_index,
    content_segment, status, anki_generation_options_json
  ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}')`, [taskId, documentId]);
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id, tags_json
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5, ?6)`,
  [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId,
    concept === undefined ? '[]' : JSON.stringify([concept])]);
}

function insertCardForTask(db: Db, documentId: string, taskId: string, cardId: string, concept: string): void {
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id, tags_json
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5, ?6)`,
  [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId, JSON.stringify([concept])]);
}

function disableFuzz(service: FsrsReviewService): void {
  const update: FsrsSchedulerConfigUpdate = { enableFuzz: false };
  service.updateSchedulerConfig(update);
}

function seedReviewState(
  db: Db, cardId: string, stability: number, scheduledDays: number,
): string {
  const service = new FsrsReviewService(db);
  const enqueued = service.enqueueCards([cardId]);
  const stateId = enqueued.states[0]!.id;
  const seedNow = Date.now();
  db.run(`UPDATE fsrs_card_states SET
      state = 2, stability = ?1, difficulty = 5.0,
      scheduled_days = ?2, reps = 5, lapses = 0,
      due_ms = ?3, last_review_ms = ?4, suspended = 0
    WHERE id = ?5`, [stability, scheduledDays, seedNow, seedNow - scheduledDays * MS_PER_DAY, stateId]);
  return stateId;
}

/** Rust 用 `set_now_override_ms` 制造 90 秒间隔；TS 没有时钟注入，改写既有事件的
 *  时间戳到 60 秒之前，达到同样的 anti-farm 前置条件（并保持事件顺序）。 */
function ageMasteryEvents(db: SqlExecutor, concept: string): void {  const rows = db.all<{ id: string }>(`SELECT id FROM mastery_events
    WHERE concept_key = ?1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, [concept]);
  rows.forEach((row, index) => {
    const stamp = `2000-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+00:00`;
    db.run('UPDATE mastery_events SET created_at = ?1 WHERE id = ?2', [stamp, row.id]);
  });
}

it('e2e_vfs_mastery_score_biases_due_and_respects_three_day_cap', async () => {
  const { db, mastery, service } = await setup();
  const concept = 'fsrs_闭环偏置';
  for (let i = 0; i < 3; i++) mastery.recordQbankAnswer(`q_fsrs_e2e_${i}`, [concept], false);
  const score = mastery.getState(concept)!.score;
  expect(score).toBeLessThan(0.5);

  insertTaskAndCard(db, 'doc-c5', 'task-c5', 'card-c5-a', concept);
  insertCardForTask(db, 'doc-c5', 'task-c5', 'card-c5-b', concept);
  insertCardForTask(db, 'doc-c5', 'task-c5', 'card-c5-cap', concept);
  disableFuzz(service);
  const sidBase = seedReviewState(db, 'card-c5-a', 10, 10);
  const sidBias = seedReviewState(db, 'card-c5-b', 10, 10);
  const sidCap = seedReviewState(db, 'card-c5-cap', 200, 100);

  const baseline = service.rateWithMasteryBias(sidBase, 3, 10, null, null);
  const biased = service.rateWithMasteryBias(sidBias, 3, 10, score, null);
  const nowMs = Date.now();
  const interval = baseline.dueMs - nowMs;
  const expectedDelta = masteryDueBiasDeltaMs(score, interval);
  const advance = baseline.dueMs - biased.dueMs;
  expect(advance).toBeGreaterThan(60_000);
  expect(Math.abs(advance - Math.abs(expectedDelta))).toBeLessThan(30_000);

  const beforeCap = service.getCardState(sidCap)!;
  const rateNow = Date.now();
  const fsrsCap = scheduleReviewOutcome(beforeCap, 3, rateNow, service.getSchedulerConfig());
  const capped = service.rateWithMasteryBias(sidCap, 3, 10, 0.0, null);
  const capAdvance = fsrsCap.dueMs - capped.dueMs;
  expect(capAdvance).toBeGreaterThan(0);
  expect(capAdvance).toBeLessThanOrEqual(MAX_ADVANCE_MS + 5_000);
  expect(masteryDueBiasDeltaMs(0.0, 100 * MS_PER_DAY)).toBe(-MAX_ADVANCE_MS);

  mastery.recordEvent('qbank', concept, 'extra', 'wrong');
  const ultraLow = mastery.getState(concept)!.score;
  const syntheticNow = rateNow;
  const formulaDue = applyMasteryDueBias(ultraLow, syntheticNow, syntheticNow + 100 * MS_PER_DAY);
  const formulaAdvance = (syntheticNow + 100 * MS_PER_DAY) - formulaDue;
  expect(formulaAdvance).toBeGreaterThan(0);
  expect(formulaAdvance).toBeLessThanOrEqual(MAX_ADVANCE_MS);
});

it('e2e_submit_wrong_thrice_lowers_score_and_upserts_weak_point_then_recovers', async () => {
  const profile = new Map<string, { source: string; errorPattern: string; score: number }>();
  const upserts: MasteryWeakPointEvidence[] = [];
  const removes: string[] = [];
  const { db, vfs, mastery, service } = await setup({
    upsertWeakPointFromMastery(_conn, concept, evidence) {
      upserts.push(evidence);
      profile.set(concept, {
        source: 'mastery', errorPattern: evidence.recentWrongSummary, score: evidence.score,
      });
    },
    removeWeakPointFromMastery(_conn, concept) {
      removes.push(concept);
      if (profile.get(concept)?.source === 'mastery') profile.delete(concept);
    },
  });
  const concept = '二次函数';
  const questionId = 'q_e2e';
  insertTaskAndCard(db, 'doc_e2e', 'task_e2e', 'card_e2e_lo', concept);
  insertCardForTask(db, 'doc_e2e', 'task_e2e', 'card_e2e_hi', concept);
  const stateLo = seedReviewState(db, 'card_e2e_lo', 10, 10);
  const stateHi = seedReviewState(db, 'card_e2e_hi', 10, 10);
  disableFuzz(service);

  for (let i = 0; i < 3; i++) {
    const state = mastery.recordQbankAnswer(questionId, [concept], false);
    expect(state.total).toBe(i + 1);
  }

  expect(Number(vfs.pluck(`SELECT COUNT(*) FROM mastery_events
    WHERE concept_key = ?1 AND outcome = 'wrong' AND source = 'qbank'`, [concept]))).toBe(3);
  const row = vfs.get<{ score: number; total: number; wrong_count: number }>(`SELECT score, total, wrong_count
    FROM mastery_states WHERE concept_key = ?1`, [concept])!;
  expect(row.score).toBeLessThan(WEAK_SCORE_THRESHOLD);
  expect(row.total).toBeGreaterThanOrEqual(MIN_TOTAL_FOR_WEAK);
  expect(row.wrong_count).toBeGreaterThanOrEqual(3);

  const state = mastery.getState(concept)!;
  expect(Math.abs(state.score - 0.1715)).toBeLessThan(1e-9);
  expect(upserts.length).toBeGreaterThanOrEqual(1);
  const weakPoint = profile.get(concept);
  expect(weakPoint).toBeDefined();
  expect(weakPoint!.source).toBe('mastery');
  expect(weakPoint!.errorPattern.includes(concept) || weakPoint!.errorPattern.includes('wrong')).toBe(true);

  const lowScore = state.score;
  const baseline = service.rateWithMasteryBias(stateHi, 3, 10, null, null);
  const rateLo = service.rateWithMasteryBias(stateLo, 3, 10, lowScore, null);
  const nowMs = Date.now();
  const fsrsInterval = baseline.dueMs - nowMs;
  expect(fsrsInterval).toBeGreaterThanOrEqual(60 * MS_PER_MINUTE);
  const expectedDelta = masteryDueBiasDeltaMs(lowScore, fsrsInterval);
  expect(expectedDelta).toBeLessThan(0);
  expect(Math.abs(expectedDelta)).toBeLessThanOrEqual(MAX_ADVANCE_MS);
  const advance = baseline.dueMs - rateLo.dueMs;
  expect(advance).toBeGreaterThan(60_000);
  expect(advance).toBeLessThanOrEqual(MAX_ADVANCE_MS + 5_000);
  expect(Math.abs(advance - Math.abs(expectedDelta))).toBeLessThan(30_000);
  expect(Number(db.pluck('SELECT due_ms FROM fsrs_card_states WHERE id = ?1', [stateLo])))
    .toBe(rateLo.dueMs);

  for (let i = 0; i < 8; i++) {
    ageMasteryEvents(vfs, concept);
    const corrected = mastery.recordQbankAnswer(questionId, [concept], true);
    expect(corrected.total).toBe(4 + i);
  }

  const after = mastery.getState(concept)!;
  expect(after.score).toBeGreaterThan(RECOVER_SCORE_THRESHOLD);
  expect(removes).toContain(concept);
  expect(profile.has(concept)).toBe(false);

  const syntheticNow = 1_700_000_000_000;
  const syntheticFsrsDue = syntheticNow + 10 * MS_PER_DAY;
  const recoveredDue = applyMasteryDueBias(after.score, syntheticNow, syntheticFsrsDue);
  expect(recoveredDue).toBeGreaterThanOrEqual(syntheticFsrsDue);
});
