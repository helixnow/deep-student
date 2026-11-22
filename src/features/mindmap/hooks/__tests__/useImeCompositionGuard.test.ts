import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useImeCompositionGuard } from '../useImeCompositionGuard';

describe('useImeCompositionGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects native isComposing and keyCode 229 immediately', () => {
    const { result } = renderHook(() => useImeCompositionGuard());

    expect(result.current.isComposingKeyEvent({ key: 'Enter', isComposing: true })).toBe(true);
    expect(result.current.isComposingKeyEvent({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(
      result.current.isComposingKeyEvent({
        key: 'Enter',
        nativeEvent: { isComposing: true, keyCode: 13 },
      }),
    ).toBe(true);
    expect(result.current.isComposingKeyEvent({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('guards WKWebView/Safari post-compositionend Enter within same frame and 100ms window', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 42;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      rafCallback = null;
    });

    const { result } = renderHook(() => useImeCompositionGuard());

    act(() => {
      result.current.onCompositionStart();
    });
    expect(result.current.isComposingKeyEvent({ key: 'Enter', isComposing: false })).toBe(true);
    expect(result.current.isComposingKeyEvent({ key: 'Tab', isComposing: false })).toBe(true);

    // Safari fires compositionend BEFORE keydown(Enter)
    act(() => {
      result.current.onCompositionEnd();
    });

    // Still in same frame before rAF resets composingRef
    expect(result.current.isComposingKeyEvent({ key: 'Enter', isComposing: false })).toBe(true);
    expect(result.current.isComposingKeyEvent({ key: 'Escape', isComposing: false })).toBe(true);

    // rAF fires 16ms later
    now = 1016;
    act(() => {
      rafCallback?.(now);
    });

    // Non-Enter keys are released after rAF
    expect(result.current.isComposingKeyEvent({ key: 'Escape', isComposing: false })).toBe(false);
    // Enter within 100ms post-compositionend is STILL guarded
    expect(result.current.isComposingKeyEvent({ key: 'Enter', isComposing: false })).toBe(true);

    // After 100ms window passes, normal Enter is allowed
    now = 1105;
    expect(result.current.isComposingKeyEvent({ key: 'Enter', isComposing: false })).toBe(false);
  });

  it('cancels pending rAF reset when a new composition starts immediately', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 77);

    const { result } = renderHook(() => useImeCompositionGuard());

    act(() => {
      result.current.onCompositionStart();
      result.current.onCompositionEnd();
      result.current.onCompositionStart();
    });

    expect(cancelSpy).toHaveBeenCalledWith(77);
    expect(result.current.isComposingKeyEvent({ key: 'Tab', isComposing: false })).toBe(true);
  });
});
