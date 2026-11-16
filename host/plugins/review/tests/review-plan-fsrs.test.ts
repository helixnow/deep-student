// D2：题目集复习改用 FSRS（与闪卡同一调度实现），SM-2 遗留状态惰性换算。
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { ReviewPlanRepo } from '../../vfs-repos/repository/review-plans.ts';
import type { ReviewPlan } from '../../vfs-repos/api.ts';
import { localDateKey } from '../src/local-date.ts';
import {
  difficultyFromEase, easeFromDifficulty, fsrsRatingFromQuality, planRatingPreviews,
  resolvePlanFsrsState, schedulePlanAllRatings,
} from '../src/review-plan-fsrs.ts';
import { ReviewPlanService } from '../src/review-plan.ts';
import { createReviewPlanStore } from './vfs-repo-double.ts';
import { getRecordData } from '../../sync/repository/record-data.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test
import { ensureV5TargetDatabaseTables } from '../../sync/repository/v5-runtime-bridge.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test
import { applyIncomingRowV5, mergeKnownRowWithUnknownVault, SyncV5RuntimeCoordinator } from '../../sync/src/v5-runtime-bridge.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test
import { Hlc } from '../../sync/src/hlc.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test
import { MemoryStorage } from '../../sync-providers/tests/memory_storage.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test

const DAY = 86_400_000;
// 固定在本地正午，避开 4 点日切与午夜的边界。
const NOW = new Date(2026, 10, 15, 12, 0, 0, 0).getTime();

function plan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    id: 'rp_fsrs', question_id: 'q1', exam_id: 'e1', ease_factor: 2.5, interval_days: 0, repetitions: 0,
    next_review_date: localDateKey(new Date(NOW)), last_review_date: null, status: 'new', total_reviews: 0,
    total_correct: 0, consecutive_failures: 0, is_difficult: false,
    created_at: '2026-11-01T00:00:00+00:00', updated_at: '2026-11-01T00:00:00+00:00',
    ...overrides,
  };
}

describe('quality → FSRS rating', () => {
  it('maps 0-2 to again, 3 hard, 4 good, 5 easy', () => {
    expect([0, 1, 2, 3, 4, 5].map(fsrsRatingFromQuality)).toEqual([1, 1, 1, 2, 3, 4]);
  });
});

describe('new question previews', () => {
  it('uses the flashcard learning steps: again 1 min, good 10 min, easy graduates to days', () => {
    const previews = planRatingPreviews(plan(), null, NOW);
    expect(previews.again.interval_minutes).toBe(1);
    expect(previews.hard.interval_minutes).toBeGreaterThan(1);
    expect(previews.hard.interval_minutes).toBeLessThan(10);
    expect(previews.good.interval_minutes).toBe(10);
    expect(previews.easy.interval_minutes).toBeGreaterThanOrEqual(1440);
    // 学习步当天到期：错题复习 / 每日练习按 next_review_date <= 今天仍会选到它。
    expect(previews.again.next_review_date).toBe(localDateKey(new Date(NOW)));
  });
});

