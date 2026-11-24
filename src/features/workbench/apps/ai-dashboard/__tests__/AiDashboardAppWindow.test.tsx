import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n } from 'react-i18next';

const {
  getUsageSummaryMock,
  getTodoStatsOverviewMock,
  launchMock,
  setPendingSettingsRouteMock,
  todayStr,
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
    data: [
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
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    vi.clearAllMocks();
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
});
