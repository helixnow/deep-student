/**
 * Today learning and the weekly report read what the Rust commands return.
 *
 * Every backend reply here is a complete payload built from the generated IPC contracts (field names, case and
 * nesting as the Rust structs serialize them), and every call is checked against the command's declared arguments.
 * The loaders swallow backend errors into zeros, so a renamed field or argument would otherwise just read as "0".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInvoke, rustResult } from './ipcContract';

const h = vi.hoisted(() => ({
  replies: new Map<string, (args: Record<string, unknown> | undefined) => unknown>(),
  calls: [] as Array<[string, Record<string, unknown> | undefined]>,
  problems: [] as string[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    h.calls.push([cmd, args]);
    h.problems.push(...checkInvoke(cmd, args));
    const reply = h.replies.get(cmd);
    if (!reply) throw new Error(`no reply for ${cmd}`);
    return reply(args);
  }),
}));
vi.mock('@/features/learning-hub/navigation/quickAccessRequest', () => ({ requestLearningHubQuickAccess: vi.fn() }));

import { loadTodayLearning } from '../todayLearning';
import { loadWeeklyReportData } from '../weeklyReport';

const note = (id: string, name: string, props: Record<string, unknown>) => ({
  id,
  path: `/${id}`,
  name,
  type: 'note',
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
  sourceId: id,
  resourceId: `res_${id}`,
  previewType: 'markdown',
  metadata: { isFavorite: false, tags: [], props },
});

function replyWithRustShapes() {
  h.replies.set('fsrs_get_stats', () => rustResult('fsrs_get_stats', { total: 40, due: 9, newCount: 5, reviewsToday: 3, backlog: 2 }));
  h.replies.set('review_plan_get_stats', () => rustResult('review_plan_get_stats', {
    total_plans: 12, due_today: 4, overdue_count: 2, avg_correct_rate: 0.75, updated_at: '2027-01-05T08:00:00Z',
  }));
  h.replies.set('dstu_list', () => rustResult('dstu_list', [
    note('note_b', '函数单调性', { study_review_date: '2027-01-05', study_mastery: 2 }),
    note('note_a', '极限定义', { study_review_date: '2026-12-31' }),
    note('note_c', '下周再看', { study_review_date: '2027-01-12' }),
    note('note_d', '没有学习属性', {}),
  ]));
  h.replies.set('qbank_get_activity_heatmap', (args) => {
    const { year } = (args?.request ?? {}) as { year?: number };
    return rustResult('qbank_get_activity_heatmap', year === 2027
      ? [{ date: '2027-01-02', count: 6, correct_count: 4, level: 2 }]
      : [
        { date: '2026-06-01', count: 50, correct_count: 40, level: 4 },
        { date: '2026-12-24', count: 3, correct_count: 1, level: 1 },
        { date: '2026-12-31', count: 2, correct_count: 2, level: 1 },
      ]);
  });
  h.replies.set('fsrs_get_review_statistics', () => rustResult('fsrs_get_review_statistics', {
    days: 14,
    dailyReviews: [
      { date: '2026-12-25', total: 10, again: 1, good: 9, studyMs: 300_000 },
      { date: '2027-01-04', total: 20, again: 3, hard: 2, good: 15, newIntroduced: 4, studyMs: 900_000 },
    ],
  }));
  h.replies.set('pomodoro_stats_overview', () => rustResult('pomodoro_stats_overview', {
    daily: [{ date: '2027-01-05', completedCount: 2, focusSeconds: 3000, interruptedCount: 1 }],
  }));
  h.replies.set('study_time_range', () => rustResult('study_time_range', [
    { date: '2026-12-28', seconds: 1800 },
    { date: '2027-01-05', seconds: 5400 },
  ]));
  h.replies.set('mastery_get_overview', () => rustResult('mastery_get_overview', {
    conceptCount: 3,
    weakCount: 2,
    avgScore: 0.5,
    weakest: [
      { conceptKey: 'item:q-9', score: 0.1, total: 2, wrongCount: 2 },
      { conceptKey: '导数', score: 0.25, streak: 0, total: 8, wrongCount: 6, lastSignalAt: '2027-01-04T10:00:00Z' },
    ],
  }));
}

const NOW = new Date(2027, 0, 5, 12, 0, 0);

beforeEach(() => {
  h.replies.clear();
  h.calls.length = 0;
  h.problems.length = 0;
  replyWithRustShapes();
});

afterEach(() => {
  expect(h.problems).toEqual([]);
});

describe('today learning against the Rust command shapes', () => {
  it('counts due cards, due review plans and notes whose review date has come', async () => {
    expect(await loadTodayLearning(NOW)).toEqual({
      cards: 9,
      mistakes: 4,
      notes: 2,
      dueNotes: [
        { id: 'note_a', name: '极限定义', reviewDate: '2026-12-31' },
        { id: 'note_b', name: '函数单调性', reviewDate: '2027-01-05' },
      ],
      cardsTotal: 40,
      plansTotal: 12,
    });
    expect(h.calls).toEqual([
      ['fsrs_get_stats', undefined],
      ['review_plan_get_stats', { examId: null }],
      ['dstu_list', { path: '/', options: { typeFilter: 'note', offset: 0, limit: 500 } }],
    ]);
  });

  it('reads an empty library as zero work and still reports the totals', async () => {
    h.replies.set('fsrs_get_stats', () => rustResult('fsrs_get_stats'));
    h.replies.set('review_plan_get_stats', () => rustResult('review_plan_get_stats'));
    h.replies.set('dstu_list', () => rustResult('dstu_list', []));
    expect(await loadTodayLearning(NOW)).toEqual({ cards: 0, mistakes: 0, notes: 0, dueNotes: [], cardsTotal: 0, plansTotal: 0 });
  });
});

describe('weekly report against the Rust command shapes', () => {
  it('buckets every source into this week and last week across a year boundary', async () => {
    expect(await loadWeeklyReportData(NOW)).toEqual({
      start: '2026-12-30',
      end: '2027-01-05',
      thisWeek: { questions: 8, correct: 6, cardReviews: 20, cardAgain: 3, focusSeconds: 3000, pomodoros: 2, studySeconds: 5400 },
      lastWeek: { questions: 3, correct: 1, cardReviews: 10, cardAgain: 1, focusSeconds: 0, pomodoros: 0, studySeconds: 1800 },
      activeDays: 4,
      weakest: [{ concept: '导数', score: 0.25 }],
      due: { cards: 9, mistakes: 4, notes: 2 },
    });
    expect(h.calls.filter(([cmd]) => !['fsrs_get_stats', 'review_plan_get_stats', 'dstu_list'].includes(cmd))).toEqual([
      ['qbank_get_activity_heatmap', { request: { exam_id: null, year: 2027 } }],
      ['qbank_get_activity_heatmap', { request: { exam_id: null, year: 2026 } }],
      ['fsrs_get_review_statistics', { days: 14 }],
      ['pomodoro_stats_overview', { days: 14 }],
      ['study_time_range', { from: '2026-12-23', to: '2027-01-05' }],
      ['mastery_get_overview', { limit: 5 }],
    ]);
  });

  it('reports an empty fortnight when every source is empty', async () => {
    for (const cmd of ['fsrs_get_stats', 'review_plan_get_stats', 'fsrs_get_review_statistics', 'pomodoro_stats_overview', 'mastery_get_overview']) {
      h.replies.set(cmd, () => rustResult(cmd));
    }
    for (const cmd of ['qbank_get_activity_heatmap', 'study_time_range', 'dstu_list']) h.replies.set(cmd, () => rustResult(cmd, []));
    const empty = { questions: 0, correct: 0, cardReviews: 0, cardAgain: 0, focusSeconds: 0, pomodoros: 0, studySeconds: 0 };
    expect(await loadWeeklyReportData(NOW)).toEqual({
      start: '2026-12-30', end: '2027-01-05', thisWeek: empty, lastWeek: empty, activeDays: 0, weakest: [],
      due: { cards: 0, mistakes: 0, notes: 0 },
    });
  });
});
