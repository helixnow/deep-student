import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadDueMistakeItems, refreshTodayLearning } = vi.hoisted(() => ({
  loadDueMistakeItems: vi.fn(),
  refreshTodayLearning: vi.fn(async () => {}),
}));

vi.mock('../dueMistakesReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dueMistakesReview')>()),
  loadDueMistakeItems,
}));
vi.mock('../todayLearningStore', () => ({ refreshTodayLearning }));
vi.mock('@/components/ReviewSession', () => ({
  ReviewSession: ({ examId, onClose }: { examId?: string; onClose?: () => void }) => (
    <div data-testid="review-session" data-exam-id={examId}>
      <button type="button" onClick={onClose}>finish</button>
    </div>
  ),
}));

import { DueMistakesReviewOverlay } from '../DueMistakesReviewOverlay';
import { DUE_MISTAKES_SESSION_KEY, isDueMistakesReviewOpen, openDueMistakesReview } from '../dueMistakesReview';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';

const item = (id: string, examId: string) => ({
  plan: { id, question_id: `q-${id}`, exam_id: examId } as never,
  question: { id: `q-${id}`, content: id, question_type: 'short_answer', tags: [] },
});

describe('DueMistakesReviewOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useReviewPlanStore.getState().endSession();
    openDueMistakesReview();
  });

  it('starts one review session over due mistakes from several question sets', async () => {
    loadDueMistakeItems.mockResolvedValue({ items: [item('a', 'exam-1'), item('b', 'exam-2')], missing: 0 });
    render(<DueMistakesReviewOverlay />);

    const session = await screen.findByTestId('review-session');
    expect(session.dataset.examId).toBe(DUE_MISTAKES_SESSION_KEY);
    const state = useReviewPlanStore.getState().session;
    expect(state.examId).toBe(DUE_MISTAKES_SESSION_KEY);
    expect(state.queue.map((entry) => entry.plan.id)).toEqual(['a', 'b']);

    fireEvent.click(screen.getByText('finish'));
    expect(isDueMistakesReviewOpen()).toBe(false);
    expect(useReviewPlanStore.getState().session.isActive).toBe(false);
    expect(refreshTodayLearning).toHaveBeenCalled();
  });

  it('says so when nothing is due and closes on Escape', async () => {
    loadDueMistakeItems.mockResolvedValue({ items: [], missing: 0 });
    render(<DueMistakesReviewOverlay />);

    await screen.findByText('今天没有到期的错题');
    expect(useReviewPlanStore.getState().session.isActive).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(isDueMistakesReviewOpen()).toBe(false);
  });

  it('shows the load error instead of an endless spinner', async () => {
    loadDueMistakeItems.mockRejectedValue(new Error('db locked'));
    render(<DueMistakesReviewOverlay />);
    await waitFor(() => expect(screen.getByText('db locked')).toBeInTheDocument());
    expect(screen.getByText('加载到期错题失败')).toBeInTheDocument();
  });
});
