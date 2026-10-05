import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/chat/core/session/sessionManager', () => ({ sessionManager: {} }));

import { APP_EVENTS } from '@/events';
import { requestNewChatSession } from '../mediaChat';

function fakeManager(current: string | null) {
  let listener: ((event: { type: string; sessionId?: string | null }) => void) | null = null;
  const manager = {
    current,
    getCurrentSessionId: () => manager.current,
    subscribe: (fn: typeof listener) => {
      listener = fn;
      return () => { listener = null; };
    },
    get: () => undefined,
    switchTo(id: string) {
      manager.current = id;
      listener?.({ type: 'current-session-changed', sessionId: id });
    },
    get listening() { return listener !== null; },
  };
  return manager;
}

describe('requestNewChatSession', () => {
  afterEach(() => vi.useRealTimers());

  it('prefills a new session (autoSend off) and resolves once it becomes current', async () => {
    const manager = fakeManager('sess_old');
    const events: Array<{ type: string; detail: unknown }> = [];
    const record = (event: Event) => events.push({ type: event.type, detail: (event as CustomEvent).detail });
    window.addEventListener(APP_EVENTS.PREFILL_CHAT_INPUT, record);

    const pending = requestNewChatSession(manager, '总结这节课');
    manager.switchTo('sess_new');
    await expect(pending).resolves.toBe('sess_new');
    window.removeEventListener(APP_EVENTS.PREFILL_CHAT_INPUT, record);

    expect(events).toEqual([
      { type: APP_EVENTS.PREFILL_CHAT_INPUT, detail: { content: '总结这节课', autoSend: false, newSession: true } },
    ]);
    expect(manager.listening).toBe(false);
  });

  it('without a prompt requests a plain new session and falls back to the current one on timeout', async () => {
    vi.useFakeTimers();
    const manager = fakeManager('sess_draft');
    const newSession = vi.fn();
    window.addEventListener(APP_EVENTS.CHAT_NEW_SESSION, newSession);
    const pending = requestNewChatSession(manager, undefined, 3000);
    vi.advanceTimersByTime(3000);
    await expect(pending).resolves.toBe('sess_draft');
    window.removeEventListener(APP_EVENTS.CHAT_NEW_SESSION, newSession);
    expect(newSession).toHaveBeenCalledTimes(1);
  });
});
