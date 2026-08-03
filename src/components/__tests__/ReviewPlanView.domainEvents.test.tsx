import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  loadDueReviews: vi.fn(async () => undefined),
  loadQuestions: vi.fn(async () => undefined),
  loadStats: vi.fn(async () => undefined),
  refreshStats: vi.fn(async () => ({})),
  registerDomainListener: vi.fn(),
  startSession: vi.fn(),
  listener: undefined as undefined | (() => void),
}));

vi.mock('@/features/workbench/agent/domainEvents', () => ({
  registerDomainListener: mocks.registerDomainListener,
}));

vi.mock('@/stores/reviewPlanStore', () => ({
  useReviewPlanStore: () => ({
    dueReviews: [],
    stats: null,
    isLoading: false,
    loadDueReviews: mocks.loadDueReviews,
    loadStats: mocks.loadStats,
    refreshStats: mocks.refreshStats,
    startSession: mocks.startSession,
    session: {
      isActive: false,
      examId: null,
      queue: [],
      currentIndex: 0,
      startTime: null,
      questionStartTime: null,
      results: [],
      completedCount: 0,
      correctCount: 0,
    },
  }),
}));

vi.mock('@/stores/questionBankStore', () => ({
  useQuestionBankStore: (selector: (state: unknown) => unknown) => selector({
    questions: new Map(),
    loadQuestions: mocks.loadQuestions,
  }),
}));

import { ReviewPlanView } from '../ReviewPlanView';

describe('ReviewPlanView review domain refresh', () => {
  beforeEach(() => {
    mocks.cleanup.mockReset();
    mocks.loadDueReviews.mockClear();
    mocks.loadQuestions.mockClear();
    mocks.loadStats.mockClear();
    mocks.refreshStats.mockClear();
    mocks.startSession.mockClear();
    mocks.listener = undefined;
    mocks.registerDomainListener.mockReset();
    mocks.registerDomainListener.mockImplementation((_eventName, listener) => {
      mocks.listener = listener;
      return mocks.cleanup;
    });
  });

  it('subscribes while mounted, refreshes due reviews and stats, then cleans up', async () => {
    const view = render(<ReviewPlanView examId="exam_review_contract" />);

    expect(mocks.registerDomainListener).toHaveBeenCalledWith(
      'review://changed',
      expect.any(Function),
    );
    expect(mocks.loadDueReviews).toHaveBeenCalledWith('exam_review_contract');
    expect(mocks.loadStats).toHaveBeenCalledWith('exam_review_contract');

    mocks.loadDueReviews.mockClear();
    mocks.refreshStats.mockClear();

    await act(async () => {
      mocks.listener?.();
      await Promise.resolve();
    });

    expect(mocks.loadDueReviews).toHaveBeenCalledTimes(1);
    expect(mocks.loadDueReviews).toHaveBeenCalledWith('exam_review_contract');
    expect(mocks.refreshStats).toHaveBeenCalledTimes(1);
    expect(mocks.refreshStats).toHaveBeenCalledWith('exam_review_contract');

    view.unmount();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });
});
