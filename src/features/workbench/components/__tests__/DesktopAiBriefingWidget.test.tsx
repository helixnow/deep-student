import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      const map: Record<string, string> = {
        'generativeUi:workbench.briefing_label': 'AI 学习简报',
        'generativeUi:workbench.briefing.due_flashcards_title': '到期闪卡',
        'generativeUi:workbench.briefing.due_trend_due': '待复习',
        'generativeUi:workbench.briefing.due_trend_none': '暂无到期',
        'generativeUi:workbench.briefing.progress_title': '待办进度',
        'generativeUi:workbench.briefing.overdue_label': '{{count}} 项逾期',
        'generativeUi:workbench.briefing.pending_label': '{{count}} 项待办',
        'generativeUi:workbench.briefing.start_review': '开始复习',
        'generativeUi:workbench.briefing.open_qbank': '打开题库',
      };
      return map[key] ?? opts?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/features/generative-ui/handlers/workbenchLearningHandlers', () => ({
  workbenchLearningHandlers: {},
  createWorkbenchLearningHandlers: () => ({}),
}));

const flashcardsDueState = { count: 3 };

vi.mock('../../apps/system/flashcardsDueSource', () => ({
  getFlashcardsDueCount: () => flashcardsDueState.count,
  subscribeFlashcardsDueCount: () => () => {},
}));

const todoAgendaSnapshot = {
  items: [{ id: '1', dueDate: '2000-01-01', status: 'pending' as const }],
  lists: [],
  isLoading: false,
  error: null,
  updatedAt: 1,
};

vi.mock('../../apps/system/todoAgendaSource', () => ({
  getTodoAgendaSnapshot: () => todoAgendaSnapshot,
  subscribeTodoAgenda: () => () => {},
}));

import { DesktopAiBriefingWidget } from '../DesktopAiBriefingWidget';

function expectChartOrTable(scope: HTMLElement) {
  const chart = scope.querySelector('[data-testid="generative-ui-chart"], [data-generative-chart]');
  const table = scope.querySelector('[data-testid="generative-ui-table"], [data-generative-table]');
  expect(chart || table).toBeTruthy();
}

describe('DesktopAiBriefingWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flashcardsDueState.count = 3;
    todoAgendaSnapshot.items = [{ id: '1', dueDate: '2000-01-01', status: 'pending' as const }];
  });

  it('renders briefing widget with due flashcards stat', () => {
    render(<DesktopAiBriefingWidget />);
    const widget = screen.getByTestId('wb-ai-briefing-widget');
    expect(widget).toBeInTheDocument();
    expect(screen.getAllByText('到期闪卡').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
    expectChartOrTable(widget);
  });
});
