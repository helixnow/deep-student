import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMotionPresence } from '../useMotionPresence';

describe('useMotionPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the node mounted through the close budget, then unmounts', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useMotionPresence(open, { exitMs: 150, enter: 'animation' }),
      { initialProps: { open: true } },
    );

    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(false);

    act(() => {
      rerender({ open: false });
    });

    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(true);
    expect(result.current.shown).toBe(false);

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current.mounted).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.mounted).toBe(false);
    expect(result.current.exiting).toBe(false);
  });

  it('is shown immediately when using animation enter', () => {
    const { result } = renderHook(() =>
      useMotionPresence(true, { enter: 'animation' }),
    );
    expect(result.current.mounted).toBe(true);
    expect(result.current.shown).toBe(true);
  });

  it('commits mounted on the opening layout pass', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useMotionPresence(open, { enter: 'animation' }),
      { initialProps: { open: false } },
    );

    expect(result.current.mounted).toBe(false);

    act(() => {
      rerender({ open: true });
    });

    expect(result.current.mounted).toBe(true);
    expect(result.current.shown).toBe(true);
    expect(result.current.exiting).toBe(false);
  });
});
