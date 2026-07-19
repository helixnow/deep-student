import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'session.backToday': '返回今日',
      'session.prepareFailed': '复习队列准备失败',
      'session.retry': '重试',
      'today.loadFailed': '到期卡片加载失败',
      'today.retry': '重试',
      'today.startReview': '开始复习',
      'today.title': '今日复习',
    }[key] ?? key),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ReviewSessionScreen } from '@/features/flashcards/screens/ReviewSessionScreen';
import { TodayScreen } from '@/features/flashcards/screens/TodayScreen';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';

const initialStore = useFsrsReviewStore.getState();

describe('flashcard review error screens', () => {
  beforeEach(() => {
    useFsrsReviewStore.setState({
      screen: 'today',
      dueCards: [],
      dueTotal: 0,
      queue: [],
      queueIndex: 0,
      flipped: false,
      loading: false,
      ratingBusy: false,
      error: null,
      errorKind: null,
      lastRated: null,
      lastReview: null,
      lastSuspended: null,
      retryBatchRequest: null,
      sessionRatedCount: 0,
      sessionAgainCount: 0,
      remainingDueAfterSession: null,
      ratingPreviews: null,
      lastSchedule: null,
      loadDue: initialStore.loadDue,
      retryBatchSession: initialStore.retryBatchSession,
      endSession: initialStore.endSession,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows Today load error details and retries from the error action', () => {
    const loadDue = vi.fn(async () => undefined);
    useFsrsReviewStore.setState({
      error: 'due backend is offline',
      loadDue,
    });

    render(<TodayScreen />);

    expect(screen.getByRole('alert')).toHaveTextContent('due backend is offline');
    expect(loadDue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(loadDue).toHaveBeenCalledTimes(2);
  });

  it('shows batch enqueue error details and retries the preserved request', () => {
    const retryBatchSession = vi.fn(async () => undefined);
    useFsrsReviewStore.setState({
      screen: 'session',
      error: 'enqueue backend is offline',
      retryBatchRequest: { cardIds: ['anki-1'] },
      retryBatchSession,
    });

    render(<ReviewSessionScreen />);

    expect(screen.getByRole('alert')).toHaveTextContent('enqueue backend is offline');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retryBatchSession).toHaveBeenCalledTimes(1);
  });
});
