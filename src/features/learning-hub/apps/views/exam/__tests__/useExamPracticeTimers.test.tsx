import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  useExamPracticeTimers,
  type UseExamPracticeTimersOptions,
} from '../useExamPracticeTimers';

type StoreState = ReturnType<typeof useQuestionBankStore.getState>;

function createTimedSession(
  overrides: Partial<NonNullable<StoreState['timedSession']>> = {},
): NonNullable<StoreState['timedSession']> {
  return {
    id: 'timed-1',
    exam_id: 'exam-1',
    duration_minutes: 1,
    question_ids: ['q1'],
    started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ended_at: null,
    paused_seconds: 0,
    completed_count: 0,
    correct_count: 0,
    is_submitted: false,
    is_timeout: false,
    ...overrides,
  } as NonNullable<StoreState['timedSession']>;
}

function createMockExamSession(
  overrides: Partial<NonNullable<StoreState['mockExamSession']>> = {},
): NonNullable<StoreState['mockExamSession']> {
  return {
    id: 'mock-1',
    exam_id: 'exam-1',
    config: {
      duration_minutes: 1,
      question_count: 1,
      shuffle: false,
    },
    question_ids: ['q1'],
    answers: {},
    results: {},
    started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ended_at: null,
    is_submitted: false,
    ...overrides,
  } as NonNullable<StoreState['mockExamSession']>;
}

function makeBaseOptions(
  overrides: Partial<UseExamPracticeTimersOptions> = {},
): UseExamPracticeTimersOptions {
  const sessionScope = overrides.sessionScope ?? { sessionId: 'exam-1' };
  return {
    sessionId: 'exam-1',
    sessionScope,
    latestSessionScopeRef: { current: sessionScope },
    viewMode: 'practice',
    practiceMode: 'sequential',
    gradingMode: 'immediate',
    isActive: true,
    activeTimedSession: null,
    activeMockExamSession: null,
    activeDailyPractice: null,
    setTimedSession: vi.fn(),
    submitMockExam: vi.fn(async () => ({}) as never),
    switchViewMode: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  notifyMock.mockReset();
  useQuestionBankStore.setState({
    mockExamSession: null,
    mockExamScoreCard: null,
    timedSession: null,
    dailyPractice: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useExamPracticeTimers', () => {
  it('ticks standard stopwatch in immediate practice mode, pauses on inactive tab and toggleTimer', () => {
    const initialProps = makeBaseOptions();
    const { result, rerender } = renderHook(
      (props: UseExamPracticeTimersOptions) => useExamPracticeTimers(props),
      { initialProps },
    );

    expect(result.current.isTimerRunning).toBe(true);
    expect(result.current.isAdvancedRuntimeTimer).toBe(false);
    expect(result.current.advancedTimerRemaining).toBeNull();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.elapsedTime).toBe(3);

    // Pausing when tab becomes inactive stops standard stopwatch
    rerender({ ...initialProps, isActive: false });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.elapsedTime).toBe(3);

    // Resuming active tab and toggling off manually
    rerender({ ...initialProps, isActive: true });
    act(() => {
      result.current.toggleTimer();
    });
    expect(result.current.isTimerRunning).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.elapsedTime).toBe(3);
  });

  it('does not tick in on_submit grading mode and resets elapsedTime on sessionId change', () => {
    const base = makeBaseOptions({ gradingMode: 'on_submit' });
    const { result, rerender } = renderHook(
      (props: UseExamPracticeTimersOptions) => useExamPracticeTimers(props),
      { initialProps: base },
    );

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.elapsedTime).toBe(0);
    expect(result.current.activeAdvancedTimerDuration).toBeNull();

    rerender({ ...base, gradingMode: 'immediate' });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.elapsedTime).toBe(2);

    rerender({ ...base, gradingMode: 'immediate', sessionId: 'exam-2' });
    expect(result.current.elapsedTime).toBe(0);
  });

  it('compensates paused_seconds for timed practice and auto-ends on timeout', () => {
    // 1 min duration + 20s paused => deadline is at 80s from 00:00:00
    vi.setSystemTime(new Date('2026-01-01T00:00:50.000Z'));
    const timed = createTimedSession({ duration_minutes: 1, paused_seconds: 20 });
    const setTimedSession = vi.fn();
    const switchViewMode = vi.fn();

    const { result } = renderHook(() =>
      useExamPracticeTimers(
        makeBaseOptions({
          practiceMode: 'timed',
          activeTimedSession: timed,
          isActive: false, // Wall clock must keep ticking even when backgrounded
          setTimedSession,
          switchViewMode,
        }),
      ),
    );

    // Restored elapsed = 50 - 20 = 30s, remaining = 30s
    expect(result.current.isAdvancedRuntimeTimer).toBe(true);
    expect(result.current.elapsedTime).toBe(30);
    expect(result.current.advancedTimerRemaining).toBe(30);

    // Advance 25s -> elapsed 55s, still not timed out
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(result.current.elapsedTime).toBe(55);
    expect(setTimedSession).not.toHaveBeenCalled();

    // Advance remaining 5s -> hits 60s elapsed & wall-clock deadline (80s)
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(setTimedSession).toHaveBeenCalledTimes(1);
    expect(setTimedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'timed-1',
        is_timeout: true,
        is_submitted: true,
      }),
    );
    expect(switchViewMode).toHaveBeenCalledWith('launcher');
    expect(notifyMock).toHaveBeenCalledWith('info', expect.any(String), expect.any(String));
  });

  it('auto-submits mock exam on timeout only while submission scope stays current', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:58.000Z'));
    const mockExam = createMockExamSession({ duration_minutes: 1 });
    const scoreCard = { total_questions: 1, correct_count: 1 } as never;
    useQuestionBankStore.setState({ mockExamSession: mockExam });

    const submitMockExam = vi.fn(async () => {
      useQuestionBankStore.setState({ mockExamScoreCard: scoreCard });
      return scoreCard;
    });
    const switchViewMode = vi.fn();

    renderHook(() =>
      useExamPracticeTimers(
        makeBaseOptions({
          practiceMode: 'mock_exam',
          activeMockExamSession: mockExam,
          submitMockExam,
          switchViewMode,
        }),
      ),
    );

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    expect(submitMockExam).toHaveBeenCalledTimes(1);
    expect(submitMockExam).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mock-1', is_submitted: true }),
    );
    expect(switchViewMode).toHaveBeenCalledWith('launcher');
    expect(notifyMock).toHaveBeenCalledWith('info', expect.any(String), expect.any(String));
  });

  it('stops timer when daily practice completes', () => {
    const base = makeBaseOptions({
      practiceMode: 'daily',
      activeDailyPractice: {
        exam_id: 'exam-1',
        is_completed: true,
        completed_count: 5,
        question_ids: ['q1'],
      } as NonNullable<StoreState['dailyPractice']>,
    });

    const { result } = renderHook(() => useExamPracticeTimers(base));
    expect(result.current.isTimerRunning).toBe(false);
  });
});
