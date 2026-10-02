/**
 * 确定性学习周报：近 7 天（含今天）对比前 7 天，全部来自本地已有统计，不经 LLM。
 *
 * - 做题：qbank_get_activity_heatmap（answer_submissions 口径）
 * - 卡片复习：fsrs_get_review_statistics.dailyReviews
 * - 番茄专注：pomodoro_stats_overview.daily
 * - 薄弱知识点：mastery_get_overview.weakest
 * - 待复习：loadTodayLearning（与首页「今日学习」同口径）
 *
 * 生成的 Markdown 可存为笔记，也可带进对话让 AI 做复盘。
 */
import { invoke } from '@tauri-apps/api/core';
import { localCalendarDate } from '@/features/notes/noteLearningProps';
import { loadTodayLearning, type TodayLearning } from './todayLearning';

export interface DayTotals {
  questions: number;
  correct: number;
  cardReviews: number;
  cardAgain: number;
  focusSeconds: number;
  pomodoros: number;
}

export interface WeeklyReportData {
  /** 本周起止（本地日期，含） */
  start: string;
  end: string;
  thisWeek: DayTotals;
  lastWeek: DayTotals;
  /** 本周有任何学习记录的天数 */
  activeDays: number;
  weakest: Array<{ concept: string; score: number }>;
  due: Pick<TodayLearning, 'cards' | 'mistakes' | 'notes'>;
}

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const emptyTotals = (): DayTotals => ({ questions: 0, correct: 0, cardReviews: 0, cardAgain: 0, focusSeconds: 0, pomodoros: 0 });

function shiftDate(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** 把逐日记录按日期落进「本周 / 上周」两个桶，同时统计本周活跃天数 */
export function bucketByWeek(
  now: Date,
  rows: Array<{ date: string } & Partial<DayTotals>>,
): Pick<WeeklyReportData, 'start' | 'end' | 'thisWeek' | 'lastWeek' | 'activeDays'> {
  const end = localCalendarDate(now);
  const start = localCalendarDate(shiftDate(now, -6));
  const lastStart = localCalendarDate(shiftDate(now, -13));
  const thisWeek = emptyTotals();
  const lastWeek = emptyTotals();
  const active = new Set<string>();
  for (const row of rows) {
    if (row.date < lastStart || row.date > end) continue;
    const bucket = row.date >= start ? thisWeek : lastWeek;
    let any = false;
    for (const key of Object.keys(bucket) as Array<keyof DayTotals>) {
      const value = row[key] ?? 0;
      if (value > 0) {
        bucket[key] += value;
        any = true;
      }
    }
    if (any && row.date >= start) active.add(row.date);
  }
  return { start, end, thisWeek, lastWeek, activeDays: active.size };
}

export async function loadWeeklyReportData(now = new Date()): Promise<WeeklyReportData> {
  const years = Array.from(new Set([now.getFullYear(), shiftDate(now, -13).getFullYear()]));
  const [heatmaps, fsrs, pomodoro, mastery, due] = await Promise.all([
    Promise.all(years.map((year) =>
      invoke<Array<{ date: string; count: number; correct_count: number }>>('qbank_get_activity_heatmap', {
        request: { exam_id: null, year },
      }).catch(() => []),
    )),
    invoke<{ dailyReviews?: Array<{ date: string; total: number; again: number }> }>('fsrs_get_review_statistics', { days: 14 })
      .catch(() => null),
    invoke<{ daily?: Array<{ date: string; focusSeconds: number; completedCount: number }> }>('pomodoro_stats_overview', { days: 14 })
      .catch(() => null),
    invoke<{ weakest?: Array<{ conceptKey: string; score: number }> }>('mastery_get_overview', { limit: 5 })
      .catch(() => null),
    loadTodayLearning(now).catch(() => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] })),
  ]);

  const rows: Array<{ date: string } & Partial<DayTotals>> = [
    ...heatmaps.flat().map((p) => ({ date: p.date, questions: p.count, correct: p.correct_count })),
    ...(fsrs?.dailyReviews ?? []).map((d) => ({ date: d.date, cardReviews: d.total, cardAgain: d.again })),
    ...(pomodoro?.daily ?? []).map((d) => ({ date: d.date, focusSeconds: d.focusSeconds, pomodoros: d.completedCount })),
  ];

  return {
    ...bucketByWeek(now, rows),
    weakest: (mastery?.weakest ?? [])
      // item:<id> 是无标签题目的兜底键，对学习者没有可读含义
      .filter((m) => m.conceptKey && !m.conceptKey.startsWith('item:'))
      .map((m) => ({ concept: m.conceptKey, score: m.score })),
    due: { cards: due.cards, mistakes: due.mistakes, notes: due.notes },
  };
}

