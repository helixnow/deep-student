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
import { applyIncomingRowV5, mergeKnownRowWithUnknownVault } from '../../sync/src/v5-runtime-bridge.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test
import { Hlc } from '../../sync/src/hlc.ts'; // boundary-allow cross-plugin-impl: FSRS sync integration test

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
    return { db, repo, service };
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
