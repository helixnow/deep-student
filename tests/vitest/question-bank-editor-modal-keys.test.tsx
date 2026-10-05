/**
 * 做题快捷键与模态层：编辑器盖在别的模态层下面时让行；编辑器自己就在模态层里（错题重做浮层）时照常响应。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { QuestionBankEditor } from '@/components/QuestionBankEditor';
import type { Question, SubmitResult } from '@/api/questionBankApi';
import { useQuestionBankStore, type PracticeSessionOwner } from '@/stores/questionBankStore';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
  useIsMobile: () => false,
  useIsTablet: () => false,
}));

vi.mock('@/hooks/useQbankAiGrading', () => {
  // 回调要稳定：组件把 resetState 放进切题 effect 的依赖
  const resetState = vi.fn();
  const startGrading = vi.fn();
  const retryGrading = vi.fn();
  const cancelGrading = vi.fn();
  return {
    useQbankAiGrading: () => ({
      state: { isGrading: false, feedback: '', verdict: null, score: null, error: null },
      resetState,
      startGrading,
      retryGrading,
      cancelGrading,
    }),
  };
});

const question: Question = {
  id: 'q1',
  questionLabel: 'Q1',
  content: '1 + 1 = ?',
  questionType: 'single_choice',
  options: [
    { key: 'A', content: '2' },
    { key: 'B', content: '3' },
  ],
  status: 'review',
  attemptCount: 1,
  correctCount: 0,
  tags: [],
};

const owner: PracticeSessionOwner = { examId: '__mistake_redo__', viewInstanceId: 'modal-keys-test' };

function editor(onSubmitAnswer: (id: string, answer: string, type?: string) => Promise<SubmitResult>) {
  return (
    <QuestionBankEditor
      sessionId="exam-a"
      practiceSessionOwner={owner}
      questions={[question]}
      onSubmitAnswer={onSubmitAnswer}
    />
  );
}

describe('QuestionBankEditor shortcuts and modal layers', () => {
  beforeEach(() => {
    useQuestionBankStore.setState({ practiceSessions: {} });
    useQuestionBankStore.getState().ensurePracticeSession(owner, ['q1']);
  });

  it('answers with number keys when the editor itself sits inside the modal', async () => {
    const onSubmitAnswer = vi.fn(async (): Promise<SubmitResult> => ({ isCorrect: true, correctAnswer: 'A' }));
    render(
      <div role="dialog" aria-modal="true" tabIndex={-1} data-testid="redo-modal">
        {editor(onSubmitAnswer)}
      </div>,
    );

    const modal = screen.getByTestId('redo-modal');
    fireEvent.keyDown(modal, { key: '1' });
    fireEvent.keyDown(modal, { key: 'Enter' });

    await waitFor(() => expect(onSubmitAnswer).toHaveBeenCalledWith('q1', 'A', 'single_choice'));
  });

  it('ignores keys pressed inside a modal it is not part of', async () => {
    const onSubmitAnswer = vi.fn(async (): Promise<SubmitResult> => ({ isCorrect: true, correctAnswer: 'A' }));
    render(
      <>
        {editor(onSubmitAnswer)}
        <div role="dialog" aria-modal="true">
          <span tabIndex={-1} data-testid="other-modal-target">x</span>
        </div>
      </>,
    );

    const target = screen.getByTestId('other-modal-target');
    fireEvent.keyDown(target, { key: '1' });
    fireEvent.keyDown(target, { key: 'Enter' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSubmitAnswer).not.toHaveBeenCalled();
  });
});