function formatDuration(seconds: number, t: Translate): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('weekly_report.minutes', { count: minutes, defaultValue: '{{count}} 分钟' });
  return t('weekly_report.hours', { count: Math.round(minutes / 6) / 10, defaultValue: '{{count}} 小时' });
}

function delta(current: number, previous: number, t: Translate): string {
  if (previous === 0) return current > 0 ? t('weekly_report.delta_new', { defaultValue: '（上周无记录）' }) : '';
  const diff = current - previous;
  if (diff === 0) return t('weekly_report.delta_same', { defaultValue: '（与上周持平）' });
  const pct = Math.round((Math.abs(diff) / previous) * 100);
  return diff > 0
    ? t('weekly_report.delta_up', { pct, defaultValue: '（比上周 +{{pct}}%）' })
    : t('weekly_report.delta_down', { pct, defaultValue: '（比上周 −{{pct}}%）' });
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function weeklyReportTitle(data: WeeklyReportData, t: Translate): string {
  return t('weekly_report.title', {
    start: data.start.slice(5).replace('-', '.'),
    end: data.end.slice(5).replace('-', '.'),
    defaultValue: '学习周报 {{start}}–{{end}}',
  });
}

export function buildWeeklyReportMarkdown(data: WeeklyReportData, t: Translate): string {
  const { thisWeek: w, lastWeek: l } = data;
  const lines: string[] = [];
  const sum = (s: string) => lines.push(s);

  sum(`## ${t('weekly_report.overview', { defaultValue: '概览' })}`);
  sum('');
  sum(`- ${t('weekly_report.active_days', { count: data.activeDays, defaultValue: '学习天数：{{count}} / 7' })}`);
  sum(`- ${t('weekly_report.questions', { count: w.questions, rate: pct(w.correct, w.questions), defaultValue: '做题：{{count}} 道，正确率 {{rate}}%' })}${delta(w.questions, l.questions, t)}`);
  sum(`- ${t('weekly_report.cards', { count: w.cardReviews, again: w.cardAgain, defaultValue: '卡片复习：{{count}} 次，其中忘记 {{again}} 次' })}${delta(w.cardReviews, l.cardReviews, t)}`);
  sum(`- ${t('weekly_report.focus', { duration: formatDuration(w.focusSeconds, t), count: w.pomodoros, defaultValue: '番茄专注：{{duration}}（完成 {{count}} 个番茄）' })}${delta(w.focusSeconds, l.focusSeconds, t)}`);
  sum('');

  sum(`## ${t('weekly_report.weak_title', { defaultValue: '薄弱知识点' })}`);
  sum('');
  if (data.weakest.length === 0) {
    sum(t('weekly_report.weak_none', { defaultValue: '暂无足够的作答记录来判断薄弱点。' }));
  } else {
    for (const item of data.weakest) {
      sum(`- ${item.concept}：${t('weekly_report.mastery', { score: Math.round(item.score * 100), defaultValue: '掌握度 {{score}}%' })}`);
    }
  }
  sum('');

  sum(`## ${t('weekly_report.next_title', { defaultValue: '接下来' })}`);
  sum('');
  sum(`- ${t('weekly_report.due', { cards: data.due.cards, mistakes: data.due.mistakes, notes: data.due.notes, defaultValue: '当前待复习：卡片 {{cards}} 张、错题 {{mistakes}} 道、笔记 {{notes}} 篇' })}`);
  if (data.activeDays < 4) {
    sum(`- ${t('weekly_report.tip_consistency', { defaultValue: '本周学习天数偏少，试着每天固定一小段时间，哪怕只复习到期卡片。' })}`);
  }
  if (w.questions >= 10 && pct(w.correct, w.questions) < 60) {
    sum(`- ${t('weekly_report.tip_accuracy', { defaultValue: '正确率偏低，建议先回看错题解析，再做同类题巩固。' })}`);
  }
  if (w.cardReviews >= 20 && pct(w.cardAgain, w.cardReviews) > 30) {
    sum(`- ${t('weekly_report.tip_forgetting', { defaultValue: '卡片忘记比例偏高，可以减少每日新卡、优先消化到期复习。' })}`);
  }
  return lines.join('\n');
}
