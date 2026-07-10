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
  });

  it('registers chat app with the required metadata', () => {
    registerChatApp();
    const def = appRegistry.get(CHAT_APP_TYPE_ID);
    expect(def).toBe(chatAppDefinition);
    expect(def?.typeId).toBe('chat');
    expect(def?.instanceMode).toBe('multi');
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

  it('setInput writes only to the target session store (dual-instance isolation)', async () => {
    const storeA = makeFakeStore('sess_a');
    const storeB = makeFakeStore('sess_b');

    handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_a',
      action: 'setInput',
      payload: { content: 'hello from window A' },
    });

    await vi.waitFor(() => {
      expect(storeA.getState().setInputValue).toHaveBeenCalledWith('hello from window A');
    });
    expect(storeB.getState().setInputValue).not.toHaveBeenCalled();
  });

  it('setInput accepts a plain string payload', async () => {
    const store = makeFakeStore('sess_str');
    handleChatActivation({
      windowId: 'w1',
      instanceKey: 'sess_str',
      action: 'setInput',
      payload: 'plain text',
    });
    await vi.waitFor(() => {
      expect(store.getState().setInputValue).toHaveBeenCalledWith('plain text');
    });
  });

  it('focusInput dispatches CHAT_V2_FOCUS_INPUT carrying the sessionId', async () => {
    const received: Array<string | undefined> = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId);
    };
    window.addEventListener('CHAT_V2_FOCUS_INPUT', listener);
    try {
      handleChatActivation({
        windowId: 'w1',
        instanceKey: 'sess_focus',
        action: 'focusInput',
      });
      await vi.waitFor(() => {
        expect(received.length).toBeGreaterThan(0);
      });
      expect(received.every((sid) => sid === 'sess_focus')).toBe(true);
    } finally {
      window.removeEventListener('CHAT_V2_FOCUS_INPUT', listener);
    }
  });

  it('ignores activation without instanceKey (no throw)', () => {
    expect(() =>
      handleChatActivation({
        windowId: 'w1',
        instanceKey: null,
        action: 'setInput',
        payload: { content: 'x' },
      }),
    ).not.toThrow();
  });

  it('ignores unknown actions (no throw)', () => {
    makeFakeStore('sess_x');
    expect(() =>
      handleChatActivation({
        windowId: 'w1',
        instanceKey: 'sess_x',
        action: 'somethingElse',
      }),
    ).not.toThrow();
  });
});
