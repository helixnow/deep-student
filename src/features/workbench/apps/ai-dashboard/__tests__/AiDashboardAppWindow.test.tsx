import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import zhGenerativeUi from '@/locales/zh-CN/generativeUi.json';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key.startsWith('generativeUi:')) {
        const path = key.slice('generativeUi:'.length).split('.');
        let cur: unknown = zhGenerativeUi;
        for (const seg of path) {
          cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined;
        }
        if (typeof cur === 'string') {
          return cur.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''));
        }
      }
      return key;
    },
    i18n: { language: 'zh-CN', changeLanguage: vi.fn() },
  }),
}));

const {
  getUsageSummaryMock,
  getTodoStatsOverviewMock,
  launchMock,
  setPendingSettingsRouteMock,
  todayStr,
  heatmapDataRef,
} = vi.hoisted(() => {
  const now = new Date();
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return {
    getUsageSummaryMock: vi.fn(),
    getTodoStatsOverviewMock: vi.fn(),
    launchMock: vi.fn(),
    setPendingSettingsRouteMock: vi.fn(),
    todayStr: `${y}-${m}-${d}`,
    heatmapDataRef: {
      current: null as Array<{
        date: string;
        count: number;
        studySeconds: number;
        details: Record<string, number>;
      }> | null,
    },
  };
});

