import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

import { useQuestionBankStore, type CheckInCalendar } from '@/stores/questionBankStore';

function calendar(examId: string): CheckInCalendar {
  return {
    exam_id: examId,
    year: 2026,
    month: 7,
    days: [],
    streak_days: 0,
    month_check_in_days: 0,
    month_total_questions: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('question bank calendar scope', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useQuestionBankStore.setState({
      checkInCalendar: null,
      error: null,
      isLoadingPractice: false,
    });
  });

  it('keeps the latest exam calendar when an older request finishes late', async () => {
    const first = deferred<CheckInCalendar>();
    const second = deferred<CheckInCalendar>();
    invokeMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const firstRequest = useQuestionBankStore
      .getState()
      .getCheckInCalendar('exam-a', 2026, 7);
    const secondRequest = useQuestionBankStore
      .getState()
      .getCheckInCalendar('exam-b', 2026, 7);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'qbank_get_check_in_calendar', {
      request: { exam_id: 'exam-a', month: 7, year: 2026 },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'qbank_get_check_in_calendar', {
      request: { exam_id: 'exam-b', month: 7, year: 2026 },
    });

    second.resolve(calendar('exam-b'));
    await secondRequest;
    expect(useQuestionBankStore.getState().checkInCalendar?.exam_id).toBe('exam-b');

    first.resolve(calendar('exam-a'));
    await firstRequest;

    expect(useQuestionBankStore.getState().checkInCalendar?.exam_id).toBe('exam-b');
    expect(useQuestionBankStore.getState().isLoadingPractice).toBe(false);
  });
});
