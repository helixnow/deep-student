import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { QuestionBankEditor } from '@/components/QuestionBankEditor';
import type { Question, SubmitResult } from '@/api/questionBankApi';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/hooks/useQbankAiGrading', () => ({
  useQbankAiGrading: () => ({
    state: {
      isGrading: false,
      feedback: '',
      verdict: null,
      score: null,
      error: null,
    },
    resetState: vi.fn(),
    startGrading: vi.fn(),
    cancelGrading: vi.fn(),
  }),
}));

describe('QuestionBankEditor AI markdown rendering', () => {
  it('renders cached ai_feedback as markdown after submit', async () => {
    const question: Question = {
      id: 'q1',
      questionLabel: 'Q1',
      content: '测试题',
      questionType: 'single_choice',
      options: [
        { key: 'A', content: '选项A' },
        { key: 'B', content: '选项B' },
      ],
      ai_feedback: '# 一级标题\n\n这是 **加粗** 文本。',
      status: 'new',
      attemptCount: 0,
      correctCount: 0,
      tags: [],
    };

    const submitResult: SubmitResult = {
      isCorrect: true,
      correctAnswer: 'A',
      submissionId: 'sub-1',
    };

    const onSubmitAnswer = vi.fn(async () => submitResult);

    render(
      <QuestionBankEditor
        sessionId="session-1"
        questions={[question]}
        onSubmitAnswer={onSubmitAnswer}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /选项A/i }));
    fireEvent.click(screen.getByRole('button', { name: /提交答案|submit/i }));

    await waitFor(() => {
      expect(onSubmitAnswer).toHaveBeenCalledWith('q1', 'A', 'single_choice');
    });

    await waitFor(() => {
      const h1 = document.querySelector('.markdown-content h1');
      expect(h1).toBeTruthy();
      expect(h1?.textContent).toContain('一级标题');
    });

    expect(document.querySelector('.markdown-content strong')?.textContent).toContain('加粗');
    expect(document.querySelector('svg[viewBox="-40 -40 857 857"]')).toBeTruthy();
  });
});
