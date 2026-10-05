import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

import { ReviewSession } from '../ReviewSession';
import { useReviewPlanStore, type ReviewItemWithQuestion } from '@/stores/reviewPlanStore';

const plan = {
  id: 'p1', question_id: 'q1', exam_id: 'e1', ease_factor: 2.5, interval_days: 1, repetitions: 1,
  next_review_date: '2026-10-05', last_review_date: null, status: 'learning', total_reviews: 1,
  total_correct: 0, consecutive_failures: 1, is_difficult: false, created_at: '', updated_at: '',
} as ReviewItemWithQuestion['plan'];

function start(question: NonNullable<ReviewItemWithQuestion['question']>) {
  useReviewPlanStore.getState().startSession([{ plan, question }], 'e1');
}

describe('ReviewSession — choice questions', () => {
  beforeEach(() => {
    useReviewPlanStore.getState().endSession();
  });

  it('lists the options with the stem and marks the correct one only after revealing', () => {
    start({
      id: 'q1', content: '下列哪个是质数？', answer: 'B', question_type: 'single_choice', tags: [],
      options: [{ key: 'A', content: '4' }, { key: 'B', content: '7' }, { key: 'C', content: '9' }],
    });
    render(<ReviewSession examId="e1" />);

    const list = screen.getByTestId('review-options');
    expect(list.textContent).toContain('A.4');
    expect(list.textContent).toContain('B.7');
    expect(list.querySelector('[data-correct]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /显示答案|review:action\.showAnswer/ }));
    const correct = list.querySelectorAll('[data-correct]');
    expect(correct).toHaveLength(1);
    expect(correct[0].textContent).toContain('7');
  });

  it('highlights every key of a multi-choice answer and ignores sentence answers', () => {
    start({
      id: 'q1', content: '多选', answer: 'A、C', question_type: 'multiple_choice', tags: [],
      options: [{ key: 'A', content: 'x' }, { key: 'B', content: 'y' }, { key: 'C', content: 'z' }],
    });
    const view = render(<ReviewSession examId="e1" />);
    fireEvent.click(screen.getByRole('button', { name: /显示答案|review:action\.showAnswer/ }));
    expect(screen.getByTestId('review-options').querySelectorAll('[data-correct]')).toHaveLength(2);
    view.unmount();

    useReviewPlanStore.getState().endSession();
    start({
      id: 'q1', content: '简答', answer: 'A cell membrane controls transport', question_type: 'short_answer', tags: [],
      options: [{ key: 'A', content: 'x' }, { key: 'C', content: 'z' }],
    });
    render(<ReviewSession examId="e1" />);
    fireEvent.click(screen.getByRole('button', { name: /显示答案|review:action\.showAnswer/ }));
    expect(screen.getByTestId('review-options').querySelectorAll('[data-correct]')).toHaveLength(0);
  });
});
