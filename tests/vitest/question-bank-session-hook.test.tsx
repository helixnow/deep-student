import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/debug-panel/plugins/ExamSheetProcessingDebugPlugin', () => ({
  emitExamSheetDebug: vi.fn(),
}));

import { useQuestionBankSession } from '@/hooks/useQuestionBankSession';
import {
  getPracticeSessionKey,
  useQuestionBankStore,
} from '@/stores/questionBankStore';

function makeStoreQuestion(id: string, content: string) {
  return {
    id,
    card_id: `card_${id}`,
    question_label: id.toUpperCase(),
    content,
    question_type: 'single_choice',
    options: [],
    answer: 'A',
    explanation: `${content} explanation`,
    difficulty: 'easy',
    tags: ['tag-1'],
    status: 'new',
    user_answer: '',
    is_correct: null,
    user_note: '',
    attempt_count: 0,
    correct_count: 0,
    last_attempt_at: null,
    is_favorite: false,
    images: [],
    ai_feedback: null,
    ai_score: null,
    ai_graded_at: null,
  };
}

function makeStats(correctRate = 0) {
  return {
    total_count: 2,
    mastered_count: 0,
    review_count: 0,
    in_progress_count: 0,
    new_count: 2,
    correct_rate: correctRate,
  };
}

describe('useQuestionBankSession', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useQuestionBankStore.setState({ practiceSessions: {} });
  });

  it('gives two kept-alive hook instances independent practice-session shards', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_get_stats') return makeStats();
      if (command === 'qbank_list_questions') {
        return {
          questions: [makeStoreQuestion('q1', 'shared question')],
          total: 1,
          page: 1,
          page_size: 50,
          has_more: false,
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => ({
      left: useQuestionBankSession({ examId: 'exam_shared' }),
      right: useQuestionBankSession({ examId: 'exam_shared' }),
    }));

    await waitFor(() => {
      expect(result.current.left.questions).toHaveLength(1);
      expect(result.current.right.questions).toHaveLength(1);
    });

    const leftOwner = result.current.left.practiceSessionOwner!;
    const rightOwner = result.current.right.practiceSessionOwner!;
    expect(leftOwner.examId).toBe('exam_shared');
    expect(rightOwner.examId).toBe('exam_shared');
    expect(leftOwner.viewInstanceId).not.toBe(rightOwner.viewInstanceId);

    act(() => {
      useQuestionBankStore.getState().recordPracticeSessionAnswer(leftOwner, 'q1', true);
    });

    const left = useQuestionBankStore.getState().practiceSessions[getPracticeSessionKey(leftOwner)!];
    const right = useQuestionBankStore.getState().practiceSessions[getPracticeSessionKey(rightOwner)!];
    expect(left.answeredIds).toEqual(['q1']);
    expect(left.streakCount).toBe(1);
    expect(right.answeredIds).toEqual([]);
    expect(right.streakCount).toBe(0);
  });

  it('initial load fetches all pages instead of only the first page', async () => {
    mockInvoke.mockImplementation(async (command: string, payload?: any) => {
      if (command === 'qbank_get_stats') return makeStats();
      if (command === 'qbank_list_questions' && payload?.request?.page === 1) {
        return {
          questions: [makeStoreQuestion('q1', 'first question')],
          total: 2,
          page: 1,
          page_size: 50,
          has_more: true,
        };
      }
      if (command === 'qbank_list_questions' && payload?.request?.page === 2) {
        return {
          questions: [makeStoreQuestion('q2', 'second question')],
          total: 2,
          page: 2,
          page_size: 50,
          has_more: false,
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useQuestionBankSession({ examId: 'exam_1' }));

    await waitFor(() => {
      expect(result.current.questions).toHaveLength(2);
    });

    expect(result.current.questions.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === 'qbank_list_questions')
    ).toHaveLength(2);
  });

  it('keeps the current question selection after reload when that question still exists', async () => {
    let phase: 'initial' | 'reload' = 'initial';

    mockInvoke.mockImplementation(async (command: string, payload?: any) => {
      if (command === 'qbank_get_stats') return makeStats();

      if (command === 'qbank_list_questions' && payload?.request?.page === 1) {
        return {
          questions: [makeStoreQuestion('q1', phase === 'initial' ? 'first question' : 'first question updated')],
          total: 2,
          page: 1,
          page_size: 50,
          has_more: true,
        };
      }

      if (command === 'qbank_list_questions' && payload?.request?.page === 2) {
        return {
          questions: [makeStoreQuestion('q2', phase === 'initial' ? 'second question' : 'second question updated')],
          total: 2,
          page: 2,
          page_size: 50,
          has_more: false,
        };
      }

      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useQuestionBankSession({ examId: 'exam_1' }));

    await waitFor(() => {
      expect(result.current.questions).toHaveLength(2);
    });

    act(() => {
      result.current.navigate(1);
    });

    expect(result.current.currentQuestion?.id).toBe('q2');
    expect(result.current.currentIndex).toBe(1);

    phase = 'reload';

    await act(async () => {
      await result.current.loadQuestions();
    });

    await waitFor(() => {
      expect(result.current.currentQuestion?.id).toBe('q2');
      expect(result.current.currentQuestion?.content).toBe('second question updated');
      expect(result.current.currentIndex).toBe(1);
    });
  });

  it('refreshQuestion updates the local question cache and synced stats', async () => {
    const refreshedQuestion = makeStoreQuestion('q2', 'second question refreshed');
    const refreshedStats = makeStats(0.75);

    mockInvoke.mockImplementation(async (command: string, payload?: any) => {
      if (command === 'qbank_get_stats') return refreshedStats;
      if (command === 'qbank_refresh_stats') return refreshedStats;

      if (command === 'qbank_list_questions' && payload?.request?.page === 1) {
        return {
          questions: [makeStoreQuestion('q1', 'first question')],
          total: 2,
          page: 1,
          page_size: 50,
          has_more: true,
        };
      }

      if (command === 'qbank_list_questions' && payload?.request?.page === 2) {
        return {
          questions: [makeStoreQuestion('q2', 'second question')],
          total: 2,
          page: 2,
          page_size: 50,
          has_more: false,
        };
      }

      if (command === 'qbank_get_question' && payload?.questionId === 'q2') {
        return refreshedQuestion;
      }

      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useQuestionBankSession({ examId: 'exam_1' }));

    await waitFor(() => {
      expect(result.current.questions).toHaveLength(2);
    });

    await act(async () => {
      await result.current.refreshQuestion('q2');
    });

    await waitFor(() => {
      const refreshed = result.current.questions.find((question) => question.id === 'q2');
      expect(refreshed?.content).toBe('second question refreshed');
      expect(result.current.stats?.correctRate).toBe(0.75);
    });
  });

  // 2026-08 修复回归：自评（我答对了/我答错了）必须对最近一次提交改判，
  // 而不是新插作答记录把 attempt_count 双计。
  it('markCorrect regrades the latest submission instead of resubmitting', async () => {
    const submitPayloads: any[] = [];

    mockInvoke.mockImplementation(async (command: string, payload?: any) => {
      if (command === 'qbank_get_stats') return makeStats();
      if (command === 'qbank_list_questions') {
        return {
          questions: [{ ...makeStoreQuestion('q1', 'subjective question'), question_type: 'short_answer' }],
          total: 1,
          page: 1,
          page_size: 50,
          has_more: false,
        };
      }
      if (command === 'qbank_submit_answer') {
        submitPayloads.push(payload?.request);
        const graded = submitPayloads.length > 1;
        return {
          is_correct: graded ? true : null,
          correct_answer: 'reference',
          needs_manual_grading: !graded,
          message: graded ? '回答正确！' : '需要手动批改',
          updated_question: {
            ...makeStoreQuestion('q1', 'subjective question'),
            user_answer: 'my essay',
            attempt_count: 1,
          },
          updated_stats: makeStats(),
          submission_id: 'sub-1',
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result } = renderHook(() => useQuestionBankSession({ examId: 'exam_1' }));
    await waitFor(() => {
      expect(result.current.questions).toHaveLength(1);
    });

    // 首次提交：非改判路径，不带 regrade_submission_id
    await act(async () => {
      await result.current.submitAnswer('q1', 'my essay');
    });
    expect(submitPayloads[0].is_correct_override).toBeUndefined();
    expect(submitPayloads[0].regrade_submission_id).toBeNull();

    // 自评：携带最近一次提交 id，后端据此改判该提交
    await act(async () => {
      await result.current.markCorrect('q1', true);
    });
    expect(submitPayloads[1]).toMatchObject({
      question_id: 'q1',
      is_correct_override: true,
      regrade_submission_id: 'sub-1',
    });

    // 反悔换判：改判返回同一 submission_id，再次自评仍指向同一条提交
    await act(async () => {
      await result.current.markCorrect('q1', false);
    });
    expect(submitPayloads[2]).toMatchObject({
      is_correct_override: false,
      regrade_submission_id: 'sub-1',
    });
  });

  it('releases submission state on exam changes without unlocking a newer submission', async () => {
    const oldResponse = {
      is_correct: true, correct_answer: 'A', needs_manual_grading: false,
      message: 'correct', submission_id: 'sub-old',
      updated_question: makeStoreQuestion('q-old', 'old question'), updated_stats: makeStats(),
    };
    const newResponse = {
      ...oldResponse, submission_id: 'sub-new',
      updated_question: makeStoreQuestion('q-new', 'new question'),
    };
    let finishOld!: (value: typeof oldResponse) => void;
    let finishNew!: (value: typeof newResponse) => void;
    const oldRequest = new Promise<typeof oldResponse>((resolve) => { finishOld = resolve; });
    const newRequest = new Promise<typeof newResponse>((resolve) => { finishNew = resolve; });

    mockInvoke.mockImplementation((command: string, payload?: {
      request?: { exam_id?: string; question_id?: string };
    }) => {
      if (command === 'qbank_get_stats') return Promise.resolve(makeStats());
      if (command === 'qbank_list_questions') {
        const id = payload?.request?.exam_id === 'exam-old' ? 'q-old' : 'q-new';
        return Promise.resolve({
          questions: [makeStoreQuestion(id, id)], total: 1,
          page: 1, page_size: 50, has_more: false,
        });
      }
      if (command === 'qbank_submit_answer') {
        return payload?.request?.question_id === 'q-old' ? oldRequest : newRequest;
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result, rerender } = renderHook(
      ({ examId }) => useQuestionBankSession({ examId }),
      { initialProps: { examId: 'exam-old' } },
    );
    await waitFor(() => expect(result.current.questions[0]?.id).toBe('q-old'));
    let oldCompletion = Promise.resolve('');
    act(() => {
      oldCompletion = result.current.submitAnswer('q-old', 'A').then(
        () => 'unexpected success', (error: unknown) => String(error),
      );
    });
    expect(result.current.isSubmitting).toBe(true);

    rerender({ examId: 'exam-new' });
    await waitFor(() => expect(result.current.questions[0]?.id).toBe('q-new'));
    expect(result.current.isSubmitting).toBe(false);
    let newCompletion: Promise<unknown> = Promise.resolve();
    act(() => { newCompletion = result.current.submitAnswer('q-new', 'A'); });
    expect(result.current.isSubmitting).toBe(true);

    await act(async () => {
      finishOld(oldResponse);
      expect(await oldCompletion).toContain('Session changed');
    });
    expect(result.current.isSubmitting).toBe(true);
    expect(result.current.questions[0]?.id).toBe('q-new');
    await expect(result.current.submitAnswer('q-new', 'A')).rejects.toThrow('Submission already in flight');

    await act(async () => { finishNew(newResponse); await newCompletion; });
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('drops a stale favorite toggle that resolves after the exam changed', async () => {
    let finishToggle!: (value: unknown) => void;
    const toggleRequest = new Promise((resolve) => { finishToggle = resolve; });

    mockInvoke.mockImplementation((command: string, payload?: {
      request?: { exam_id?: string };
    }) => {
      if (command === 'qbank_get_stats') return Promise.resolve(makeStats());
      if (command === 'qbank_list_questions') {
        const id = payload?.request?.exam_id === 'exam-old' ? 'q-old' : 'q-new';
        return Promise.resolve({
          questions: [makeStoreQuestion(id, id)], total: 1,
          page: 1, page_size: 50, has_more: false,
        });
      }
      if (command === 'qbank_toggle_favorite') return toggleRequest;
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { result, rerender } = renderHook(
      ({ examId }) => useQuestionBankSession({ examId }),
      { initialProps: { examId: 'exam-old' } },
    );
    await waitFor(() => expect(result.current.questions[0]?.id).toBe('q-old'));
    let toggleCompletion: Promise<void> = Promise.resolve();
    act(() => { toggleCompletion = result.current.toggleFavorite('q-old'); });

    rerender({ examId: 'exam-new' });
    await waitFor(() => expect(result.current.questions[0]?.id).toBe('q-new'));

    await act(async () => {
      finishToggle({ ...makeStoreQuestion('q-old', 'q-old'), is_favorite: true });
      await toggleCompletion;
    });

    expect(result.current.questions.map((question) => question.id)).toEqual(['q-new']);
    expect(result.current.currentQuestion?.id).toBe('q-new');
  });
});