describe('SM-2 → FSRS migration', () => {
  it('treats a never-reviewed plan as new', () => {
    expect(resolvePlanFsrsState(plan(), null, NOW)).toMatchObject({ phase: 'new', stability: null, difficulty: null });
  });

  it('maps a reviewed SM-2 plan to review state: S ≈ interval, D from ease', () => {
    const legacy = plan({
      ease_factor: 2.5, interval_days: 12, repetitions: 3, total_reviews: 3, status: 'reviewing',
      last_review_date: localDateKey(new Date(NOW - 12 * DAY)),
    });
    const state = resolvePlanFsrsState(legacy, null, NOW);
    expect(state).toMatchObject({ phase: 'review', stability: 12, learning_step: 0 });
    expect(state.difficulty).toBeCloseTo(5, 5);
    const [again, hard, good, easy] = schedulePlanAllRatings(legacy, null, NOW);
    // 四档真正拉开：重来进重学步（当天再见），困难 < 良好 < 简单。
    expect(again!.phase).toBe('relearning');
    expect(again!.intervalMinutes).toBe(10);
    expect(hard!.intervalDays).toBeGreaterThanOrEqual(1);
    expect(good!.intervalDays).toBeGreaterThan(hard!.intervalDays);
    expect(easy!.intervalDays).toBeGreaterThan(good!.intervalDays);
    expect(again!.passed).toBe(false);
    expect(hard!.passed).toBe(true);
  });

  it('maps a plan whose last answer failed to relearning', () => {
    const failed = plan({ ease_factor: 1.7, interval_days: 1, repetitions: 0, total_reviews: 4, consecutive_failures: 2 });
    expect(resolvePlanFsrsState(failed, null, NOW)).toMatchObject({ phase: 'relearning', stability: 1, lapses: 2 });
  });

  it('keeps stored FSRS state over the SM-2 columns', () => {
    const stored = { stability: 30, difficulty: 3, phase: 'review' as const, learning_step: 0, lapses: 1, due_at: NOW, last_review_at: NOW - 30 * DAY };
    expect(resolvePlanFsrsState(plan({ repetitions: 2, interval_days: 4 }), stored, NOW)).toBe(stored);
  });

  it('round-trips ease ↔ difficulty within the clamp', () => {
    expect(difficultyFromEase(1.3)).toBe(10);
    expect(difficultyFromEase(2.5)).toBeCloseTo(5, 5);
    expect(difficultyFromEase(9)).toBe(1);
    expect(easeFromDifficulty(difficultyFromEase(2.2))).toBeCloseTo(2.2, 2);
  });
});

