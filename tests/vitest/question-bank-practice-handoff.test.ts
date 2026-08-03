import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  useQuestionBankStore,
  validateQbankPracticeHandoff,
} from '@/stores/questionBankStore';

const startedAt = '2026-07-14T08:00:00.000Z';

function base(mode: 'timed' | 'mock_exam' | 'daily', session: Record<string, unknown>) {
  const handoffId = typeof session.id === 'string' ? session.id : session.date;
  return {
    version: 1,
    kind: 'qbank_practice_session',
    handoff_id: handoffId,
    exam_id: 'exam-1',
    mode,
    session,
    agentCanAnswer: false,
  };
}

const timed = () => base('timed', {
  id: 'timed-1',
  exam_id: 'exam-1',
  duration_minutes: 30,
  question_count: 2,
  question_ids: ['q-1', 'q-2'],
  started_at: startedAt,
  ended_at: null,
  answered_count: 0,
  correct_count: 0,
  is_timeout: false,
  is_submitted: false,
  paused_seconds: 0,
  is_paused: false,
});

const mockExam = () => base('mock_exam', {
  id: 'mock-1',
  exam_id: 'exam-1',
  config: {
    duration_minutes: 60,
    type_distribution: {},
    difficulty_distribution: {},
    total_count: 2,
    shuffle: true,
    include_mistakes: true,
    tags: null,
  },
  question_ids: ['q-1', 'q-2'],
  started_at: startedAt,
  ended_at: null,
  answers: {},
  results: {},
  is_submitted: false,
  score: null,
  correct_rate: null,
});

const daily = () => base('daily', {
  date: '2026-07-14',
  exam_id: 'exam-1',
  question_ids: ['q-1', 'q-2'],
  daily_target: 2,
  completed_count: 0,
  correct_count: 0,
  source_distribution: { mistake_count: 1, new_count: 1, review_count: 0 },
  is_completed: false,
});

describe('qbank practice handoff hydration', () => {
  beforeEach(() => {
    useQuestionBankStore.setState({
      currentExamId: null,
      currentQuestionId: null,
      practiceMode: 'sequential',
      timedSession: null,
      mockExamSession: null,
      dailyPractice: null,
      mockExamScoreCard: null,
      error: null,
    });
  });

  it.each([
    ['timed', timed, 'timedSession'],
    ['mock_exam', mockExam, 'mockExamSession'],
    ['daily', daily, 'dailyPractice'],
  ] as const)('hydrates a backend-created %s handoff into the existing store', (
    mode,
    fixture,
    stateKey,
  ) => {
    const result = useQuestionBankStore
      .getState()
      .hydratePracticeHandoff(fixture(), 'exam-1');

    expect(result).toMatchObject({
      ok: true,
      mode,
      firstQuestionId: 'q-1',
      questionCount: 2,
    });
    expect(useQuestionBankStore.getState()).toMatchObject({
      currentExamId: 'exam-1',
      practiceMode: mode,
      [stateKey]: expect.objectContaining({ exam_id: 'exam-1' }),
    });
  });

  it('rejects a handoff for another exam without mutating the active session', () => {
    const result = useQuestionBankStore
      .getState()
      .hydratePracticeHandoff(timed(), 'exam-2');

    expect(result).toMatchObject({
      ok: false,
      code: 'PRACTICE_HANDOFF_EXAM_MISMATCH',
    });
    expect(useQuestionBankStore.getState().timedSession).toBeNull();
    expect(useQuestionBankStore.getState().practiceMode).toBe('sequential');
  });

  it('rejects duplicate question ids and any Agent-prefilled mock answer', () => {
    const duplicate = timed();
    duplicate.session.question_ids = ['q-1', 'q-1'];
    expect(validateQbankPracticeHandoff(duplicate, 'exam-1')).toMatchObject({
      ok: false,
      code: 'INVALID_PRACTICE_HANDOFF',
    });

    const prefilled = mockExam();
    prefilled.session.answers = { 'q-1': 'A' };
    prefilled.session.results = { 'q-1': true };
    expect(validateQbankPracticeHandoff(prefilled, 'exam-1')).toMatchObject({
      ok: false,
      code: 'INVALID_PRACTICE_HANDOFF',
    });
    expect(useQuestionBankStore.getState().mockExamSession).toBeNull();
  });
});
