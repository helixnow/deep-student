import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

const submitReview = vi.fn(async () => undefined);

function start(question: NonNullable<ReviewItemWithQuestion['question']>) {
  useReviewPlanStore.setState({ submitReview });
  useReviewPlanStore.getState().startSession([{ plan, question }], 'e1');
}

const reveal = () => fireEvent.click(screen.getByRole('button', { name: /显示答案|核对答案/ }));
const option = (text: string) => screen.getByRole('button', { name: new RegExp(text) });

const singleChoice = {
  id: 'q1', content: '下列哪个是质数？', answer: 'B', question_type: 'single_choice', tags: [],
  options: [{ key: 'A', content: '4' }, { key: 'B', content: '7' }, { key: 'C', content: '9' }],
};

describe('ReviewSession — answer before revealing', () => {
  beforeEach(() => {
    submitReview.mockClear();
    useReviewPlanStore.getState().endSession();
  });

  it('lists the options with the stem and marks the correct one only after revealing', () => {
    start(singleChoice);
    render(<ReviewSession examId="e1" />);
    const list = screen.getByTestId('review-options');
    expect(list.textContent).toContain('A.4');
    expect(list.querySelector('[data-correct]')).toBeNull();
    reveal();
    const correct = list.querySelectorAll('[data-correct]');
    expect(correct).toHaveLength(1);
    expect(correct[0].textContent).toContain('7');
    expect(screen.queryByTestId('review-verdict')).toBeNull();
  });

  it('judges a picked option, suggests the rating and records the answer with it', async () => {
    start(singleChoice);
    render(<ReviewSession examId="e1" />);
    fireEvent.click(option('A\\.\\s*4'));
    expect(screen.getByRole('button', { name: /核对答案/ })).toBeInTheDocument();
    reveal();
    expect(screen.getByTestId('review-verdict').textContent).toContain('你选了 A，正确是 B');
    expect(screen.getByTestId('review-options').querySelector('[data-wrong]')?.textContent).toContain('4');
    expect(screen.getByRole('button', { name: /重来/ })).toHaveAttribute('data-suggested', 'true');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    });
    expect(submitReview).toHaveBeenCalledWith(0, 'A');
  });

  it('accepts letter keys and multi-choice picks, and calls an exact match correct', async () => {
    start({ ...singleChoice, answer: 'A、C', question_type: 'multiple_choice' });
    render(<ReviewSession examId="e1" />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    reveal();
    expect(screen.getByTestId('review-verdict').textContent).toContain('答对了');
    expect(screen.getByRole('button', { name: /良好/ })).toHaveAttribute('data-suggested', 'true');
    fireEvent.click(screen.getByRole('button', { name: /良好/ }));
    expect(submitReview).toHaveBeenCalledWith(3, 'AC');
  });

  it('lets other question types jot an answer first and shows it next to the reference answer', () => {
    start({ id: 'q1', content: '简述牛顿第一定律', answer: '惯性定律……', question_type: 'short_answer', tags: [] });
    render(<ReviewSession examId="e1" />);
    fireEvent.change(screen.getByRole('textbox', { name: '你的答案' }), { target: { value: '物体保持静止或匀速直线运动' } });
    reveal();
    expect(screen.getByTestId('review-your-answer').textContent).toContain('物体保持静止或匀速直线运动');
    fireEvent.click(screen.getByRole('button', { name: /困难/ }));
    expect(submitReview).toHaveBeenCalledWith(2, '物体保持静止或匀速直线运动');
  });

  it('never judges sentence-style answers against option keys', () => {
    start({
      id: 'q1', content: '简答', answer: 'A cell membrane controls transport', question_type: 'short_answer', tags: [],
      options: [{ key: 'A', content: 'x' }, { key: 'C', content: 'z' }],
    });
    render(<ReviewSession examId="e1" />);
    fireEvent.click(option('A\\.\\s*x'));
    reveal();
    expect(screen.getByTestId('review-options').querySelectorAll('[data-correct]')).toHaveLength(0);
    expect(screen.queryByTestId('review-verdict')).toBeNull();
  });
});
