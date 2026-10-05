import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEARNING_HUB_QUICK_ACCESS_EVENT,
  requestLearningHubQuickAccess,
  takePendingLearningHubQuickAccess,
} from '../quickAccessRequest';

describe('learning hub quick access requests', () => {
  afterEach(() => {
    takePendingLearningHubQuickAccess();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('announces the request for a mounted finder and keeps it for one that mounts later', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    requestLearningHubQuickAccess('exams');

    const event = dispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(LEARNING_HUB_QUICK_ACCESS_EVENT);
    expect(event.detail).toEqual({ type: 'exams' });
    expect(takePendingLearningHubQuickAccess()).toBe('exams');
    // 只能取一次：已执行的请求不会在下次进入时再跳
    expect(takePendingLearningHubQuickAccess()).toBeNull();
  });

  it('drops a stale request', () => {
    vi.useFakeTimers();
    requestLearningHubQuickAccess('notes');
    vi.advanceTimersByTime(15_001);
    expect(takePendingLearningHubQuickAccess()).toBeNull();
  });
});
