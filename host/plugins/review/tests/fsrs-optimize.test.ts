/**
 * `fsrs_optimize_parameters` 生产入口测试（Rust `fsrs_review_service.rs` tests
 * `optimizer_reports_not_enough_data_for_a_tiny_history` L9606、
 * `optimizer_trains_on_cross_day_history_and_keeps_due_dates` L9630，命令层 `cmd/fsrs_review.rs:570-591`）。
 *
 * 训练/评估走真实 F7 `nativeFsrs`（WASI 中的 fsrs 6.6.2 crate），无替身。
 */
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { fsrs } from '../../../platform/native/fsrs/index.ts';
import review from '../index.ts';
import { FSRS_PARAMS_VERSION, MS_PER_DAY } from '../src/fsrs-types.ts';
import { insertCardForTask, insertTaskAndCard } from './anki-data-layer.ts';
import { mistakesFixture } from './storage.ts';

const CMD = 'fsrs_optimize_parameters';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  await setImmediate();
});

type Db = ReturnType<typeof mistakesFixture>['db'];

interface OptimizeResult {
  status: string; cardCount: number; itemCount: number; reviewCount: number;
  current: { logLoss: number; rmseBins: number } | null;
  optimized: { logLoss: number; rmseBins: number } | null;
  params: number[]; recomputedCards: number;
}
interface SchedulerConfig {
  fsrsParams: number[]; fsrsOptimizedAtMs: number | null; fsrsOptimizedReviewCount: number | null;
}
interface EnqueueResult { states: { id: string; ankiCardId: string }[] }

async function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const host = await createTestHost({ plugins: [review], provide: { storage: fixture.storage, nativeFsrs: fsrs } });
  hosts.push(host);
  return { db: fixture.db, host };
}

/** Rust `local_noon_ms`：本地 2026-08-01 12:00 起按天偏移。 */
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

function loadDue(db: Db, stateId: string): number {
  return db.get<{ due_ms: number }>('SELECT due_ms FROM fsrs_card_states WHERE id = ?1', [stateId])!.due_ms;
}

it('optimizer_reports_not_enough_data_for_a_tiny_history', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-tiny', 'task-tiny', 'card-tiny');
  const enqueued = await host.invoke<EnqueueResult>('fsrs_enqueue_cards', { ankiCardIds: ['card-tiny'] });
  const stateId = enqueued.states[0]!.id;
  insertReviewLog(db, stateId, 'card-tiny', 3, 0, localNoonMs(0));
  insertReviewLog(db, stateId, 'card-tiny', 3, 2, localNoonMs(2));
  host.events.length = 0;

  const result = await host.invoke<OptimizeResult>(CMD);
  expect(result.status).toBe('not_enough_data');
  expect(result.itemCount).toBe(1);
  expect((await host.invoke<SchedulerConfig>('fsrs_get_scheduler_config')).fsrsParams).toEqual([]);
  // 命令层：recomputed_cards == 0 时 emit_fsrs_changed(did_write=false) 不发事件。
  expect(result.recomputedCards).toBe(0);
  expect(host.eventsNamed('fsrs://changed')).toEqual([]);
});

it('optimizer_trains_on_cross_day_history_and_keeps_due_dates', { timeout: 120_000 }, async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-opt', 'task-opt', 'card-opt-0');
  for (let index = 1; index < 120; index++) insertCardForTask(db, 'doc-opt', 'task-opt', `card-opt-${index}`);
  const cardIds = Array.from({ length: 120 }, (_, i) => `card-opt-${i}`);
  const { states } = await host.invoke<EnqueueResult>('fsrs_enqueue_cards', { ankiCardIds: cardIds });
  const MASK = (1n << 64n) - 1n;
  let seed = 0x5eedn;
  const dues = new Map<string, number>();
  for (const state of states) {
    insertReviewLog(db, state.id, state.ankiCardId, 3, 0, localNoonMs(0));
    let day = 0;
    for (const interval of [1, 3, 8, 21]) {
      day += interval;
      seed = (seed * 6_364_136_223_846_793_005n + 1n) & MASK;
      // 间隔越长越容易忘：伪随机地按间隔给出 Again / Good / Easy
      const roll = (seed >> 33n) % 100n;
      const rating = roll < 5n + BigInt(interval) * 2n ? 1 : roll > 90n ? 4 : 3;
      insertReviewLog(db, state.id, state.ankiCardId, rating, 2, localNoonMs(day));
    }
    const due = localNoonMs(day + 30);
    seedReviewState(db, state.id, localNoonMs(day), due);
    dues.set(state.id, due);
  }
  host.events.length = 0;

  const result = await host.invoke<OptimizeResult>(CMD);
  expect(result.cardCount).toBe(120);
  expect(result.itemCount).toBe(480);
  expect(result.reviewCount).toBe(600);
  expect(result.current).not.toBeNull();
  expect(result.optimized).not.toBeNull();
  expect(result.params).toHaveLength(21);
  const config = await host.invoke<SchedulerConfig>('fsrs_get_scheduler_config');
  switch (result.status) {
    case 'optimized':
      expect(config.fsrsParams).toHaveLength(21);
      expect(config.fsrsOptimizedReviewCount).toBe(600);
      expect(config.fsrsOptimizedAtMs).not.toBeNull();
      expect(result.recomputedCards).toBe(120);
      // 命令层：recomputed_cards > 0 → fsrs://changed（user/optimize，无卡片实体）。
      expect(host.eventsNamed('fsrs://changed')).toHaveLength(1);
      expect(host.eventsNamed('fsrs://changed')[0]).toMatchObject({ source: 'user', action: 'optimize' });
      break;
    case 'already_optimal':
      expect(config.fsrsParams).toEqual([]);
      expect(host.eventsNamed('fsrs://changed')).toEqual([]);
      break;
    default:
      throw new Error(`unexpected optimizer status ${result.status}`);
  }
  for (const [stateId, due] of dues) expect(loadDue(db, stateId)).toBe(due);
});

it('reports a missing nativeFsrs service as the training-thread failure', async () => {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const host = await createTestHost({ plugins: [review], provide: { storage: fixture.storage } });
  hosts.push(host);
  insertTaskAndCard(fixture.db, 'doc-none', 'task-none', 'card-none');
  const enqueued = await host.invoke<EnqueueResult>('fsrs_enqueue_cards', { ankiCardIds: ['card-none'] });
  const stateId = enqueued.states[0]!.id;
  insertReviewLog(fixture.db, stateId, 'card-none', 3, 0, localNoonMs(0));
  for (let day = 1; day <= 8; day++) insertReviewLog(fixture.db, stateId, 'card-none', 3, 2, localNoonMs(day * 2));

  await expect(host.invoke(CMD)).rejects.toMatchObject({
    error_type: 'Unknown', message: 'FSRS 参数优化任务异常: nativeFsrs service is not available',
  });
});
