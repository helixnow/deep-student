import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { isEnabled: () => false, launch: vi.fn() },
}));
vi.mock('@/features/workbench/agent/drivers/qbankDriver', () => ({
  QBANK_FOCUS_EVENT: 'qbank:focus-question',
}));

import { openQuestionInExam } from '../mistakeBookNavigation';

describe('openQuestionInExam', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens the question set, then re-sends the focus request until the exam view handles it', async () => {
    const navigations: unknown[] = [];
    let attempts = 0;
    vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (event.type === 'NAVIGATE_TO_VIEW') navigations.push(detail);
      if (event.type === 'qbank:focus-question') {
        attempts += 1;
        expect(detail).toMatchObject({ questionId: 'q1', targetResourceId: 'exam-a' });
        // 前两次题目还没加载完：未命中
        detail.acknowledge({ handled: attempts >= 3, previousQuestionId: null });
      }
      return true;
    });

    openQuestionInExam('exam-a', 'q1');
    expect(navigations).toEqual([{ view: 'learning-hub', openResource: '/exam-a' }]);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(attempts).toBe(3);
  });
});
