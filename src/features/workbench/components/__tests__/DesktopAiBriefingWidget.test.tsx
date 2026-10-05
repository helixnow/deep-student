import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
        'generativeUi:workbench.briefing.open_qbank': '打开题目集',
      };
      return map[key] ?? opts?.defaultValue ?? key;
    },
  }),
}));

const { startReview, openQbank, openTodayReviewTarget, launch } = vi.hoisted(() => ({
  startReview: vi.fn(),
  openQbank: vi.fn(),
  openTodayReviewTarget: vi.fn(),
  launch: vi.fn(),
}));

vi.mock('@/features/generative-ui/handlers/workbenchLearningHandlers', () => ({
  createWorkbenchLearningHandlers: () => ({
    'start-review': { id: 'start-review', label: '开始复习', riskLevel: 'low', handler: startReview },
    'open-qbank': { id: 'open-qbank', label: '打开题目集', riskLevel: 'low', handler: openQbank },
  }),
}));

vi.mock('@/features/learning-today/openTodayReview', () => ({ openTodayReviewTarget }));

vi.mock('../../core/workbenchBus', () => ({ workbenchBus: { launch } }));

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

const todayState = { cards: 3, mistakes: 0, notes: 0, dueNotes: [] as unknown[] };

vi.mock('@/features/learning-today/todayLearningStore', () => ({
  getTodayLearningSnapshot: () => todayState,
  subscribeTodayLearning: () => () => {},
}));

import { DesktopAiBriefingWidget } from '../DesktopAiBriefingWidget';
import { DESKTOP_WIDGET_COLLAPSE_KEY, reloadDesktopWidgetCollapse } from '../desktopWidgetCollapse';

describe('DesktopAiBriefingWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flashcardsDueState.count = 3;
    Object.assign(todayState, { cards: 3, mistakes: 0, notes: 0 });
    todoAgendaSnapshot.items = [{ id: '1', dueDate: '2000-01-01', status: 'pending' as const }];
    localStorage.removeItem(DESKTOP_WIDGET_COLLAPSE_KEY);
    reloadDesktopWidgetCollapse();
  });

  it('shows the four counts in one row with the total in the header', () => {
    flashcardsDueState.count = 2;
    Object.assign(todayState, { cards: 2, mistakes: 4, notes: 1 });
    render(<DesktopAiBriefingWidget />);
    expect(screen.getByTestId('wb-ai-briefing-tile-cards').textContent).toContain('2');
    expect(screen.getByTestId('wb-ai-briefing-tile-mistakes').textContent).toContain('4');
    expect(screen.getByTestId('wb-ai-briefing-tile-notes').textContent).toContain('1');
    expect(screen.getByTestId('wb-ai-briefing-tile-todos').textContent).toContain('1');
    expect(screen.getByTestId('wb-ai-briefing-summary').textContent).toBe('generativeUi:workbench.briefing.due_total');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('marks overdue todos and sends each tile to its own place', () => {
    render(<DesktopAiBriefingWidget />);
    const todos = screen.getByTestId('wb-ai-briefing-tile-todos');
    expect(todos.textContent).toContain('generativeUi:workbench.briefing.overdue_short');
    fireEvent.click(screen.getByTestId('wb-ai-briefing-tile-mistakes'));
    fireEvent.click(screen.getByTestId('wb-ai-briefing-tile-cards'));
    fireEvent.click(todos);
    expect(openTodayReviewTarget.mock.calls).toEqual([['mistakes'], ['cards']]);
    expect(launch).toHaveBeenCalledWith({ typeId: 'todo', reason: 'api' });
  });

  it('hides 开始复习 when nothing is due but keeps 打开题目集', () => {
    flashcardsDueState.count = 0;
    Object.assign(todayState, { cards: 0, mistakes: 0, notes: 0 });
    render(<DesktopAiBriefingWidget />);
    expect(screen.queryByRole('button', { name: '开始复习' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开题目集' }));
    expect(openQbank).toHaveBeenCalled();
    expect(screen.getByTestId('wb-ai-briefing-summary').textContent).toBe('generativeUi:workbench.briefing.all_clear');
    expect(screen.getByTestId('wb-ai-briefing-tile-cards').hasAttribute('data-empty')).toBe(true);
  });

  it('starts the review from the primary action when something is due', () => {
    render(<DesktopAiBriefingWidget />);
    fireEvent.click(screen.getByRole('button', { name: '开始复习' }));
    expect(startReview).toHaveBeenCalled();
  });

  it('collapses to the header with the total and remembers it', () => {
    const view = render(<DesktopAiBriefingWidget />);
    fireEvent.click(screen.getByTestId('wb-ai-briefing-collapse'));
    expect(screen.queryByTestId('wb-ai-briefing-tile-cards')).toBeNull();
    expect(screen.queryByRole('button', { name: '开始复习' })).toBeNull();
    expect(screen.getByTestId('wb-ai-briefing-summary')).toBeTruthy();
    expect(screen.getByTestId('wb-ai-briefing-collapse').getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem(DESKTOP_WIDGET_COLLAPSE_KEY) ?? '[]')).toEqual(['briefing']);
    view.unmount();
    reloadDesktopWidgetCollapse();
    render(<DesktopAiBriefingWidget />);
    expect(screen.queryByTestId('wb-ai-briefing-tile-cards')).toBeNull();
    fireEvent.click(screen.getByTestId('wb-ai-briefing-collapse'));
    expect(screen.getByTestId('wb-ai-briefing-tile-cards')).toBeTruthy();
  });
});
