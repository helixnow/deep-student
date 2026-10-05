import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setScreen: vi.fn(),
  startBatchSession: vi.fn(async () => true),
  startDueSession: vi.fn(),
  loadDue: vi.fn(async () => undefined),
  reloadActivity: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.notify }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, options?: { count?: number }) => ({
      'today.learnMore': `今天多学 ${options?.count} 张`,
      'today.adjustDailyLimit': '调整每日新卡上限',
      'today.learnMoreEmpty': '没有待学的新卡了',
    }[key] ?? key),
  }),
}));
vi.mock('@/components/mobile', () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/flashcards/components/ProgressRing', () => ({
  ProgressRing: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/flashcards/hooks/useCountUp', () => ({ useCountUp: (value: number) => value }));
vi.mock('@/features/flashcards/hooks/useReviewActivity', () => ({
  computeCurrentStreak: () => 0,
  useReviewActivity: () => ({
    status: 'ready', dayCounts: new Map(), ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    ratedTotal: 0, totalCards: 30, sampledCards: 0, truncated: false, source: 'stats', reload: mocks.reloadActivity,
  }),
}));
vi.mock('@/features/flashcards/events', () => ({ subscribeFlashcardsDueRefresh: () => () => undefined }));
vi.mock('@/features/flashcards/store/fsrsReviewStore', () => ({
  useFsrsReviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    dueCards: [],
    dueTotal: 0,
    loading: false,
    error: null,
    loadDue: mocks.loadDue,
    startDueSession: mocks.startDueSession,
    startBatchSession: mocks.startBatchSession,
    setScreen: mocks.setScreen,
  }),
}));

import { TodayScreen } from '@/features/flashcards/screens/TodayScreen';

const stats = (backlogNew: number) => ({
  total: 30, due: 0, newCount: 26, learning: 0, review: 4, relearning: 0, suspended: 0, reviewsToday: 20,
  backlog: backlogNew, backlogReview: 0, backlogNew,
});

describe('TodayScreen — learn more new cards today', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pulls one batch of waiting new cards into a review session without touching the daily limit', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_stats') return stats(26);
      if (cmd === 'list_anki_library_cards') {
        return { items: [
          { id: 'anki_1', stateId: 'st_1', front: 'F1', back: 'B1', tags: [] },
          { id: 'anki_2', front: 'F2', back: 'B2', tags: ['t'] },
        ], page: 1, pageSize: 10, total: 26 };
      }
      return null;
    });
    render(<TodayScreen />);

    fireEvent.click(await screen.findByRole('button', { name: /今天多学 10 张/ }));
    await waitFor(() => expect(mocks.startBatchSession).toHaveBeenCalled());
    expect(mocks.invoke).toHaveBeenCalledWith('list_anki_library_cards', {
      request: expect.objectContaining({ status: 'new', pageSize: 10, sort: 'created' }),
    });
    expect(mocks.startBatchSession).toHaveBeenCalledWith(
      ['anki_1', 'anki_2'],
      [
        expect.objectContaining({ id: 'st_1', ankiCardId: 'anki_1', front: 'F1' }),
        expect.objectContaining({ id: 'anki_2', ankiCardId: 'anki_2', front: 'F2' }),
      ],
    );
  });

  it('points to the daily limit setting and hides the offer when nothing is waiting', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'fsrs_get_stats' ? stats(3) : null));
    const view = render(<TodayScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '调整每日新卡上限' }));
    expect(mocks.setScreen).toHaveBeenCalledWith('settings');
    expect(screen.getByRole('button', { name: /今天多学 3 张/ })).toBeInTheDocument();
    view.unmount();

    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'fsrs_get_stats' ? stats(0) : null));
    render(<TodayScreen />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('fsrs_get_stats'));
    expect(screen.queryByTestId('fc-today-learn-more')).toBeNull();
  });
});
