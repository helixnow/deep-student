import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => [] as unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true }),
}));
vi.mock('../useFlashcardsMobileChrome', () => ({
  useFlashcardsMobileChrome: () => true,
}));
vi.mock('@/components/exam-sprint', () => ({
  ExamReadinessHud: () => null,
}));
vi.mock('../hooks/useReviewActivity', () => ({
  useReviewActivity: () => ({
    status: 'ready',
    dayCounts: new Map(),
    totalCards: 2,
    reload: vi.fn(),
  }),
  computeCurrentStreak: () => 0,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => ({
      'today.startReview': '开始复习',
      'today.upNext': '即将复习',
      'today.statDue': '待复习',
      'today.statNew': '新卡',
      'today.statLearning': '学习中',
      'today.progressCaption': '今日进度',
    }[key] ?? opts?.defaultValue ?? key),
    i18n: { language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { TodayScreen } from '../screens/TodayScreen';
import { useFsrsReviewStore, type ReviewCard } from '../store/fsrsReviewStore';

const CARDS: ReviewCard[] = [
  { id: 'state-a', ankiCardId: 'anki-a', front: '卡片 A', back: '答案 A' },
  { id: 'state-b', ankiCardId: 'anki-b', front: '卡片 B', back: '答案 B' },
];

describe('TodayScreen mobile one-handed review entry', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_due') return CARDS;
      if (cmd === 'fsrs_get_stats') {
        return {
          total: 2,
          due: 2,
          newCount: 1,
          learning: 0,
          review: 1,
          relearning: 0,
          suspended: 0,
          reviewsToday: 0,
        };
      }
      if (cmd === 'list_anki_library_cards') return { total: 2, decks: [] };
      return null;
    });

    useFsrsReviewStore.setState({
      screen: 'today',
      dueCards: CARDS,
      dueTotal: 2,
      queue: [],
      queueIndex: 0,
      loading: false,
      error: null,
      errorKind: null,
    });
  });

  it('keeps the primary Start Review CTA visible on mobile chrome and starts due session', async () => {
    const startDueSpy = vi.spyOn(useFsrsReviewStore.getState(), 'startDueSession');
    render(<TodayScreen />);

    const cta = screen.getByTestId('fc-today-start-review');
    expect(cta).toBeInTheDocument();
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);
    expect(startDueSpy).toHaveBeenCalledWith();
    expect(useFsrsReviewStore.getState().screen).toBe('session');
    expect(useFsrsReviewStore.getState().queue.map((c) => c.id)).toEqual(['state-a', 'state-b']);
  });

  it('starts reviewing from the clicked Up Next card directly', async () => {
    render(<TodayScreen />);

    const secondCardBtn = await screen.findByTestId('fc-today-upnext-card-state-b');
    fireEvent.click(secondCardBtn);

    const state = useFsrsReviewStore.getState();
    expect(state.screen).toBe('session');
    expect(state.queue.map((c) => c.id)).toEqual(['state-b', 'state-a']);
    expect(state.queueIndex).toBe(0);
  });
});
