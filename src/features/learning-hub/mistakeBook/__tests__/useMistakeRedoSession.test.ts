import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/debug-panel/plugins/ExamSheetProcessingDebugPlugin', () => ({ emitExamSheetDebug: vi.fn() }));

import { getPracticeSessionKey, useQuestionBankStore } from '@/stores/questionBankStore';
import { MISTAKE_REDO_SESSION_KEY, useMistakeRedoSession } from '../useMistakeRedoSession';

function storeQuestion(id: string, examId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    exam_id: examId,
    card_id: `card_${id}`,
    question_label: id.toUpperCase(),
    content: `题干 ${id}`,
    question_type: 'single_choice',
    options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }],
    answer: 'A',
    explanation: '',
    difficulty: 'easy',
    tags: [],
    status: 'review',
    user_answer: 'B',
    is_correct: false,
    user_note: '',
    attempt_count: 1,
    correct_count: 0,
    last_attempt_at: null,
    is_favorite: false,
    images: [],
    ...overrides,
  };
}

const questionsById: Record<string, ReturnType<typeof storeQuestion> | null> = {
  q1: storeQuestion('q1', 'exam-a'),
  q2: null,
  q3: storeQuestion('q3', 'exam-b'),
};

function routeInvoke() {
  mockInvoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    if (command === 'qbank_get_question') return questionsById[args.questionId] ?? null;
    if (command === 'qbank_submit_answer') {
      const { question_id: id, user_answer: answer, is_correct_override: override } = args.request;
      const correct = override ?? answer === 'A';
      return {
        is_correct: correct,
        correct_answer: 'A',
        needs_manual_grading: false,
        message: correct ? '回答正确！' : '回答错误',
        submission_id: `sub_${id}_${mockInvoke.mock.calls.length}`,
        updated_question: storeQuestion(id, id === 'q1' ? 'exam-a' : 'exam-b', {
          user_answer: answer,
          is_correct: correct,
          status: correct ? 'in_progress' : 'review',
        }),
      };
    }
    throw new Error(`unexpected ${command}`);
  });
}

describe('useMistakeRedoSession', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    routeInvoke();
  });

  it('loads the picked mistakes by id across question sets and skips deleted ones', async () => {
    const { result } = renderHook(() => useMistakeRedoSession(['q1', 'q2', 'q3']));

    await waitFor(() => expect(result.current.phase).toEqual({ kind: 'ready' }));
    expect(result.current.questions.map((q) => q.id)).toEqual(['q1', 'q3']);
    expect(result.current.missing).toBe(1);
    expect(result.current.currentExamId).toBe('exam-a');

    act(() => result.current.navigate(1));
    expect(result.current.currentExamId).toBe('exam-b');

    const key = getPracticeSessionKey(result.current.owner)!;
    expect(result.current.owner.examId).toBe(MISTAKE_REDO_SESSION_KEY);
    expect(useQuestionBankStore.getState().practiceSessions[key]?.questionIds).toEqual(['q1', 'q3']);
  });

  it('writes answers back to the original question and regrades the same submission on self-grading', async () => {
    const { result } = renderHook(() => useMistakeRedoSession(['q1', 'q3']));
    await waitFor(() => expect(result.current.phase.kind).toBe('ready'));

    // 编辑器会把题型当第三个参数传进来：不能被当成改判标记
    const submit = result.current.submitAnswer as (id: string, answer: string, type?: string) => Promise<unknown>;
    let outcome: unknown;
    await act(async () => {
      outcome = await submit('q1', 'A', 'single_choice');
    });
    expect(outcome).toMatchObject({ isCorrect: true, correctAnswer: 'A', needsManualGrading: false });
    const firstRequest = mockInvoke.mock.calls.find(([command]) => command === 'qbank_submit_answer')![1].request;
    expect(firstRequest).toMatchObject({ question_id: 'q1', user_answer: 'A', regrade_submission_id: null });
    expect(firstRequest.is_correct_override).toBeUndefined();
    expect(result.current.questions[0]).toMatchObject({ status: 'in_progress', userAnswer: 'A' });

    await act(async () => {
      await result.current.markCorrect('q1', false);
    });
    const submits = mockInvoke.mock.calls.filter(([command]) => command === 'qbank_submit_answer');
    expect(submits[1][1].request).toMatchObject({
      question_id: 'q1',
      user_answer: 'A',
      is_correct_override: false,
      regrade_submission_id: (outcome as { submissionId: string }).submissionId,
    });
  });

  it('reports a load error when no question could be fetched', async () => {
    mockInvoke.mockRejectedValue(new Error('db locked'));
    const { result } = renderHook(() => useMistakeRedoSession(['q1', 'q3']));

    await waitFor(() => expect(result.current.phase).toEqual({ kind: 'error', message: 'db locked' }));
  });

  it('is empty when every picked question has been deleted', async () => {
    const { result } = renderHook(() => useMistakeRedoSession(['q2']));

    await waitFor(() => expect(result.current.phase).toEqual({ kind: 'empty' }));
    expect(result.current.missing).toBe(1);
  });
});
