import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queueChatInputFiles,
  resetChatInputInbox,
  takeChatInputFiles,
  useChatInputInbox,
} from '../chatInputInbox';

const png = (name: string) => new File([name], `${name}.png`, { type: 'image/png' });

describe('chatInputInbox', () => {
  beforeEach(() => resetChatInputInbox());
  afterEach(() => vi.useRealTimers());

  it('hands queued files only to their session, and only once', () => {
    const a = png('a');
    const b = png('b');
    queueChatInputFiles('s1', [a]);
    queueChatInputFiles('s2', [b]);

    expect(takeChatInputFiles('s1')).toEqual([a]);
    expect(takeChatInputFiles('s1')).toEqual([]);
    expect(takeChatInputFiles('s2')).toEqual([b]);
  });

  it('drops files nobody picked up for half an hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    queueChatInputFiles('s1', [png('old')]);
    vi.setSystemTime(31 * 60_000);

    expect(takeChatInputFiles('s1')).toEqual([]);
  });

  it('lets the input bar pick up files queued before it was ready, then each new delivery', () => {
    const onFiles = vi.fn();
    const early = png('early');
    const later = png('later');
    queueChatInputFiles('s1', [early]);

    const { rerender } = renderHook(({ ready }) => useChatInputInbox('s1', ready, onFiles), {
      initialProps: { ready: false },
    });
    expect(onFiles).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(onFiles).toHaveBeenCalledWith([early]);

    act(() => queueChatInputFiles('s1', [later]));
    expect(onFiles).toHaveBeenLastCalledWith([later]);

    act(() => queueChatInputFiles('other', [png('x')]));
    expect(onFiles).toHaveBeenCalledTimes(2);
  });
});
