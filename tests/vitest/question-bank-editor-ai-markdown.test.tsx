import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { QuestionBankEditor } from '@/components/QuestionBankEditor';
import type { Question, SubmitResult } from '@/api/questionBankApi';
import {
  useQuestionBankStore,
  type PracticeSessionOwner,
} from '@/stores/questionBankStore';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
  // DsDialog 等共享组件直接消费 useIsMobile/useIsTablet，模块级 mock 需补齐
  useIsMobile: () => false,
  useIsTablet: () => false,
}));

vi.mock('@/hooks/useQbankAiGrading', () => {
  // ⚠️ 回调必须在工厂里创建一次并复用：真实 hook 返回稳定的 useCallback 引用，
  // 组件把 resetState 放进了切题 effect 的依赖。若每次渲染都返回新的 vi.fn()，
  // effect 会无限重跑（setSelectedOptions(new Set()) 等新身份 setState → 再渲染），
  // 表现为整个测试文件挂起、fork 100% CPU（R3-react-swc §4 记录的挂起即此因）。
  const resetState = vi.fn();
  const startGrading = vi.fn();
  const retryGrading = vi.fn();
  const cancelGrading = vi.fn();
  return {
    useQbankAiGrading: () => ({
      state: {
        isGrading: false,
        feedback: '',
        verdict: null,
        score: null,
        error: null,
      },
      resetState,
      startGrading,
      retryGrading,
      cancelGrading,
    }),
  };
});

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
    const practiceSessionOwner: PracticeSessionOwner = {
      examId: 'session-1',
      viewInstanceId: 'markdown-test-view',
    };
    useQuestionBankStore.setState({ practiceSessions: {} });
    useQuestionBankStore.getState().ensurePracticeSession(practiceSessionOwner, ['q1']);

    render(
      <QuestionBankEditor
        sessionId="session-1"
        practiceSessionOwner={practiceSessionOwner}
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