describe('ReviewPlanService with the real repository', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function setup(legacy = false) {
    const root = mkdtempSync(join(tmpdir(), 'review-plan-fsrs-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    const db = storage.database('vfs');
    const dir = 'resources/app/migrations/vfs';
    for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
      if (legacy && file >= 'V20261115__review_plans_fsrs.sql') break;
      db.exec(readFileSync(join(dir, file), 'utf8'));
    }
    cleanups.push(() => { storage.dispose(); rmSync(root, { recursive: true, force: true }); });
    db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
      VALUES ('e1', 'Exam', 'completed', 'tmp_e1', '{}', '{"pages":[]}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`);
    db.run(`INSERT INTO questions (id, exam_id, content, tags, created_at, updated_at)
      VALUES ('q1', 'e1', '2 + 2 = ?', '[]', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`);
    const repo = new ReviewPlanRepo();
    const service = new ReviewPlanService(db, { questions: createReviewPlanStore().questions, reviewPlans: repo });
    return { db, repo, service, storage };
  }

  it('lists a one-minute learning step only when due, including counts and explicit horizons', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { db, repo, service } = setup();
    const created = service.createReviewPlan('q1', 'e1');
    const listed = service.attachRatingPreviews(service.getDueReviews('e1', null));
    expect(listed.plans).toHaveLength(1);
    expect(listed.plans[0]!.rating_previews?.again.interval_minutes).toBe(1);

    const again = service.processReview(created.id, 0, null, null);
    expect(again.passed).toBe(false);
    expect(again.next_review_date).toBe(localDateKey());
    const state = repo.getFsrsStates(db, [created.id]).get(created.id)!;
    expect(state.phase).toBe('learning');
    expect(state.stability).toBeGreaterThan(0);
    expect(state.last_review_at).toBe(NOW);
    expect(state.due_at).toBe(NOW + 60_000);
    expect(service.getDueReviews('e1', localDateKey()).total).toBe(0);
    expect(service.getDueReviews('e1', localDateKey(new Date(NOW + DAY))).total).toBe(1);
    expect(service.getReviewStats('e1').due_today).toBe(0);
    vi.setSystemTime(NOW + 59_999);
    expect(service.getDueReviews('e1', null).plans).toEqual([]);
    vi.setSystemTime(NOW + 60_000);
    expect(service.getDueReviewsWithFilter({ exam_id: 'e1' }).plans.map(item => item.id)).toEqual([created.id]);
    expect(service.getReviewStats('e1').due_today).toBe(1);

    const easy = service.processReview(created.id, 5, null, null);
    expect(easy.passed).toBe(true);
    expect(easy.new_interval).toBeGreaterThanOrEqual(1);
    expect(easy.plan.status).toBe('reviewing');
    expect(repo.getFsrsStates(db, [created.id]).get(created.id)!.phase).toBe('review');
    expect(service.getDueReviews('e1', null).plans).toHaveLength(0);
  });

  it('migrates a legacy SM-2 row on its next review without touching other rows', () => {
    const { db, repo, service } = setup();
    const created = service.createReviewPlan('q1', 'e1');
    db.run(`UPDATE review_plans SET ease_factor = 2.5, interval_days = 10, repetitions = 3, total_reviews = 3,
      status = 'reviewing', last_review_date = ?1, next_review_date = ?2 WHERE id = ?3`,
    [localDateKey(new Date(Date.now() - 10 * DAY)), localDateKey(), created.id]);
    expect(repo.getFsrsStates(db, [created.id]).get(created.id)?.phase ?? null).toBeNull();
    const previews = service.attachPlanPreviews(service.getPlan(created.id))!.rating_previews!;
    expect(previews.good.interval_minutes).toBeGreaterThan(previews.hard.interval_minutes);
    expect(previews.easy.interval_minutes).toBeGreaterThan(previews.good.interval_minutes);
    const good = service.processReview(created.id, 4, null, null);
    expect(good.new_interval * 1440).toBe(previews.good.interval_minutes);
    expect(repo.getFsrsStates(db, [created.id]).get(created.id)!.phase).toBe('review');
  });

  it('resumes a paused plan immediately without discarding its FSRS memory', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { db, repo, service } = setup();
    const created = service.createReviewPlan('q1', 'e1');
    const rated = service.processReview(created.id, 0, null, null);
    const state = repo.getFsrsStates(db, [created.id]).get(created.id)!;

    const suspended = service.suspendPlanIfUnchanged(created.id, rated.plan.updated_at);
    expect(repo.getFsrsStates(db, [created.id]).get(created.id)).toEqual(state);
    expect(service.getDueReviews('e1', null).total).toBe(0);
    service.resumePlanIfUnchanged(created.id, suspended.updated_at);
    expect(repo.getFsrsStates(db, [created.id]).get(created.id)).toEqual({ ...state, due_at: null });
    expect(service.getDueReviews('e1', null).plans.map(item => item.id)).toEqual([created.id]);
  });

  it('uses the next local midnight after a spring-forward day', () => {
    vi.stubEnv('TZ', 'America/Santiago');
    expect(new Date('2026-09-06T00:00:00').getHours()).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { db, repo, service } = setup();
    // First schedule a minute step just before the true end of the short day.
    vi.setSystemTime(new Date('2026-09-06T23:58:00'));
    const plan = service.createReviewPlan('q1', 'e1');
    service.processReview(plan.id, 0, null, null);
    vi.setSystemTime(new Date('2026-09-07T00:28:00'));
    expect(service.getDueReviews('e1', '2026-09-06').total).toBe(1);

    // A learning step at 00:29 on the next day must not leak into 09-06.
    service.processReview(plan.id, 0, null, null);
    expect(repo.getFsrsStates(db, [plan.id]).get(plan.id)?.due_at).toBe(new Date('2026-09-07T00:29:00').getTime());
    expect(service.getDueReviews('e1', '2026-09-06').total).toBe(0);
    vi.setSystemTime(new Date('2026-09-07T00:29:00'));
    expect(service.getDueReviews('e1', null).total).toBe(1);
  });

  it('converges on one complete schedule after two devices rate offline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const remote = new MemoryStorage();
    const secrets = { kCid: new Uint8Array(32).fill(1), masterKeys: new Map([[0, new Uint8Array(32).fill(2)]]) };
    function device(deviceId: string) {
      const client = setup();
      const sync = new SyncV5RuntimeCoordinator({ deviceId, repoId: 'review-plans', stateDb: client.storage.database('sync_state'),
        databases: new Map([['vfs', client.db]]), storage: remote, secrets });
      const publish = (id: string, operation: 'Insert' | 'Update') => sync.publishChangesToV5Cloud([{
        table_name: 'review_plans', database_name: 'vfs', record_id: id, operation,
        data: getRecordData(client.db, 'review_plans', id, 'id'), changed_at: new Date().toISOString(),
      }]);
      return { ...client, sync, publish };
    }
    const a = device('a');
    const b = device('b');
    const plan = a.service.createReviewPlan('q1', 'e1');
    a.service.processReview(plan.id, 0, null, null);
    await a.publish(plan.id, 'Insert');
    await b.sync.pullAndApplyFromV5Cloud();
    expect(b.repo.getFsrsStates(b.db, [plan.id]).get(plan.id)?.phase).toBe('learning');

    // Neither device downloads the other's rating before publishing its own.
    vi.setSystemTime(NOW + 1_000);
    const earlier = a.service.processReview(plan.id, 5, null, null).plan;
    expect(earlier.interval_days).toBeGreaterThan(0);
    vi.setSystemTime(NOW + 2_000);
    const later = b.service.processReview(plan.id, 0, null, null).plan;
    const winner = b.repo.getFsrsStates(b.db, [plan.id]).get(plan.id)!;
    expect(later.interval_days).toBe(0);
    expect(winner.phase).toBe('learning');
    await a.publish(plan.id, 'Update');
    await b.publish(plan.id, 'Update');
    await Promise.all([a.sync.pullAndApplyFromV5Cloud(), b.sync.pullAndApplyFromV5Cloud()]);

    for (const device of [a, b]) {
      expect(device.service.getPlan(plan.id)).toEqual(later);
      expect(device.repo.getFsrsStates(device.db, [plan.id]).get(plan.id)).toEqual(winner);
      vi.setSystemTime(winner.due_at! - 1);
      expect(device.service.getDueReviews('e1', null).total).toBe(0);
      vi.setSystemTime(winner.due_at!);
      expect(device.service.getDueReviews('e1', null).plans.map(p => p.id)).toEqual([plan.id]);
    }
  });

  it('merges independently created plans without losing either device’s review history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const remote = new MemoryStorage();
    const secrets = { kCid: new Uint8Array(32).fill(1), masterKeys: new Map([[0, new Uint8Array(32).fill(2)]]) };
    const clients = ['a', 'b'].map(deviceId => {
      const client = setup();
      client.db.exec('PRAGMA foreign_keys = ON');
      const sync = new SyncV5RuntimeCoordinator({ deviceId, repoId: 'review-plans', stateDb: client.storage.database('sync_state'),
        databases: new Map([['vfs', client.db]]), storage: remote, secrets });
      const plan = client.service.createReviewPlan('q1', 'e1');
      return { ...client, sync, id: plan.id, publish() {
        sync.captureUnboundLocalChangeLogs();
        return sync.publishChangesToV5Cloud([]);
      } };
    });
    clients.sort((a, b) => a.id < b.id ? -1 : 1);
    const [a, b] = [clients[0]!, clients[1]!];
    expect(a.id).not.toBe(b.id);

    const earlier = a.service.processReview(a.id, 5, 'answer on A', 10);
    await a.publish();
    vi.setSystemTime(NOW + 1_000);
    const later = b.service.processReview(b.id, 0, 'answer on B', 20);
    const winningFsrs = b.repo.getFsrsStates(b.db, [b.id]).get(b.id)!;
    await b.publish();
    await Promise.all(clients.map(client => client.sync.pullAndApplyFromV5Cloud()));

    for (const [client, review] of [[a, earlier], [b, later]] as const) {
      expect(client.service.listPlansByExam('e1', null, null).plans).toEqual([{ ...later.plan, id: a.id }]);
      expect(client.repo.getFsrsStates(client.db, [a.id]).get(a.id)).toEqual(winningFsrs);
      expect(client.service.getReviewHistory(a.id, null)).toEqual([{ ...review.history, plan_id: a.id }]);
      expect(client.db.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(await client.publish()).toEqual({ published: 0 });
    }

    vi.setSystemTime(NOW + 2_000);
    const followUp = b.service.processReview(a.id, 4, 'after sync', 30);
    await b.publish();
    await a.sync.pullAndApplyFromV5Cloud();
    expect(a.service.listPlansByExam('e1', null, null).plans).toEqual([followUp.plan]);
    expect(a.service.getReviewHistory(a.id, null)).toEqual([earlier.history]);
    expect(b.service.getReviewHistory(a.id, null)).toEqual([followUp.history, { ...later.history, plan_id: a.id }]);
  });

  it('uses the newer legacy review when an older V5 client relays opaque FSRS fields', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const modern = setup();
    const legacy = setup(true);
    const fresh = setup();
    for (const client of [modern, legacy, fresh]) ensureV5TargetDatabaseTables(client.db);
    const created = modern.service.createReviewPlan('q1', 'e1');
    modern.service.processReview(created.id, 0, null, null);

    function transfer(source: typeof modern, target: typeof modern, sender: string, operation: 'Insert' | 'Update') {
      const data = getRecordData(source.db, 'review_plans', created.id, 'id');
      const stamp = new Hlc(BigInt(Date.now()), 1).toString();
      const change = { table_name: 'review_plans', database_name: 'vfs', record_id: created.id,
        operation, data, changed_at: stamp, source_device_id: sender };
      const payload = mergeKnownRowWithUnknownVault(source.db, change, { hlc: stamp, dev: sender });
      expect(applyIncomingRowV5(target.db, { ...change, data: payload.data }, payload.versions)).toBe(true);
    }

    transfer(modern, legacy, 'modern', 'Insert');
    transfer(modern, fresh, 'modern', 'Insert');
    expect(fresh.repo.getFsrsStates(fresh.db, [created.id]).get(created.id)?.phase).toBe('learning');

    // The old client's real schema can update its SM-2 schedule on the same day,
    // while its sync vault still holds the earlier FSRS learning state.
    vi.setSystemTime(NOW + 1_000);
    legacy.db.run(`UPDATE review_plans SET interval_days = 7, repetitions = 2, total_reviews = 3,
      total_correct = 2, consecutive_failures = 0, status = 'reviewing', next_review_date = ?1, updated_at = ?2
      WHERE id = ?3`, [localDateKey(new Date(NOW + 7 * DAY)), new Date(Date.now()).toISOString(), created.id]);
    transfer(legacy, modern, 'legacy', 'Update');
    transfer(legacy, fresh, 'legacy', 'Update');

    for (const client of [modern, fresh]) {
      const synced = client.service.getPlan(created.id)!;
      expect(synced.interval_days).toBe(7);
      expect(client.repo.getFsrsStates(client.db, [created.id]).get(created.id)?.phase ?? null).toBeNull();
      expect(client.service.attachPlanPreviews(synced)?.rating_previews).toEqual(planRatingPreviews(synced, null, Date.now()));
      const rerated = client.service.processReview(created.id, 5, null, null);
      expect(rerated.plan.total_reviews).toBe(4);
      expect(client.repo.getFsrsStates(client.db, [created.id]).get(created.id)?.phase).toBe('review');
    }
  });
});
