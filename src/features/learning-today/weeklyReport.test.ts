import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./todayLearning', () => ({ loadTodayLearning: vi.fn() }));
vi.mock('@/dstu', () => ({ dstu: {} }));

import { bucketByWeek, buildWeeklyReportMarkdown, weeklyReportTitle, type Translate } from './weeklyReport';

const t: Translate = (_key, options) =>
  String(options?.defaultValue ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''));

const NOW = new Date(2026, 9, 1, 15, 0, 0); // 2026-10-01 local

describe('weekly report', () => {
  it('buckets the last 7 days against the previous 7 and counts active days', () => {
    const result = bucketByWeek(NOW, [
      { date: '2026-10-01', questions: 10, correct: 8 },
      { date: '2026-09-25', cardReviews: 20, cardAgain: 5 }, // 本周第一天
      { date: '2026-09-24', questions: 4, correct: 1 }, // 上周最后一天
      { date: '2026-09-17', questions: 99 }, // 窗口外
      { date: '2026-09-30', focusSeconds: 0 }, // 零值不算活跃
    ]);
    expect(result.start).toBe('2026-09-25');
    expect(result.end).toBe('2026-10-01');
    expect(result.thisWeek).toMatchObject({ questions: 10, correct: 8, cardReviews: 20, cardAgain: 5 });
    expect(result.lastWeek.questions).toBe(4);
    expect(result.activeDays).toBe(2);
  });

  it('renders a deterministic markdown report with deltas and tips', () => {
    const data = {
      ...bucketByWeek(NOW, [
        { date: '2026-10-01', questions: 20, correct: 8, focusSeconds: 3000, pomodoros: 2 },
        { date: '2026-09-20', questions: 10, correct: 9 },
      ]),
      weakest: [{ concept: '洛必达法则', score: 0.42 }],
      due: { cards: 3, mistakes: 2, notes: 1 },
    };
    expect(weeklyReportTitle(data, t)).toBe('学习周报 09.25–10.01');
    const md = buildWeeklyReportMarkdown(data, t);
    expect(md).toContain('做题：20 道，正确率 40%（比上周 +100%）');
    expect(md).toContain('番茄专注：50 分钟（完成 2 个番茄）（上周无记录）');
    expect(md).toContain('洛必达法则：掌握度 42%');
    expect(md).toContain('卡片 3 张、错题 2 道、笔记 1 篇');
    expect(md).toContain('正确率偏低');
    expect(md).toContain('学习天数偏少');
    // 同输入同输出
    expect(buildWeeklyReportMarkdown(data, t)).toBe(md);
  });
});
