import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

import { ReviewSession } from '../ReviewSession';
import {
  useReviewPlanStore,
  type ReviewItemWithQuestion,
  type ReviewPlan,
} from '@/stores/reviewPlanStore';

function buildPlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    id: 'p1',
    question_id: 'q1',
    exam_id: 'e1',
    ease_factor: 2.5,
    interval_days: 2,
    repetitions: 2,
    next_review_date: '2026-10-05',
    last_review_date: '2026-10-03',
    status: 'reviewing',
    total_reviews: 2,
    total_correct: 2,
    consecutive_failures: 0,
    is_difficult: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

const shortQuestion: NonNullable<ReviewItemWithQuestion['question']> = {
  id: 'q1',
  content: '解释洛必达法则的适用条件',
  answer: '0/0 或 ∞/∞ 型未定式，导数存在且分母导数不为 0',
  explanation: '注意检验极限存在性',
  question_type: 'short_answer',
  tags: ['高等数学'],
};

describe('ReviewSession — FSRS interval previews, keyboard shortcuts & state feedback', () => {
  const submitReview = vi.fn(async () => undefined);

  beforeEach(() => {
    submitReview.mockReset();
    useReviewPlanStore.getState().endSession();
  });

  function startWith(planOverrides: Partial<ReviewPlan> = {}, question = shortQuestion) {
    useReviewPlanStore.setState({ submitReview });
    useReviewPlanStore.getState().startSession([{ plan: buildPlan(planOverrides), question }], 'e1');
  }

  it('displays backend FSRS rating_previews on all four rating buttons, and realistic fallback intervals when absent', () => {
    startWith({
      rating_previews: {
        again: { interval_minutes: 10, next_review_date: '2026-10-05' },
        hard: { interval_minutes: 2 * 1440, next_review_date: '2026-10-07' },
        good: { interval_minutes: 5 * 1440, next_review_date: '2026-10-10' },
        easy: { interval_minutes: 14 * 1440, next_review_date: '2026-10-19' },
      },
    });
    const view = render(<ReviewSession examId="e1" />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    });
    expect(screen.getByTestId('review-interval-again').textContent).toBe('10分钟');
    expect(screen.getByTestId('review-interval-hard').textContent).toBe('2天');
    expect(screen.getByTestId('review-interval-good').textContent).toBe('5天');
    expect(screen.getByTestId('review-interval-easy').textContent).toBe('2周');
    view.unmount();

    useReviewPlanStore.getState().endSession();
    startWith({ rating_previews: undefined, repetitions: 0, interval_days: 0, status: 'new' });
    render(<ReviewSession examId="e1" />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    });
    expect(screen.getByTestId('review-interval-again').textContent).toBe('1分钟');
    expect(screen.getByTestId('review-interval-hard').textContent).toBe('6分钟');
    expect(screen.getByTestId('review-interval-good').textContent).toBe('10分钟');
    expect(screen.getByTestId('review-interval-easy').textContent).toBe('4天');
  });

  it('supports Space to reveal answer and 1/2/3/4 to submit FSRS ratings (Again/Hard/Good/Easy)', async () => {
    const cases: Array<[string, number]> = [
      ['1', 0],
      ['2', 3],
      ['3', 4],
      ['4', 5],
    ];

    for (const [key, expectedQuality] of cases) {
      submitReview.mockClear();
      useReviewPlanStore.getState().endSession();
      startWith();
      const view = render(<ReviewSession examId="e1" />);

      // Pressing 1-4 before revealing must NOT submit
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      });
      expect(submitReview).not.toHaveBeenCalled();

      // Space reveals the answer
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
      });
      expect(screen.getByTestId('review-rating-again')).toBeInTheDocument();

      // 1-4 submits corresponding FSRS quality
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      });
      expect(submitReview).toHaveBeenCalledWith(expectedQuality, undefined);
      view.unmount();
    }
  });

  it('shields Space and 1-4 shortcuts when focus/target is in input, textarea, contenteditable, or with Ctrl/Meta/Alt', async () => {
    startWith();
    render(
      <div>
        <input data-testid="ext-input" type="text" />
        <div data-testid="ext-editable" contentEditable="true">
          <span data-testid="ext-editable-child">note</span>
        </div>
        <ReviewSession examId="e1" />
      </div>,
    );

    // 1) Textarea inside ReviewSession focused: Space should not reveal
    const answerBox = screen.getByRole('textbox', { name: '你的答案' });
    answerBox.focus();
    fireEvent.keyDown(answerBox, { key: ' ', code: 'Space' });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    });
    expect(screen.queryByTestId('review-rating-good')).toBeNull();

    // 2) Input focused: Space should not reveal
    const extInput = screen.getByTestId('ext-input');
    extInput.focus();
    fireEvent.keyDown(extInput, { key: ' ', code: 'Space' });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    });
    expect(screen.queryByTestId('review-rating-good')).toBeNull();

    // 3) Nested child inside [contenteditable="true"]: Space should not reveal
    extInput.blur();
    const editableChild = screen.getByTestId('ext-editable-child');
    fireEvent.keyDown(editableChild, { key: ' ', code: 'Space' });
    expect(screen.queryByTestId('review-rating-good')).toBeNull();

    // 4) Modifier keys (Ctrl / Meta / Alt) with Space should not reveal
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', metaKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', altKey: true }));
    });
    expect(screen.queryByTestId('review-rating-good')).toBeNull();

    // Reveal normally without focus in input
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    });
    expect(screen.getByTestId('review-rating-good')).toBeInTheDocument();

    // After reveal: 1-4 with modifiers or inside input/contenteditable must NOT submit
    extInput.focus();
    await act(async () => {
      fireEvent.keyDown(extInput, { key: '3' });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
    });
    extInput.blur();
    await act(async () => {
      fireEvent.keyDown(editableChild, { key: '1' });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', altKey: true }));
    });
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('renders clear FSRS feedback in both empty state and completion state', () => {
    const emptyView = render(<ReviewSession examId="e1" />);
    const emptyEl = screen.getByTestId('review-session-empty');
    expect(emptyEl.textContent).toContain('今天待复习的题目已全部清零');
    expect(emptyEl.textContent).toContain('FSRS');
    emptyView.unmount();

    // Simulate completed session
    useReviewPlanStore.setState({
      session: {
        isActive: true,
        examId: 'e1',
        queue: [{ plan: buildPlan(), question: shortQuestion }],
        currentIndex: 1,
        completedCount: 1,
        correctCount: 1,
        startTime: Date.now() - 12_000,
      },
    });
    render(<ReviewSession examId="e1" />);
    const scheduleNote = screen.getByTestId('review-complete-schedule-note');
    expect(scheduleNote.textContent).toContain('1');
    expect(scheduleNote.textContent).toContain('FSRS');
  });
});
