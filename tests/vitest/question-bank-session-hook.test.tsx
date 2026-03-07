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
});
