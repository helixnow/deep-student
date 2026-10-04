import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  MEDIA_FOCUS_ACK_TIMEOUT_MS,
  MEDIA_REF_FOCUS_EVENT,
  dispatchOpenMediaRef,
  requestMediaFocusUntilHandled,
  requestMediaSeekWithAck,
  type MediaFocusEventDetail,
} from '../mediaRefEvents';
import { matchesMediaFocusTarget, useMediaFocusListener } from '../useMediaFocusListener';

describe('requestMediaFocusUntilHandled', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-dispatches until a listener acknowledges, then stops', () => {
    const seen: MediaFocusEventDetail[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<MediaFocusEventDetail>).detail;
      seen.push(detail);
      // the view only mounts after the second attempt
      if (seen.length === 2) detail.acknowledge?.(true);
    };
    document.addEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    requestMediaFocusUntilHandled({ resourceId: 'file_1', seconds: 30, targetScopeId: 'scope' });
    vi.advanceTimersByTime(10_000);
    document.removeEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ resourceId: 'file_1', seconds: 30, targetScopeId: 'scope' });
  });

  it('can be cancelled and ignores invalid targets', () => {
    const listener = vi.fn();
    document.addEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    const cancel = requestMediaFocusUntilHandled({ resourceId: 'file_1', seconds: 1 });
    vi.advanceTimersByTime(0);
    cancel();
    vi.advanceTimersByTime(10_000);
    requestMediaFocusUntilHandled({ resourceId: '', seconds: 1 });
    requestMediaFocusUntilHandled({ resourceId: 'file_1', seconds: -1 });
    vi.advanceTimersByTime(10_000);
    document.removeEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('requestMediaSeekWithAck', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves true on ack', async () => {
    const listener = (e: Event) => (e as CustomEvent<MediaFocusEventDetail>).detail.acknowledge?.(true);
    document.addEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    await expect(requestMediaSeekWithAck({ resourceId: 'file_1', seconds: 5 })).resolves.toBe(true);
    document.removeEventListener(MEDIA_REF_FOCUS_EVENT, listener);
  });

  it('times out and marks the request stale', async () => {
    let detail: MediaFocusEventDetail | null = null;
    const listener = (e: Event) => {
      detail = (e as CustomEvent<MediaFocusEventDetail>).detail;
    };
    document.addEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    const pending = requestMediaSeekWithAck({ resourceId: 'file_1', seconds: 5 });
    vi.advanceTimersByTime(MEDIA_FOCUS_ACK_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe(false);
    document.removeEventListener(MEDIA_REF_FOCUS_EVENT, listener);
    expect(detail!.isStale?.()).toBe(true);
  });
});

describe('dispatchOpenMediaRef', () => {
  it('emits media-ref:open with resourceId and seconds', () => {
    const listener = vi.fn();
    document.addEventListener('media-ref:open', listener);
    dispatchOpenMediaRef('file_3', 12);
    dispatchOpenMediaRef('file_3', Number.NaN);
    document.removeEventListener('media-ref:open', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ resourceId: 'file_3', seconds: 12 });
  });
});

describe('useMediaFocusListener', () => {
  it('matches by id, sourceId or path', () => {
    const node = { nodeId: 'file_1', nodeSourceId: 'att_1', nodePath: '/folder/file_1' };
    expect(matchesMediaFocusTarget('file_1', node)).toBe(true);
    expect(matchesMediaFocusTarget('/file_1', node)).toBe(true);
    expect(matchesMediaFocusTarget('att_1', node)).toBe(true);
    expect(matchesMediaFocusTarget('file_2', node)).toBe(false);
    expect(matchesMediaFocusTarget(undefined, node)).toBe(false);
  });

  it('captures matching requests, honours scope, and acks on handled', () => {
    const { result } = renderHook(() =>
      useMediaFocusListener({ enabled: true, focusScopeId: 'panel', nodeId: 'file_1' }),
    );
    const ack = vi.fn();
    act(() => {
      document.dispatchEvent(new CustomEvent(MEDIA_REF_FOCUS_EVENT, {
        detail: { resourceId: 'file_1', seconds: 9, targetScopeId: 'other', acknowledge: ack },
      }));
    });
    expect(result.current[0]).toBeNull();
    act(() => {
      document.dispatchEvent(new CustomEvent(MEDIA_REF_FOCUS_EVENT, {
        detail: { resourceId: 'file_1', seconds: 9, targetScopeId: 'panel', acknowledge: ack, play: false },
      }));
    });
    const request = result.current[0];
    expect(request).toMatchObject({ seconds: 9, play: false });
    act(() => result.current[1](request!.requestId, true));
    expect(ack).toHaveBeenCalledWith(true);
    expect(result.current[0]).toBeNull();
  });

  it('acks pending requests with false on unmount', () => {
    const { unmount } = renderHook(() => useMediaFocusListener({ enabled: true, nodeId: 'file_1' }));
    const ack = vi.fn();
    act(() => {
      document.dispatchEvent(new CustomEvent(MEDIA_REF_FOCUS_EVENT, {
        detail: { resourceId: 'file_1', seconds: 1, acknowledge: ack },
      }));
    });
    unmount();
    expect(ack).toHaveBeenCalledWith(false);
  });

  it('ignores requests while disabled (inactive tab)', () => {
    const { result } = renderHook(() => useMediaFocusListener({ enabled: false, nodeId: 'file_1' }));
    act(() => {
      document.dispatchEvent(new CustomEvent(MEDIA_REF_FOCUS_EVENT, { detail: { resourceId: 'file_1', seconds: 1 } }));
    });
    expect(result.current[0]).toBeNull();
  });
});