vi.mock('@/hooks/useLearningHeatmap', () => ({
  formatLocalDateYmd: (date: Date) => {
    const y = String(date.getFullYear()).padStart(4, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },
  useLearningHeatmap: () => ({
    data: heatmapDataRef.current ?? [
      {
        date: todayStr,
        count: 4,
        studySeconds: 2700,
        details: {
          chatSessions: 1,
          chatMessages: 4,
          notesEdited: 1,
          textbooksOpened: 0,
          examsCreated: 0,
          translationsCreated: 0,
          essaysCreated: 0,
          ankiCardsCreated: 0,
          questionsAnswered: 0,
        },
      },
    ],
    heatmapData: [],
    loading: false,
    error: null,
    totalActivities: 4,
    activeDays: 1,
    maxCount: 4,
    totalStudySeconds: 2700,
    studyDays: 1,
    maxStudySeconds: 2700,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/api/llmUsageApi', () => ({
  LlmUsageApi: {
    getSummary: getUsageSummaryMock,
  },
}));

vi.mock('@/features/todo/api', () => ({
  getTodoStatsOverview: getTodoStatsOverviewMock,
}));

vi.mock('@/utils/pendingSettingsTab', () => ({
  setPendingSettingsRoute: setPendingSettingsRouteMock,
}));

vi.mock('../../../core/workbenchBus', () => ({
  workbenchBus: {
    launch: launchMock,
    activateDetailed: vi.fn(),
  },
}));

vi.mock('../../system/flashcardsDueSource', () => ({
  getFlashcardsDueCount: () => 3,
  subscribeFlashcardsDueCount: () => () => {},
}));

const agendaSnapshot = { isLoading: false, items: [] };
vi.mock('../../system/todoAgendaSource', () => ({
  getTodoAgendaSnapshot: () => agendaSnapshot,
  subscribeTodoAgenda: () => () => {},
}));

vi.mock('../../system/ankiTaskSource', () => ({
  getActiveAnkiTaskCount: () => 0,
  subscribeAnkiTaskCount: () => () => {},
}));

const todayLearningSnapshot = { cards: 3, mistakes: 0, notes: 0 };
vi.mock('@/features/learning-today/todayLearningStore', () => ({
  getTodayLearningSnapshot: () => todayLearningSnapshot,
  subscribeTodayLearning: () => () => {},
}));

import AiDashboardAppWindow from '../AiDashboardAppWindow';

describe('AiDashboardAppWindow insights and navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    heatmapDataRef.current = null;
    getUsageSummaryMock.mockResolvedValue({
      startDate: todayStr,
      endDate: todayStr,
      totalRequests: 4,
      successRequests: 4,
      errorRequests: 0,
      totalPromptTokens: 700,
      totalCompletionTokens: 369,
      totalTokens: 1069,
    });
    getTodoStatsOverviewMock.mockResolvedValue({
      totalPending: 2,
      totalCompleted: 2,
      completedToday: 1,
      overdueCount: 0,
      completionTrend: [],
      byList: [],
      byPriority: [],
      byTag: [],
    });
  });

  it('renders study time, todo completion rate, AI usage insights and omits static AI badge', async () => {
    const onTitleChange = vi.fn();
    const { container } = render(
      <AiDashboardAppWindow
        windowId="win-dashboard"
        instanceKey=""
        typeId="aiDashboard"
        payload={undefined}
        isFocused
        onTitleChange={onTitleChange}
      />,
    );

    expect(container.querySelector('[data-generative-ui-chrome]')).toBeNull();
    const insights = await screen.findByTestId('wb-ai-dashboard-insights');
    await waitFor(() => {
      expect(insights).toHaveTextContent('50%');
      expect(insights).toHaveTextContent('1.1k');
    });

    fireEvent.click(screen.getByTestId('wb-ai-dashboard-stats-button'));
    expect(setPendingSettingsRouteMock).toHaveBeenCalledWith({ tab: 'statistics' });
    expect(launchMock).toHaveBeenCalledWith({ typeId: 'settings', reason: 'api' });
  });

  it('S4-11: switches Today / 7d / 30d cleanly, deduplicates active days, recomputes todo completion from completionTrend, and labels stats CTA clearly', async () => {
    const now = new Date();
    const ymdOffset = (deltaDays: number) => {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + deltaDays);
      return `${String(dt.getFullYear()).padStart(4, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    const threeDaysAgo = ymdOffset(-3);
    const twentyDaysAgo = ymdOffset(-20);
    const tomorrow = ymdOffset(1);

    heatmapDataRef.current = [
      { date: todayStr, count: 2, studySeconds: 600, details: {} },
      { date: todayStr, count: 1, studySeconds: 600, details: {} },
      { date: tomorrow, count: 5, studySeconds: 9999, details: {} },
      { date: threeDaysAgo, count: 3, studySeconds: 1800, details: {} },
      { date: twentyDaysAgo, count: 4, studySeconds: 3600, details: {} },
    ];

    getTodoStatsOverviewMock.mockImplementation(async (days: number) => ({
      totalPending: 2,
      totalCompleted: 50,
      completedToday: 1,
      overdueCount: 0,
      completionTrend:
        days === 30
          ? [
              { date: todayStr, completedCount: 1, createdCount: 1 },
              { date: threeDaysAgo, completedCount: 2, createdCount: 2 },
              { date: twentyDaysAgo, completedCount: 5, createdCount: 5 },
            ]
          : [
              { date: todayStr, completedCount: 1, createdCount: 1 },
              { date: threeDaysAgo, completedCount: 2, createdCount: 2 },
            ],
      byList: [],
      byPriority: [],
      byTag: [],
    }));
    getUsageSummaryMock.mockImplementation(async (startDate: string) => ({
      startDate,
      endDate: todayStr,
      totalRequests: startDate === todayStr ? 2 : startDate === ymdOffset(-6) ? 7 : 30,
      successRequests: 2,
      errorRequests: 0,
      totalPromptTokens: 100,
      totalCompletionTokens: 100,
      totalTokens: startDate === todayStr ? 200 : startDate === ymdOffset(-6) ? 700 : 3000,
    }));

    render(
      <AiDashboardAppWindow
        windowId="win-dashboard"
        instanceKey=""
        typeId="aiDashboard"
        payload={undefined}
        isFocused
        onTitleChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('wb-ai-dashboard-stats-button')).toHaveTextContent('查看 AI 用量与热力图');
    const insights = await screen.findByTestId('wb-ai-dashboard-insights');
    // 默认 7 天：today(20m) + 3d ago(30m) = 活跃 2 天，完成 3 / 5 = 60%
    await waitFor(() => {
      expect(insights).toHaveTextContent('活跃 2 天');
      expect(insights).toHaveTextContent('60%');
      expect(insights).toHaveTextContent('700');
    });
    expect(screen.getByTestId('wb-ai-dashboard-range-caption')).toHaveTextContent('7 天');

    // 切到「今日」：重复的今日条目与未来日期绝不导致「活跃 2 天」
    fireEvent.click(screen.getByRole('radio', { name: '今日' }));
    await waitFor(() => {
      expect(insights).toHaveTextContent('活跃 1 天');
      expect(insights).toHaveTextContent('33%');
      expect(insights).toHaveTextContent('200');
    });
    expect(screen.getByTestId('wb-ai-dashboard-range-caption')).toHaveTextContent('今日');

    // 切到「30 天」：纳入 20 天前的数据（8 / 10 = 80%，3k tokens）
    fireEvent.click(screen.getByRole('radio', { name: '30 天' }));
    await waitFor(() => {
      expect(insights).toHaveTextContent('活跃 3 天');
      expect(insights).toHaveTextContent('80%');
      expect(insights).toHaveTextContent('3.0k');
    });
  });
});
