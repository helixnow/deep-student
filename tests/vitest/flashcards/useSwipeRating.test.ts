import type React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  SWIPE_RATING_MAP,
  useSwipeRating,
} from '@/features/flashcards/hooks/useSwipeRating';

function pointerEvent(overrides: Record<string, unknown> = {}): React.PointerEvent<HTMLElement> {
  const currentTarget = {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  };
  return {
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: 0,
    clientY: 0,
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as React.PointerEvent<HTMLElement>;
}

function swipeRight(
  handlers: ReturnType<typeof useSwipeRating>['handlers'],
): void {
  act(() => {
    handlers.onPointerDown(pointerEvent({ clientX: 0, clientY: 0 }));
    handlers.onPointerMove(pointerEvent({ clientX: 120, clientY: 0 }));
    handlers.onPointerUp(pointerEvent({ clientX: 120, clientY: 0 }));
  });
}

describe('useSwipeRating', () => {
  it('reports a rating and enters flyout past the threshold', () => {
    const onRate = vi.fn();
    const { result } = renderHook(() =>
      useSwipeRating({ enabled: true, resetKey: 'card:1', onRate }),
    );

    swipeRight(result.current.handlers);

    expect(onRate).toHaveBeenCalledWith(SWIPE_RATING_MAP.right);
    expect(result.current.state.flyout).toBe('right');
  });

  it('resets flyout when the attempt identity (resetKey) changes', () => {
    const onRate = vi.fn();
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: string }) =>
        useSwipeRating({ enabled: true, resetKey, onRate }),
      { initialProps: { resetKey: 'card:1:0' } },
    );

    swipeRight(result.current.handlers);
    expect(result.current.state.flyout).toBe('right');

    // 单张学习卡评分后回插：id 不变，但作答计数变化必须换出新的 resetKey，
    // 否则卡面会保持飞出/透明状态（F07）。
    act(() => {
      rerender({ resetKey: 'card:1:1' });
    });
    expect(result.current.state.flyout).toBeNull();
    expect(result.current.state.dragging).toBe(false);
  });
});
