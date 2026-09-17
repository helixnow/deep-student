import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCardAnswerClock } from '@/features/flashcards/review/useSessionClock';

describe('card answer clock', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts thinking time, pauses inactive views, and resets each presentation', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { result, rerender } = renderHook(
      ({ key, enabled }) => useCardAnswerClock(key, enabled),
      { initialProps: { key: 'card:0', enabled: true } },
    );
    now += 40_000;
    expect(result.current()).toBe(40_000);
    rerender({ key: 'card:0', enabled: false });
    now += 30_000;
    expect(result.current()).toBe(40_000);
    rerender({ key: 'card:0', enabled: true });
    now += 2000;
    expect(result.current()).toBe(42_000);
    rerender({ key: 'card:1', enabled: true });
    expect(result.current()).toBe(0);
  });

  it('excludes time while the document is hidden', () => {
    let now = 1000;
    let hidden = false;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const { result } = renderHook(() => useCardAnswerClock('card', true));
    now += 3000;
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    now += 60_000;
    expect(result.current()).toBe(3000);
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    now += 2000;
    expect(result.current()).toBe(5000);
  });
});
