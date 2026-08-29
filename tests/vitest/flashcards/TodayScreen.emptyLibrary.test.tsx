import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadDue: vi.fn(async () => undefined),
  reloadActivity: vi.fn(),
  setScreen: vi.fn(),
  startDueSession: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string) => ({
      'today.title': "Today's review",
      'today.libraryEmpty': 'Your card library is empty',
      'today.libraryEmptyHint': 'Create cards first',
      'today.goLibrary': 'Open library',
      'today.goStats': 'View statistics',
      'today.progressCaption': "Today's progress",
      'today.startReview': 'Start review',
      'today.statDue': 'Due',
      'today.statNew': 'New',
      'today.statLearning': 'Learning',
      'today.upNext': 'Up next',
    }[key] ?? key),
  }),
}));

vi.mock('@/components/mobile', () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/features/flashcards/components/ProgressRing', () => ({
  ProgressRing: ({ value, children }: { value: number; children: React.ReactNode }) => (
    <div data-testid="progress-ring" data-value={value}>{children}</div>
  ),
}));

vi.mock('@/features/flashcards/hooks/useCountUp', () => ({
  useCountUp: (value: number) => value,
}));

vi.mock('@/features/flashcards/hooks/useReviewActivity', () => ({
  computeCurrentStreak: () => 0,
  useReviewActivity: () => ({
    status: 'ready',
    dayCounts: new Map(),
    ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    ratedTotal: 0,
    totalCards: 0,
    sampledCards: 0,
    truncated: false,
    source: 'stats',
    reload: mocks.reloadActivity,
  }),
}));

vi.mock('@/features/flashcards/events', () => ({
  subscribeFlashcardsDueRefresh: () => () => undefined,
}));

vi.mock('@/features/flashcards/store/fsrsReviewStore', () => ({
  useFsrsReviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    dueCards: [],
    dueTotal: 0,
    loading: false,
    error: null,
    loadDue: mocks.loadDue,
    startDueSession: mocks.startDueSession,
    setScreen: mocks.setScreen,
  }),
}));

import { TodayScreen } from '@/features/flashcards/screens/TodayScreen';

describe('TodayScreen empty card library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({
      total: 0,
      due: 0,
      newCount: 0,
      learning: 0,
      review: 0,
      relearning: 0,
      suspended: 0,
      reviewsToday: 0,
    });
  });

  it('shows onboarding instead of a false 100% completion state', async () => {
    render(<TodayScreen />);

    expect(await screen.findByText('Your card library is empty')).toBeInTheDocument();
    expect(screen.queryByText('today.allDone')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('progress-ring')).toHaveAttribute('data-value', '0');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open library' }));
    expect(mocks.setScreen).toHaveBeenCalledWith('library');
  });
});
