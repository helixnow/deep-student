import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { formatLocalDateYmd, getHeatmapDateRange } from '@/hooks/useLearningHeatmap';
import {
  buildFallbackStatsFromSources,
  normalizeDashboardStatistics,
  resetFallbackDashboardStatisticsForTest,
} from '../coreStats';
import { WeeklyReportActions, buildTomorrowTodosFromReport } from '../WeeklyReportActions';
import type { WeeklyReportData } from '@/features/learning-today/weeklyReport';

const mocks = vi.hoisted(() => ({
  createTodoItem: vi.fn(async () => ({ id: 'todo-new' })),
  listTodoLists: vi.fn(async () => [{ id: 'inbox', isDefault: true }]),
  loadWeeklyReportData: vi.fn(),
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/todo/api', () => ({
  createTodoItem: mocks.createTodoItem,
  listTodoLists: mocks.listTodoLists,
}));

vi.mock('@/features/learning-today/weeklyReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/learning-today/weeklyReport')>();
  return {
    ...actual,
    loadWeeklyReportData: mocks.loadWeeklyReportData,
  };
});

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.showGlobalNotification,
}));

vi.mock('@/shared/notes', () => ({
  useSaveAsNoteFlow: () => ({ start: vi.fn(), pickerProps: { open: false, onOpenChange: vi.fn(), onConfirm: vi.fn() } }),
  SaveAsNoteFolderPicker: () => null,
}));

const sampleReportData: WeeklyReportData = {
  start: '2026-11-15',
  end: '2026-11-21',
  thisWeek: { questions: 12, correct: 8, cardReviews: 20, cardAgain: 4, focusSeconds: 3000, pomodoros: 2, studySeconds: 4200 },
  lastWeek: { questions: 6, correct: 5, cardReviews: 10, cardAgain: 1, focusSeconds: 1500, pomodoros: 1, studySeconds: 2000 },
  activeDays: 5,
  weakest: [
    { concept: '导数应用', score: 0.35 },
    { concept: '级数收敛', score: 0.52 },
  ],
  due: { cards: 8, mistakes: 3, notes: 2 },
};

describe('Dashboard stats alignment, heatmap local dates, and WeeklyReportActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFallbackDashboardStatisticsForTest();
    mocks.loadWeeklyReportData.mockResolvedValue(sampleReportData);
  });

  afterEach(() => {
    cleanup();
  });

  it('computes heatmap date range using local YYYY-MM-DD (no UTC shift between 00:00-08:00)', () => {
    // 02:30 local time on 2026-11-21: toISOString() in UTC+8 would be 2026-11-20!
    const earlyMorning = new Date(2026, 10, 21, 2, 30, 0);
    expect(formatLocalDateYmd(earlyMorning)).toBe('2026-11-21');
    const range = getHeatmapDateRange(12, earlyMorning);
    expect(range.endDate).toBe('2026-11-21');
    expect(range.startDate).toBe('2025-11-21');
  });

  it('resolves real non-zero stats & monthly trend when backend only returns image_stats', () => {
    const now = new Date(2026, 10, 21, 12, 0, 0);
    const fallback = buildFallbackStatsFromSources(
      [
        {
          date: '2026-10-15',
          count: 10,
          details: {
            chatSessions: 1, chatMessages: 5, notesEdited: 2, textbooksOpened: 0,
            examsCreated: 0, translationsCreated: 1, essaysCreated: 0, ankiCardsCreated: 1, questionsAnswered: 0,
          },
        },
        {
          date: '2026-11-20',
          count: 14,
          details: {
            chatSessions: 2, chatMessages: 6, notesEdited: 2, textbooksOpened: 1,
            examsCreated: 1, translationsCreated: 0, essaysCreated: 0, ankiCardsCreated: 0, questionsAnswered: 2,
          },
        },
      ],
      [
        { tag: '微积分', total: 12, mastery_rate: 80 },
        { tag: '线性代数', total: 8, mastery_rate: 60 },
      ],
      now,
    );

    const normalized = normalizeDashboardStatistics(
      { image_stats: { total_files: 3, total_size_bytes: 1024 } },
      fallback,
    );
    expect(normalized?.basic_stats?.total_mistakes).toBe(24);
    expect(Object.keys(normalized?.basic_stats?.tag_stats || {})).toEqual(['微积分', '线性代数']);
    expect(normalized?.recent_additions).toBe(14);
    expect(normalized?.quality_score).toBe(72);
    expect(normalized?.monthly_trend).toEqual([
      { month: '2026-10', count: 10 },
      { month: '2026-11', count: 14 },
    ]);
  });

  it('builds tomorrow todos from weakest concepts & due items and executes one-click generation', async () => {
    const plan = buildTomorrowTodosFromReport(
      sampleReportData,
      '2026-11-22',
      (_key, opts) => String(opts?.defaultValue ?? _key),
    );
    expect(plan.length).toBe(5);
    expect(plan[0]?.priority).toBe('high');
    expect(plan[0]?.dueDate).toBe('2026-11-22');

    render(<WeeklyReportActions />);
    const reportBtn = screen.getByRole('button', { name: '本周周报' });
    const aiBtn = screen.getByRole('button', { name: '与 AI 复盘' });
    expect(reportBtn.className).toContain('max-md:min-h-9');
    expect(aiBtn.className).toContain('max-md:min-h-9');

    fireEvent.click(reportBtn);
    const genBtn = await screen.findByTestId('weekly-report-generate-tomorrow-todos');
    fireEvent.click(genBtn);

    await waitFor(() => {
      expect(mocks.createTodoItem).toHaveBeenCalledTimes(5);
    });
    expect(mocks.showGlobalNotification).toHaveBeenCalledWith('success', expect.any(String));
  });
});
