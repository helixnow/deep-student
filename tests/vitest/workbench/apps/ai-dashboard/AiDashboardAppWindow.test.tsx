import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      const map: Record<string, string> = {
        'workbench:apps.aiDashboard': 'AI 仪表盘',
        'generativeUi:workbench.dashboard.title': 'AI 学习仪表盘',
        'generativeUi:workbench.briefing.due_flashcards_title': '到期闪卡',
        'generativeUi:workbench.briefing.due_trend_due': '待复习',
        'generativeUi:workbench.briefing.due_trend_none': '暂无到期',
        'generativeUi:workbench.briefing.progress_title': '待办进度',
        'generativeUi:workbench.briefing.overdue_label': '{{count}} 项逾期',
        'generativeUi:workbench.briefing.pending_label': '{{count}} 项待办',
        'generativeUi:workbench.briefing.start_review': '开始复习',
        'generativeUi:workbench.briefing.open_qbank': '打开题库',
        'generativeUi:workbench.dashboard.anki_tasks_title': '进行中制卡',
        'generativeUi:workbench.dashboard.anki_tasks_trend_active': '后台运行',
        'generativeUi:workbench.dashboard.open_task_dashboard': '打开制卡任务',
      };
      return map[key] ?? opts?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/features/generative-ui/handlers/workbenchLearningHandlers', () => ({
  workbenchLearningHandlers: {},
  createWorkbenchLearningHandlers: () => ({}),
}));

vi.mock('@/features/workbench/apps/system/flashcardsDueSource', () => ({
  getFlashcardsDueCount: () => 4,
  subscribeFlashcardsDueCount: () => () => {},
}));

vi.mock('@/features/workbench/apps/system/ankiTaskSource', () => ({
  getActiveAnkiTaskCount: () => 2,
  subscribeAnkiTaskCount: () => () => {},
}));

const todoAgendaSnapshot = {
  items: [{ id: '1', dueDate: '2099-01-01', status: 'pending' as const }],
  lists: [],
  isLoading: false,
  error: null,
  updatedAt: 1,
};

vi.mock('@/features/workbench/apps/system/todoAgendaSource', () => ({
  getTodoAgendaSnapshot: () => todoAgendaSnapshot,
  subscribeTodoAgenda: () => () => {},
}));

import AiDashboardAppWindow from '@/features/workbench/apps/ai-dashboard/AiDashboardAppWindow';

describe('AiDashboardAppWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dashboard window with briefing stats', () => {
    render(<AiDashboardAppWindow windowId="w1" onTitleChange={vi.fn()} isVisible />);
    const dashboard = screen.getByTestId('wb-ai-dashboard-window');
    expect(dashboard).toBeInTheDocument();
    expect(screen.getByText('AI 学习仪表盘')).toBeInTheDocument();
    expect(screen.getAllByText('到期闪卡').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('进行中制卡').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
    expect(dashboard.querySelector('[data-generative-block="chart"]')).toBeTruthy();
    expect(dashboard.querySelector('[data-generative-chart]')).toBeTruthy();
  });
});
