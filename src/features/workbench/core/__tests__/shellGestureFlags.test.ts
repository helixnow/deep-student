/**
 * shellGestureFlags — 起拖同步挂旗 / settle 桥接
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginShellSettling,
  endShellSettling,
  enterShellGestureGlobal,
  isShellDraggingAttr,
  isShellGestureActive,
  isShellSettlingAttr,
  leaveShellGestureGlobal,
  resetShellGestureFlagsForTests,
  shouldPauseHeavyContent,
} from '../shellGestureFlags';
import { resetSchedulerTransientsForTests } from '../scheduler';

beforeEach(() => {
  resetShellGestureFlagsForTests();
  resetSchedulerTransientsForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  resetShellGestureFlagsForTests();
  resetSchedulerTransientsForTests();
  vi.useRealTimers();
});

describe('shellGestureFlags', () => {
  it('enter 同步挂 data-wb-dragging；不在同栈 flush 重内容 paused', () => {
    const host = document.createElement('div');
    host.setAttribute('data-wb-content-host', '');
    document.body.appendChild(host);

    enterShellGestureGlobal();
    expect(isShellDraggingAttr()).toBe(true);
    expect(shouldPauseHeavyContent()).toBe(true);
    expect(isShellGestureActive()).toBe(true);
    // ANTI-REGRESSION：起拖同栈不得 flush（重窗 style 会吃掉 arm）
    expect(host.hasAttribute('data-wb-render-paused')).toBe(false);

    host.remove();
  });

  it('leave 后短桥接仍保旗；超时后清除', () => {
    enterShellGestureGlobal();
    leaveShellGestureGlobal();
    expect(isShellDraggingAttr()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(isShellDraggingAttr()).toBe(false);
    expect(isShellGestureActive()).toBe(false);
  });

  it('leave → beginShellSettling 接手：桥接超时不清旗', () => {
    enterShellGestureGlobal();
    leaveShellGestureGlobal();
    beginShellSettling();
    expect(isShellSettlingAttr()).toBe(true);
    expect(isShellDraggingAttr()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(isShellSettlingAttr()).toBe(true);
    endShellSettling();
    expect(isShellSettlingAttr()).toBe(false);
    expect(isShellDraggingAttr()).toBe(false);
  });
});
