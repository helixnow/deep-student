import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePracticeRequestScope } from '@/components/practice/usePracticeRequestScope';
import { useQuestionBankStore, type CheckInCalendar, type MockExamConfig, type MockExamScoreCard, type MockExamSession } from '@/stores/questionBankStore';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

const config: MockExamConfig = {
  duration_minutes: 30, total_count: 5, type_distribution: {},
  difficulty_distribution: {}, shuffle: false, include_mistakes: false,
};

function session(id: string, examId = 'exam-a'): MockExamSession {
  return {
    id, exam_id: examId, config, question_ids: ['q-1'],
    started_at: '2026-09-16T00:00:00Z', answers: {}, results: {}, is_submitted: false,
  };
}

function scoreCard(value: MockExamSession): MockExamScoreCard {
  return {
    session_id: value.id, exam_id: value.exam_id, total_count: 1, answered_count: 0,
    correct_count: 0, wrong_count: 0, unanswered_count: 1, correct_rate: 0,
    time_spent_seconds: 0, type_stats: {}, difficulty_stats: {}, wrong_question_ids: [],
    comment: '', completed_at: '2026-09-16T00:30:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('practice request ownership', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    const store = useQuestionBankStore.getState();
    store.setTimedSession(null);
    store.setMockExamSession(null);
    store.setDailyPractice(null);
    store.setGeneratedPaper(null);
    useQuestionBankStore.setState({ error: null, checkInCalendar: null });
  });

  it('keeps the latest generated exam when an earlier response arrives last', async () => {
    const first = deferred<MockExamSession>();
    const second = deferred<MockExamSession>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldRequest = useQuestionBankStore.getState().generateMockExam('exam-a', config);
    const newRequest = useQuestionBankStore.getState().generateMockExam('exam-b', config);
    const current = session('new', 'exam-b');
    second.resolve(current);
    await newRequest;
    first.resolve(session('old'));
    await oldRequest;
    expect(useQuestionBankStore.getState().mockExamSession).toBe(current);
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('does not restore a submitted exam after another exam replaces it', async () => {
    const old = session('old');
    const current = session('current');
    useQuestionBankStore.getState().setMockExamSession(old);
    const pending = deferred<MockExamScoreCard>();
    invokeMock.mockReturnValueOnce(pending.promise);
    const request = useQuestionBankStore.getState().submitMockExam(old);
    useQuestionBankStore.getState().setMockExamSession(current);
    pending.resolve(scoreCard(old));
    await request;
    expect(useQuestionBankStore.getState().mockExamSession).toBe(current);
    expect(useQuestionBankStore.getState().mockExamScoreCard).toBeNull();
  });

  it('does not release a newer generation request or publish an old submission error', async () => {
    const old = session('old');
    useQuestionBankStore.getState().setMockExamSession(old);
    const submission = deferred<MockExamScoreCard>();
    const generation = deferred<MockExamSession>();
    invokeMock.mockReturnValueOnce(submission.promise).mockReturnValueOnce(generation.promise);
    const submit = useQuestionBankStore.getState().submitMockExam(old);
    const rejected = expect(submit).rejects.toThrow('old submission failed');
    const generate = useQuestionBankStore.getState().generateMockExam('exam-b', config);
    submission.reject(new Error('old submission failed'));
    await rejected;
    expect(useQuestionBankStore.getState().error).toBeNull();
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(true);
    generation.resolve(session('new', 'exam-b'));
    await generate;
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('keeps loading active until independent practice requests finish', async () => {
    const generation = deferred<MockExamSession>();
    const calendar = deferred<CheckInCalendar>();
    invokeMock.mockReturnValueOnce(generation.promise).mockReturnValueOnce(calendar.promise);
    const generate = useQuestionBankStore.getState().generateMockExam('exam-a', config);
    const loadCalendar = useQuestionBankStore.getState().getCheckInCalendar('exam-a', 2026, 9);
    calendar.resolve({
      exam_id: 'exam-a', year: 2026, month: 9, days: [],
      streak_days: 0, month_check_in_days: 0, month_total_questions: 0,
    });
    await loadCalendar;
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(true);
    generation.resolve(session('new'));
    await generate;
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('invalidates generation when the session is explicitly cleared', async () => {
    const generation = deferred<MockExamSession>();
    invokeMock.mockReturnValueOnce(generation.promise);
    const request = useQuestionBankStore.getState().generateMockExam('exam-a', config);
    useQuestionBankStore.getState().setMockExamSession(null);
    generation.resolve(session('old'));
    await request;
    expect(useQuestionBankStore.getState().mockExamSession).toBeNull();
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('clears the previous score when a new exam in the same bank is generated', async () => {
    const old = session('old');
    useQuestionBankStore.setState({ mockExamSession: old, mockExamScoreCard: scoreCard(old) });
    const current = session('new');
    invokeMock.mockResolvedValueOnce(current);
    await useQuestionBankStore.getState().generateMockExam('exam-a', config);
    expect(useQuestionBankStore.getState().mockExamSession).toBe(current);
    expect(useQuestionBankStore.getState().mockExamScoreCard).toBeNull();
  });

  it('keeps a timed start pending when progress changes in the previous session', async () => {
    const old = {
      id: 'old', exam_id: 'exam-a', duration_minutes: 10, question_count: 1,
      question_ids: ['q-1'], started_at: '2026-09-16T00:00:00Z',
      answered_count: 0, correct_count: 0, is_timeout: false, is_submitted: false,
      paused_seconds: 0, is_paused: false,
    };
    useQuestionBankStore.getState().setTimedSession(old);
    const pending = deferred<typeof old>();
    invokeMock.mockReturnValueOnce(pending.promise);
    const start = useQuestionBankStore.getState().startTimedPractice('exam-a', 10, 1);
    useQuestionBankStore.getState().setTimedSession({ ...old, paused_seconds: 5 });
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(true);
    const current = { ...old, id: 'new' };
    pending.resolve(current);
    await start;
    expect(useQuestionBankStore.getState().timedSession).toBe(current);
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('shares one submission between concurrent callers', async () => {
    const active = session('shared');
    useQuestionBankStore.getState().setMockExamSession(active);
    const pending = deferred<MockExamScoreCard>();
    invokeMock.mockReturnValueOnce(pending.promise);
    const first = useQuestionBankStore.getState().submitMockExam(active);
    const second = useQuestionBankStore.getState().submitMockExam({ ...active, is_submitted: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const card = scoreCard(active);
    pending.resolve(card);
    expect(await first).toBe(card);
    expect(await second).toBe(card);
    expect(useQuestionBankStore.getState().mockExamScoreCard).toBe(card);
  });

  it('reuses an accepted score instead of submitting a completed exam again', async () => {
    const active = session('completed');
    const card = scoreCard(active);
    useQuestionBankStore.setState({ mockExamSession: { ...active, is_submitted: true }, mockExamScoreCard: card });
    expect(await useQuestionBankStore.getState().submitMockExam(active)).toBe(card);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not let an old exam submission replace a pending generation', async () => {
    const old = session('old');
    useQuestionBankStore.getState().setMockExamSession(old);
    const generation = deferred<MockExamSession>();
    const submission = deferred<MockExamScoreCard>();
    invokeMock.mockReturnValueOnce(generation.promise).mockReturnValueOnce(submission.promise);
    const generate = useQuestionBankStore.getState().generateMockExam('exam-b', config);
    const submit = useQuestionBankStore.getState().submitMockExam(old);
    submission.resolve(scoreCard(old));
    await submit;
    expect(useQuestionBankStore.getState().mockExamSession).toBe(old);
    expect(useQuestionBankStore.getState().mockExamScoreCard).toBeNull();
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(true);
    const current = session('new', 'exam-b');
    generation.resolve(current);
    await generate;
    expect(useQuestionBankStore.getState().mockExamSession).toBe(current);
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('releases the submission lock even when IPC throws synchronously', async () => {
    const active = session('retry');
    useQuestionBankStore.getState().setMockExamSession(active);
    invokeMock.mockImplementationOnce(() => { throw new Error('IPC unavailable'); });
    await expect(useQuestionBankStore.getState().submitMockExam(active)).rejects.toThrow('IPC unavailable');
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
    const card = scoreCard(active);
    invokeMock.mockResolvedValueOnce(card);
    expect(await useQuestionBankStore.getState().submitMockExam(active)).toBe(card);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useQuestionBankStore.getState().mockExamScoreCard).toBe(card);
  });

  it('preserves the newest error when an older request in another lane fails', async () => {
    const calendar = deferred<CheckInCalendar>();
    const generation = deferred<MockExamSession>();
    invokeMock.mockReturnValueOnce(calendar.promise).mockReturnValueOnce(generation.promise);
    const loadCalendar = useQuestionBankStore.getState().getCheckInCalendar('exam-a', 2026, 9);
    const oldFailure = expect(loadCalendar).rejects.toThrow('calendar failed');
    const generate = useQuestionBankStore.getState().generateMockExam('exam-b', config);
    const newFailure = expect(generate).rejects.toThrow('generation failed');
    generation.reject(new Error('generation failed'));
    await newFailure;
    calendar.reject(new Error('calendar failed'));
    await oldFailure;
    expect(useQuestionBankStore.getState().error).toBe('Error: generation failed');
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('preserves a generation failure when an old submission starts during generation', async () => {
    const old = session('old');
    useQuestionBankStore.getState().setMockExamSession(old);
    const generation = deferred<MockExamSession>();
    const submission = deferred<MockExamScoreCard>();
    invokeMock.mockReturnValueOnce(generation.promise).mockReturnValueOnce(submission.promise);
    const generate = useQuestionBankStore.getState().generateMockExam('exam-b', config);
    const generationFailure = expect(generate).rejects.toThrow('generation failed');
    const submit = useQuestionBankStore.getState().submitMockExam(old);
    const submissionFailure = expect(submit).rejects.toThrow('submission failed');
    generation.reject(new Error('generation failed'));
    await generationFailure;
    submission.reject(new Error('submission failed'));
    await submissionFailure;
    expect(useQuestionBankStore.getState().error).toBe('Error: generation failed');
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });

  it('invalidates a request after switching away and back to the same bank', () => {
    const { result, rerender, unmount } = renderHook(
      ({ examId }) => usePracticeRequestScope(examId),
      { initialProps: { examId: 'exam-a' } },
    );
    const old = result.current();
    rerender({ examId: 'exam-b' });
    rerender({ examId: 'exam-a' });
    expect(old()).toBe(false);
    const current = result.current();
    expect(current()).toBe(true);
    unmount();
    expect(current()).toBe(false);
  });

  it('invalidates an earlier request within the same mounted view', () => {
    const { result } = renderHook(() => usePracticeRequestScope('exam-a'));
    const first = result.current();
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
