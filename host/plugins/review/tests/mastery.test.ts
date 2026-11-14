import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import review from '../index.ts';
import { applyMasteryDueBias, masteryDueBiasDeltaMs, MAX_ADVANCE_MS } from '../src/bias.ts';
import { storageFixture } from './storage.ts';

const fixtures: ReturnType<typeof storageFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
async function setup() {
  const f = storageFixture(); fixtures.push(f);
  f.db.exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  for (const name of ['V20260718__add_mastery_tables.sql', 'V20260719__mastery_events_signal.sql', 'V20260720__mastery_events_sync.sql', 'V20260909__mastery_events_insight_source.sql']) f.db.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  const host = await createTestHost({ plugins: [review], provide: { storage: f.storage } }); hosts.push(host);
  return { ...f, svc: host.ctx.mastery, host };
}
afterEach(async () => { vi.useRealTimers(); for (const h of hosts.splice(0)) await h.dispose(); for (const f of fixtures.splice(0)) f.dispose(); });
const time = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(ms); };
it('anti_farm_same_item_rapid_corrects_gain_less_than_independent', async () => {
  const { db, svc } = await setup(); const base = Date.now();
  for (let i = 0; i < 5; i++) { time(base + i * 1000); svc.recordEvent('qbank', '牛顿定律_ind', `id${i}`, 'correct'); }
  const gainIndependent = svc.getState('牛顿定律_ind')!.score - 0.5;
  for (let i = 0; i < 5; i++) { time(base + 1000000 + i * 5000); svc.recordEvent('qbank', '牛顿定律_farm', 'farm-q', 'correct'); }
  const gainFarm = svc.getState('牛顿定律_farm')!.score - 0.5;
  expect(gainFarm).toBeLessThan(gainIndependent * 0.55);
  const weights = svc.listEvents('牛顿定律_farm', 10).map(e => e.weight);
  expect(weights.some(w => w < 0.3)).toBe(true);
  expect(weights.some(w => Math.abs(w - 1) < 1e-9)).toBe(true);
  const min = db.pluck<number>('SELECT MIN(weight) FROM mastery_events WHERE concept_key = ?1', ['牛顿定律_farm'])!;
  expect(min <= 0.05 + 1e-9 || min < 0.3).toBe(true);
});
it('remote_tombstones_rebuild_zero_state_and_remove_weak_point', async () => {
  const f = storageFixture(); fixtures.push(f);
  f.db.exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  for (const name of ['V20260718__add_mastery_tables.sql', 'V20260719__mastery_events_signal.sql', 'V20260720__mastery_events_sync.sql', 'V20260909__mastery_events_insight_source.sql']) f.db.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  const upserts: string[] = [], removals: string[] = [];
  const host = await createTestHost({ plugins: [review], provide: { storage: f.storage, masteryProfileSink: {
    upsertWeakPointFromMastery: (_db: unknown, concept: string) => { upserts.push(concept); },
    removeWeakPointFromMastery: (_db: unknown, concept: string) => { removals.push(concept); },
  } } });
  hosts.push(host);
  const svc = host.ctx.mastery, concept = 'remote-tombstone-concept';
  for (let i = 0; i < 3; i++) svc.recordQbankAnswer(`remote-question-${i}`, [concept], false);
  expect(upserts).toContain(concept);
  f.db.run(`UPDATE mastery_events SET deleted_at = '2026-07-19T00:00:00Z', updated_at = '2026-07-19T00:00:00Z' WHERE concept_key = ?1`, [concept]);
  f.db.transaction(tx => svc.recomputeAllStatesWithConn(tx), { behavior: 'immediate' });
  svc.syncAllLearnerProfiles();
  expect(svc.getState(concept)).toMatchObject({ total: 0, wrongCount: 0 });
  expect(removals).toContain(concept);
});
it('fsrs_rating_signals_are_differentiated', async () => {
  const { db, svc } = await setup(); const t0 = Date.now();
  [1, 2, 3, 4].forEach((rating, i) => { time(t0 + (i + 1) * 120000); expect(svc.recordFsrsRating(`card_sig_${rating}`, ['微积分'], rating)).not.toBeNull(); });
  const signals = db.all<{ signal: number }>("SELECT signal FROM mastery_events WHERE concept_key = '微积分' AND outcome = 'rating' ORDER BY signal ASC").map(r => r.signal);
  expect(signals).toHaveLength(4);
  [0, 0.3, 0.8, 1].forEach((s, i) => expect(Math.abs(signals[i]! - s)).toBeLessThan(1e-9));
  const scores = [2, 3, 4].map((rating, i) => { time(t0 + 1000000); return svc.recordFsrsRating(`c_${i}`, [`sig_${i}`], rating)!.score; });
  expect(scores[0]!).toBeLessThan(scores[1]!); expect(scores[1]!).toBeLessThan(scores[2]!);
});
it('fsrs_review_log_compensation_is_idempotent', async () => {
  const { db, svc } = await setup();
  for (let i = 0; i < 2; i++) svc.recordFsrsRatingForLog('log_exactly_once', 'card_once', ['概率论'], 3);
  expect(db.pluck("SELECT COUNT(*) FROM mastery_events WHERE id = 'me_fsrs_log_exactly_once'")).toBe(1);
  expect(db.pluck("SELECT total FROM mastery_states WHERE concept_key = '概率论'")).toBe(1);
  expect(svc.revertFsrsRatingForLog('log_exactly_once')!.total).toBe(0);
  expect(db.pluck("SELECT deleted_at FROM mastery_events WHERE id = 'me_fsrs_log_exactly_once'")).not.toBeNull();
});
it('qbank_verdict_correction_false_to_true_recomputes_state', async () => {
  const { db, svc } = await setup(); const t0 = Date.now(); time(t0);
  db.transaction(tx => svc.recordQbankAnswerWithConn(tx, 'sub_corr_1', 'q_corr_1', ['换判概念'], false), { behavior: 'immediate' });
  time(t0 + 30000);
  const locked = db.transaction(tx => svc.recordQbankAnswerWithConn(tx, 'sub_corr_1', 'q_corr_1', ['换判概念'], true), { behavior: 'immediate' });
  expect(locked.wrongCount).toBe(1); expect(Math.abs(locked.score - 0.35)).toBeLessThan(1e-9);
  time(t0 + 60000);
  const corrected = svc.recordQbankVerdictCorrection('sub_corr_1', 'q_corr_1', ['换判概念'], true);
  expect(Math.abs(corrected.score - 0.65)).toBeLessThan(1e-9);
  expect(corrected).toMatchObject({ total: 1, wrongCount: 0, streak: 1 });
  const old = db.one<{ deleted_at: string | null; outcome: string }>("SELECT deleted_at, outcome FROM mastery_events WHERE id = 'me_qbank_sub_corr_1'");
  expect(old.deleted_at).not.toBeNull(); expect(old.outcome).toBe('wrong');
  const rev = db.one<{ outcome: string; weight: number; deleted_at: string | null }>("SELECT outcome, weight, deleted_at FROM mastery_events WHERE id = 'me_qbank_sub_corr_1_r1'");
  expect(rev.outcome).toBe('correct'); expect(Math.abs(rev.weight - 1)).toBeLessThan(1e-9); expect(rev.deleted_at).toBeNull();
});
it('qbank_verdict_correction_is_idempotent_and_supports_reflip', async () => {
  const { db, svc } = await setup(); const t0 = Date.now();
  const count = () => db.pluck("SELECT COUNT(*) FROM mastery_events WHERE id = 'me_qbank_sub_corr_2' OR substr(id, 1, length('me_qbank_sub_corr_2_r')) = 'me_qbank_sub_corr_2_r'");
  time(t0); expect(svc.recordQbankVerdictCorrection('sub_corr_2', 'q_corr_2', ['换判幂等'], false).wrongCount).toBe(1); expect(count()).toBe(1);
  time(t0 + 30000); expect(svc.recordQbankVerdictCorrection('sub_corr_2', 'q_corr_2', ['换判幂等'], false).total).toBe(1); expect(count()).toBe(1);
  time(t0 + 60000); const flip1 = svc.recordQbankVerdictCorrection('sub_corr_2', 'q_corr_2', ['换判幂等'], true);
  expect(Math.abs(flip1.score - 0.65)).toBeLessThan(1e-9); expect(flip1.wrongCount).toBe(0);
  time(t0 + 90000); const flip2 = svc.recordQbankVerdictCorrection('sub_corr_2', 'q_corr_2', ['换判幂等'], false);
  expect(Math.abs(flip2.score - 0.35)).toBeLessThan(1e-9); expect(flip2).toMatchObject({ total: 1, wrongCount: 1 });
  expect(db.all<{ id: string }>('SELECT id FROM mastery_events WHERE concept_key = ?1 AND deleted_at IS NULL ORDER BY id', ['换判幂等']).map(r => r.id)).toEqual(['me_qbank_sub_corr_2_r2']);
  expect(count()).toBe(3);
});
it('legacy_null_signal_rating_falls_back_to_0_35', async () => {
  const { db, svc } = await setup();
  db.run("INSERT INTO mastery_events (id, created_at, source, concept_key, item_id, outcome, weight, signal) VALUES ('me_legacy', '2020-01-01T00:00:00Z', 'fsrs', 'legacy_c', 'c1', 'rating', 1.0, NULL)");
  expect(db.pluck("SELECT signal FROM mastery_events WHERE id = 'me_legacy'")).toBeNull();
  expect(Math.abs(svc.recomputeState('legacy_c').score - 0.455)).toBeLessThan(1e-9);
  expect(Math.abs(svc.getState('legacy_c')!.score - 0.455)).toBeLessThan(1e-9);
});
it('mastery_due_bias_low_high_and_cap_on_real_sqlite_scores', async () => {
  const { svc } = await setup(); const t0 = Date.now();
  for (let i = 0; i < 5; i++) { time(t0 + i * 120000); svc.recordEvent('qbank', '偏置弱', `w${i}`, 'wrong'); }
  for (let i = 0; i < 8; i++) { time(t0 + 1000000 + i * 90000); svc.recordEvent('qbank', '偏置强', `c${i}`, 'correct'); }
  const low = svc.getState('偏置弱')!, high = svc.getState('偏置强')!, now = 1700000000000, day = 86400000, due = now + 10 * day;
  expect(low.score).toBeLessThan(0.5); expect(high.score).toBeGreaterThan(0.5);
  expect(applyMasteryDueBias(low.score, now, due)).toBeLessThan(due);
  expect(applyMasteryDueBias(low.score, now, due)).toBe(due + masteryDueBiasDeltaMs(low.score, 10 * day));
  expect(applyMasteryDueBias(high.score, now, due)).toBeGreaterThanOrEqual(due);
  expect(masteryDueBiasDeltaMs(0, 100 * day)).toBe(-MAX_ADVANCE_MS);
  expect(applyMasteryDueBias(0, now, now + 100 * day)).toBe(now + 100 * day - MAX_ADVANCE_MS);
  expect(Math.abs(masteryDueBiasDeltaMs(low.score, 100 * day))).toBeLessThanOrEqual(MAX_ADVANCE_MS);
});
it('overview_includes_today_priority_review', async () => {
  const { svc, host } = await setup(); const t0 = Date.now();
  for (let i = 0; i < 3; i++) { time(t0 + i * 120000); svc.recordEvent('qbank', '优先复习概念', `p${i}`, 'wrong'); }
  const summary = svc.overviewSummary(5);
  expect(summary.weakCount).toBeGreaterThanOrEqual(1);
  expect(summary.todayPriorityReview.length).toBeGreaterThan(0);
  expect(summary.todayPriorityReview[0]).toMatchObject({ conceptKey: '优先复习概念', priority: 1 });
  await expect(host.invoke('mastery_get_overview', { limit: 5 })).resolves.toEqual(summary);
});
it('l17_insight_recall_verdict_with_conn_matches_rust_record_recall_verdict_to_mastery', async () => {
  // Rust dstu-research/src/insight/recall.rs:426-448 (consumer: L17 insight recall).
  const { db, svc } = await setup();
  const now = '2026-11-04T10:00:00.123+00:00';
  db.transaction(tx => {
    svc.recordInsightRecallVerdictWithConn(tx, 'ins-1', 'sess-1', true, now);
    svc.recordInsightRecallVerdictWithConn(tx, 'ins-1', 'sess-1', true, '2026-11-04T11:00:00+00:00');
    svc.recordInsightRecallVerdictWithConn(tx, 'ins-1', 'sess-1', false, now);
  }, { behavior: 'immediate' });
  const rows = db.all<Record<string, unknown>>(
    `SELECT id, created_at, updated_at, source, concept_key, item_id, outcome, weight, signal
     FROM mastery_events ORDER BY id`);
  expect(rows).toEqual([
    { id: 'me_insight_ins-1_sess-1_correct', created_at: now, updated_at: now, source: 'insight',
      concept_key: 'insight:ins-1', item_id: 'insight:ins-1', outcome: 'correct', weight: 1, signal: 1 },
    { id: 'me_insight_ins-1_sess-1_wrong', created_at: now, updated_at: now, source: 'insight',
      concept_key: 'insight:ins-1', item_id: 'insight:ins-1', outcome: 'wrong', weight: 1, signal: 0 },
  ]);
  // Rust does not recompute mastery_states or reflux the learner profile.
  expect(db.pluck<number>('SELECT COUNT(*) FROM mastery_states')).toBe(0);
  db.exec('DROP TABLE mastery_events');
  let caught: unknown;
  try { svc.recordInsightRecallVerdictWithConn(db, 'ins-2', 'sess-2', true, now); } catch (e) { caught = e; }
  expect((caught as { value: { error_type: string; message: string } }).value).toMatchObject({
    error_type: 'Database', message: expect.stringMatching(/^写入 mastery 证据失败: /),
  });
});
it('x6_lp_0245_profile_reflux_failures_warn_with_rust_mastery_text_and_ids', async () => {
  const f = storageFixture(); fixtures.push(f);
  f.db.exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  for (const name of ['V20260718__add_mastery_tables.sql', 'V20260719__mastery_events_signal.sql', 'V20260720__mastery_events_sync.sql', 'V20260909__mastery_events_insight_source.sql']) f.db.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  let down = false;
  const failing = () => { if (down) throw new Error('profile sink down'); };
  const host = await createTestHost({ plugins: [review], provide: { storage: f.storage, masteryProfileSink: {
    upsertWeakPointFromMastery: failing, removeWeakPointFromMastery: failing,
  } } });
  hosts.push(host);
  const warnings: unknown[][] = [];
  host.ctx.logger.exporter({
    levels: { review: 2 },
    export(message: { type: string; name: string; args: unknown[] }) {
      if (message.type === 'warn' && message.name === 'review') warnings.push(message.args);
    },
  });
  const svc = host.ctx.mastery;
  // Make the concept a weak point first so every later sync reaches the (now failing) sink.
  for (let i = 0; i < 3; i++) svc.recordQbankAnswer(`reflux-question-${i}`, ['reflux-concept'], false);
  down = true;
  expect(svc.recordFsrsRatingForLog('log-reflux', 'card-reflux', ['reflux-concept'], 1)).not.toBeNull();
  expect(svc.recordQbankVerdictCorrection('sub-reflux', 'q-reflux', ['reflux-concept'], false).total).toBeGreaterThan(0);
  expect(warnings).toEqual([
    ['[Mastery] FSRS event committed but profile reflux failed for log %s: %s', 'log-reflux', expect.stringContaining('profile sink down')],
    ['[Mastery] qbank correction committed but profile reflux failed for submission %s: %s', 'sub-reflux', expect.stringContaining('profile sink down')],
  ]);
});
