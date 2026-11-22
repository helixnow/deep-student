import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_CHROME_TRANSITION_MS, useNoteFocusMode } from '../useNoteFocusMode';
import type { NotesFocusModeEventDetail } from '../../focusModeOwnership';

function mockReducedMotion(reduced: boolean) {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
}

describe('useNoteFocusMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts in visible non-focus state', () => {
    const { result } = renderHook(() => useNoteFocusMode());
    expect(result.current.focusMode).toBe(false);
    expect(result.current.focusChromePhase).toBe('visible');
    expect(result.current.isChromeHidden).toBe(false);
    expect(result.current.focusModeRef.current).toBe(false);
    expect(result.current.focusModeOwnerId).toBeTruthy();
  });

  it('transitions exiting -> hidden -> restoring -> visible across FOCUS_CHROME_TRANSITION_MS', () => {
    const { result } = renderHook(() => useNoteFocusMode());

    act(() => {
      result.current.toggleFocusMode();
    });
    expect(result.current.focusMode).toBe(true);
    expect(result.current.focusChromePhase).toBe('exiting');
    expect(result.current.isChromeHidden).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FOCUS_CHROME_TRANSITION_MS - 1);
    });
    expect(result.current.focusChromePhase).toBe('exiting');
    expect(result.current.isChromeHidden).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.focusChromePhase).toBe('hidden');
    expect(result.current.isChromeHidden).toBe(true);

    act(() => {
      result.current.toggleFocusMode();
    });
    expect(result.current.focusMode).toBe(false);
    expect(result.current.focusChromePhase).toBe('restoring');
    expect(result.current.isChromeHidden).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FOCUS_CHROME_TRANSITION_MS);
    });
    expect(result.current.focusChromePhase).toBe('visible');
  });

  it('skips intermediate phases under prefers-reduced-motion', () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useNoteFocusMode());

    act(() => {
      result.current.toggleFocusMode();
    });
    expect(result.current.focusChromePhase).toBe('hidden');
    expect(result.current.isChromeHidden).toBe(true);

    act(() => {
      result.current.toggleFocusMode();
    });
    expect(result.current.focusChromePhase).toBe('visible');
    expect(result.current.isChromeHidden).toBe(false);
  });

  it('publishes scoped ownership events on toggle and releases on unmount', () => {
    const received: NotesFocusModeEventDetail[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<NotesFocusModeEventDetail>).detail);
    };
    window.addEventListener('notes:focus-mode-changed', listener);

    try {
      const { result, unmount } = renderHook(() =>
        useNoteFocusMode({ focusModeScopeId: 'scope-a' }),
      );
      const ownerId = result.current.focusModeOwnerId;

      expect(received).toEqual([{ ownerId, scopeId: 'scope-a', enabled: false }]);

      act(() => {
        result.current.setFocusMode(true);
      });
      expect(received.at(-1)).toEqual({ ownerId, scopeId: 'scope-a', enabled: true });

      unmount();
      expect(received.at(-1)).toEqual({ ownerId, scopeId: 'scope-a', enabled: false });
    } finally {
      window.removeEventListener('notes:focus-mode-changed', listener);
    }
  });

  it('does not publish ownership events when focusModeScopeId is omitted', () => {
    const listener = vi.fn();
    window.addEventListener('notes:focus-mode-changed', listener);
    try {
      const { result, unmount } = renderHook(() => useNoteFocusMode());
      act(() => {
        result.current.toggleFocusMode();
      });
      unmount();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('notes:focus-mode-changed', listener);
    }
  });
});
