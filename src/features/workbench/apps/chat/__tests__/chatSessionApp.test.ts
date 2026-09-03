/**
 * chat-session multi 实例应用测试（会话右键「在新窗口打开」）
 *
 * 覆盖：
 * - 注册元数据契约（multi / 不进启动器 / 渲染与激活函数就位）
 * - openChatSessionInNewWindow：workbench 启用时按 instanceKey 开窗，
 *   同一会话重复打开去重聚焦；未启用（legacy）时返回 null 不动作
 * - handleChatSessionActivation：目标会话固定为 instanceKey，
 *   不回落全局 currentSessionId（多窗隔离）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';

interface FakeChatState {
  sessionId: string;
  title: string;
  setInputValue: (value: string) => void;
}

const fakeSessions = new Map<string, StoreApi<FakeChatState>>();

function makeFakeStore(sessionId: string): StoreApi<FakeChatState> {
  const store = createStore<FakeChatState>(() => ({
    sessionId,
    title: '',
    setInputValue: vi.fn(),
  }));
  fakeSessions.set(sessionId, store);
  return store;
}

// 全局 currentSessionId 固定指向另一个会话，验证 chat-session 激活不受其影响
vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    get: (sessionId: string) => fakeSessions.get(sessionId),
    getOrCreate: (sessionId: string) =>
      fakeSessions.get(sessionId) ?? makeFakeStore(sessionId),
    setCurrentSessionId: vi.fn(),
    getCurrentSessionId: () => 'sess_global_current',
    subscribe: () => () => {},
    has: (sessionId: string) => fakeSessions.has(sessionId),
  },
}));

// newSession.ts 静态依赖会话创建链；本测试只走 openChatSessionInNewWindow，mock 掉避免拖入 Tauri
vi.mock('@/features/chat/core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: vi.fn(),
}));
vi.mock('@/features/chat/navigation/pendingChatNavigation', () => ({
  requestChatSessionNavigation: vi.fn(),
}));

import { appRegistry } from '../../../core/appRegistry';
import { useWindowStore, resetWindowStoreForTests } from '../../../core/windowStore';
import { workbenchBus } from '../../../core/workbenchBus';
import {
  chatSessionAppDefinition,
  handleChatSessionActivation,
  registerChatApp,
  CHAT_SESSION_APP_TYPE_ID,
} from '../register';
import { openChatSessionInNewWindow } from '../newSession';

describe('workbench chat-session app', () => {
  beforeEach(() => {
    fakeSessions.clear();
    resetWindowStoreForTests({ w: 1600, h: 1000 });
    workbenchBus.setEnabled(true);
  });

  afterEach(() => {
    workbenchBus.setEnabled(false);
    resetWindowStoreForTests();
  });

  it('registers the chat-session app as multi-instance and hidden from the launcher', () => {
    registerChatApp();
    const def = appRegistry.get(CHAT_SESSION_APP_TYPE_ID);
    expect(def).toBe(chatSessionAppDefinition);
    expect(def?.instanceMode).toBe('multi');
    expect(def?.showInLauncher).toBe(false);
    expect(def?.nameKey).toBe('apps.chatSession.name');
    expect(def?.render).toBeDefined();
    expect(def?.onActivation).toBeTypeOf('function');
  });

  it('opens a window keyed by sessionId and dedupes on repeat open', () => {
    const first = openChatSessionInNewWindow('sess_multi_1');
    expect(first).toBeTruthy();

    const win = useWindowStore.getState().windows[first as string];
    expect(win?.typeId).toBe(CHAT_SESSION_APP_TYPE_ID);
    expect(win?.instanceKey).toBe('sess_multi_1');

    // 同一会话再次打开：聚焦已有窗口而非新建
    const again = openChatSessionInNewWindow('sess_multi_1');
    expect(again).toBe(first);
    expect(
      Object.values(useWindowStore.getState().windows).filter(
        (candidate) => candidate.typeId === CHAT_SESSION_APP_TYPE_ID,
      ),
    ).toHaveLength(1);

    // 不同会话打开：独立第二窗
    const second = openChatSessionInNewWindow('sess_multi_2');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(
      Object.values(useWindowStore.getState().windows).filter(
        (candidate) => candidate.typeId === CHAT_SESSION_APP_TYPE_ID,
      ),
    ).toHaveLength(2);
  });

  it('returns null and opens nothing when workbench mode is disabled (legacy)', () => {
    workbenchBus.setEnabled(false);
    const result = openChatSessionInNewWindow('sess_legacy');
    expect(result).toBeNull();
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
  });

  it('activation targets the window instanceKey, not the global current session', async () => {
    const windowStore = makeFakeStore('sess_window');
    const globalStore = makeFakeStore('sess_global_current');

    const result = await handleChatSessionActivation({
      windowId: 'w-session',
      instanceKey: 'sess_window',
      action: 'setInput',
      payload: { content: 'scoped to this window' },
    });

    expect(result).toEqual({ handled: true, acknowledged: true });
    expect(windowStore.getState().setInputValue).toHaveBeenCalledWith('scoped to this window');
    expect(globalStore.getState().setInputValue).not.toHaveBeenCalled();
  });

  it('activation without a bound session returns a structured failure', async () => {
    await expect(
      handleChatSessionActivation({
        windowId: 'w-none',
        instanceKey: null,
        action: 'setInput',
        payload: { content: 'x' },
      }),
    ).resolves.toMatchObject({ handled: false, code: 'SESSION_ID_REQUIRED' });
  });
});
