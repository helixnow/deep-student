/**
 * P7 — chat register 元数据 + onActivation 行为测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';

// ---- mock sessionManager（register.ts 经动态 import 消费同一路径） ----

interface FakeChatState {
  sessionId: string;
  title: string;
  messageOrder: string[];
  setInputValue: (value: string) => void;
}

const fakeSessions = new Map<string, StoreApi<FakeChatState>>();

function makeFakeStore(sessionId: string): StoreApi<FakeChatState> {
  const store = createStore<FakeChatState>(() => ({
    sessionId,
    title: '',
    messageOrder: [],
    setInputValue: vi.fn(),
  }));
  fakeSessions.set(sessionId, store);
  return store;
}

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    get: (sessionId: string) => fakeSessions.get(sessionId),
    getOrCreate: (sessionId: string) =>
      fakeSessions.get(sessionId) ?? makeFakeStore(sessionId),
    setCurrentSessionId: vi.fn(),
    getCurrentSessionId: () => null,
    subscribe: () => () => {},
    has: (sessionId: string) => fakeSessions.has(sessionId),
  },
}));

import { appRegistry } from '../../../core/appRegistry';
import {
  chatAppDefinition,
  handleChatActivation,
  registerChatApp,
  CHAT_APP_TYPE_ID,
} from '../register';

describe('workbench chat register', () => {
  beforeEach(() => {
    fakeSessions.clear();
    document.body.innerHTML = '';
  });

  function mountSessionInput(sessionId: string): HTMLTextAreaElement {
    const root = document.createElement('div');
    root.setAttribute('data-wb-chat-session', sessionId);
    const input = document.createElement('textarea');
    input.setAttribute('data-testid', 'input-bar-v2-textarea');
    root.appendChild(input);
    document.body.appendChild(root);
    return input;
  }

  it('registers chat app with the required metadata', () => {
    registerChatApp();
    const def = appRegistry.get(CHAT_APP_TYPE_ID);
    expect(def).toBe(chatAppDefinition);
    expect(def?.typeId).toBe('chat');
    expect(def?.instanceMode).toBe('single');
    expect(def?.memoryWeight).toBe(2);
    expect(def?.nameKey).toBe('apps.chat.name');
    expect(def?.onActivation).toBeTypeOf('function');
    expect(def?.defaultFrame.w).toBeGreaterThan(0);
    expect(def?.defaultFrame.h).toBeGreaterThan(0);
    expect(def?.minSize.w).toBeGreaterThan(0);
    expect(def?.minSize.h).toBeGreaterThan(0);
    expect(def?.render).toBeDefined();
  });

  it('registerChatApp is idempotent (no duplicate re-register warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    registerChatApp();
    registerChatApp();
    expect(
      warnSpy.mock.calls.filter((args) => String(args[0]).includes('re-registered')),
    ).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('setInput writes only to the active session store', async () => {
    const storeA = makeFakeStore('sess_a');
    const storeB = makeFakeStore('sess_b');

    const result = await handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_a',
      action: 'setInput',
      payload: { content: 'hello from window A' },
    });

    expect(result).toEqual({ handled: true });
    expect(storeA.getState().setInputValue).toHaveBeenCalledWith('hello from window A');
    expect(storeB.getState().setInputValue).not.toHaveBeenCalled();
  });

  it('setInput accepts a plain string payload', async () => {
    const store = makeFakeStore('sess_str');
    const result = await handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_str',
      action: 'setInput',
      payload: 'plain text',
    });
    expect(result).toEqual({ handled: true });
    expect(store.getState().setInputValue).toHaveBeenCalledWith('plain text');
  });

  it('focusInput dispatches CHAT_V2_FOCUS_INPUT and confirms the target composer is focused', async () => {
    makeFakeStore('sess_focus');
    const input = mountSessionInput('sess_focus');
    const received: Array<string | undefined> = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId);
    };
    window.addEventListener('CHAT_V2_FOCUS_INPUT', listener);
    try {
      const result = await handleChatActivation({
        windowId: 'w1',
        instanceKey: 'sess_focus',
        action: 'focusInput',
      });
      expect(result).toEqual({ handled: true });
      expect(received.length).toBeGreaterThan(0);
      expect(received.every((sid) => sid === 'sess_focus')).toBe(true);
      expect(input).toHaveFocus();
    } finally {
      window.removeEventListener('CHAT_V2_FOCUS_INPUT', listener);
    }
  });

  it('waits through a cold-start skeleton until the target composer mounts', async () => {
    vi.useFakeTimers();
    makeFakeStore('sess_cold');
    try {
      let settled = false;
      const pending = handleChatActivation({
        windowId: 'w-cold',
        instanceKey: 'sess_cold',
        action: 'focusInput',
      }).then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(false);

      const input = mountSessionInput('sess_cold');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({ handled: true });
      expect(input).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns DELIVERY_FAILED when the target composer never mounts', async () => {
    vi.useFakeTimers();
    makeFakeStore('sess_no_input');
    try {
      const pending = handleChatActivation({
        windowId: 'w-no-input',
        instanceKey: 'sess_no_input',
        action: 'focusInput',
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({
        handled: false,
        code: 'DELIVERY_FAILED',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('activation without instanceKey returns structured unhandled result', async () => {
    await expect(
      handleChatActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'setInput',
        payload: { content: 'x' },
      }),
    ).resolves.toMatchObject({ handled: false, code: 'SESSION_ID_REQUIRED' });
  });

  it('unknown actions return structured unhandled result', async () => {
    makeFakeStore('sess_x');
    await expect(
      handleChatActivation({
        windowId: 'w1',
        instanceKey: 'sess_x',
        action: 'somethingElse',
      }),
    ).resolves.toMatchObject({ handled: false, code: 'UNKNOWN_ACTION' });
  });

  it('invalid payload and missing target store do not report handled success', async () => {
    await expect(handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_invalid',
      action: 'setInput',
      payload: { content: 42 },
    })).resolves.toMatchObject({ handled: false, code: 'DELIVERY_FAILED' });

    vi.useFakeTimers();
    try {
      const pending = handleChatActivation({
        windowId: 'w1',
        instanceKey: 'sess_missing',
        action: 'setInput',
        payload: 'will not deliver',
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ handled: false, code: 'DELIVERY_FAILED' });
    } finally {
      vi.useRealTimers();
    }
  });
});
