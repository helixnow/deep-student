/**
 * P7 — ChatAppWindow AppWindowProps 适配测试
 *
 * 覆盖：标题同步（store.title → onTitleChange）、聚焦时全局“当前会话”指针、
 * 无 instanceKey 时自动建会话、双实例标题隔离冒烟。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AppWindowProps } from '../../../core/types';

// ---- mocks ----

interface FakeChatState {
  sessionId: string;
  title: string;
  messageOrder: string[];
  setInputValue: (value: string) => void;
}

const fakeSessions = new Map<string, StoreApi<FakeChatState>>();
let currentSessionId: string | null = null;

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
    setCurrentSessionId: (sessionId: string | null) => {
      currentSessionId = sessionId;
    },
    getCurrentSessionId: () => currentSessionId,
    subscribe: () => () => {},
    has: (sessionId: string) => fakeSessions.has(sessionId),
  },
}));

const createSessionMock = vi.fn(async (_options: unknown) => {
  const id = `sess_auto_${createSessionMock.mock.calls.length}`;
  makeFakeStore(id);
  return { id, title: null } as unknown;
});

vi.mock('@/features/chat/core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: (options: unknown) => createSessionMock(options),
}));

vi.mock('@/features/chat/components/ChatContainer', () => {
  const ChatContainer: React.FC<{ sessionId: string }> = ({ sessionId }) => (
    <div data-testid="mock-chat-container" data-session-id={sessionId} />
  );
  return { ChatContainer, default: ChatContainer };
});

import { ChatAppWindow } from '../ChatAppWindow';

function makeProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'win_1',
    instanceKey: 'sess_1',
    launchPayload: undefined,
    isActive: false,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('ChatAppWindow', () => {
  beforeEach(() => {
    fakeSessions.clear();
    currentSessionId = null;
    createSessionMock.mockClear();
  });

  it('renders the surface for instanceKey session', () => {
    makeFakeStore('sess_1');
    render(<ChatAppWindow {...makeProps()} />);
    expect(screen.getByTestId('mock-chat-container').getAttribute('data-session-id')).toBe('sess_1');
  });

  it('syncs window title from the session store (fallback → store title → updates)', () => {
    const store = makeFakeStore('sess_1');
    const onTitleChange = vi.fn();
    render(<ChatAppWindow {...makeProps({ onTitleChange })} />);

    // 初始无标题 → 兜底
    expect(onTitleChange).toHaveBeenCalledWith('新对话');

    act(() => {
      store.setState({ title: '微积分答疑' });
    });
    expect(onTitleChange).toHaveBeenLastCalledWith('微积分答疑');
  });

  it('points the global current-session pointer at the focused window and clears it on unmount', () => {
    makeFakeStore('sess_1');
    const { rerender, unmount } = render(<ChatAppWindow {...makeProps({ isActive: false })} />);
    expect(currentSessionId).toBeNull();

    rerender(<ChatAppWindow {...makeProps({ isActive: true })} />);
    expect(currentSessionId).toBe('sess_1');

    unmount();
    expect(currentSessionId).toBeNull();
  });

  it('does not clear the pointer if another window has taken it over', () => {
    makeFakeStore('sess_1');
    const { unmount } = render(<ChatAppWindow {...makeProps({ isActive: true })} />);
    expect(currentSessionId).toBe('sess_1');

    // 另一个窗口聚焦接管指针
    currentSessionId = 'sess_other';
    unmount();
    expect(currentSessionId).toBe('sess_other');
  });

  it('auto-creates a session when launched without instanceKey', async () => {
    render(<ChatAppWindow {...makeProps({ instanceKey: null, windowId: 'win_auto' })} />);

    const container = await screen.findByTestId('mock-chat-container');
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(container.getAttribute('data-session-id')).toMatch(/^sess_auto_/);
  });

  it('shows a message skeleton (not a spinner) while the session is being created (O16)', async () => {
    render(<ChatAppWindow {...makeProps({ instanceKey: null, windowId: 'win_skel' })} />);

    // 建会话 promise 未决期间：气泡骨架屏占位
    const skeleton = document.querySelector('[data-wb-chat-skeleton]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute('aria-label')).toBe('正在准备会话…');

    // 会话就绪后骨架让位于真实 surface
    await screen.findByTestId('mock-chat-container');
    expect(document.querySelector('[data-wb-chat-skeleton]')).toBeNull();
  });

  it('prefers launchPayload.sessionId over auto-creation', () => {
    makeFakeStore('sess_from_payload');
    render(
      <ChatAppWindow
        {...makeProps({ instanceKey: null, launchPayload: { sessionId: 'sess_from_payload' } })}
      />,
    );
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-chat-container').getAttribute('data-session-id')).toBe(
      'sess_from_payload',
    );
  });

  it('two windows keep independent titles (dual-instance smoke)', () => {
    const storeA = makeFakeStore('sess_a');
    const storeB = makeFakeStore('sess_b');
    const onTitleA = vi.fn();
    const onTitleB = vi.fn();

    render(
      <>
        <ChatAppWindow
          {...makeProps({ windowId: 'win_a', instanceKey: 'sess_a', onTitleChange: onTitleA })}
        />
        <ChatAppWindow
          {...makeProps({ windowId: 'win_b', instanceKey: 'sess_b', onTitleChange: onTitleB })}
        />
      </>,
    );

    act(() => {
      storeA.setState({ title: '窗口A标题' });
    });
    expect(onTitleA).toHaveBeenLastCalledWith('窗口A标题');
    expect(onTitleB).toHaveBeenLastCalledWith('新对话');

    act(() => {
      storeB.setState({ title: '窗口B标题' });
    });
    expect(onTitleB).toHaveBeenLastCalledWith('窗口B标题');
    expect(onTitleA).toHaveBeenLastCalledWith('窗口A标题');

    const containers = screen.getAllByTestId('mock-chat-container');
    expect(containers.map((el) => el.getAttribute('data-session-id'))).toEqual([
      'sess_a',
      'sess_b',
    ]);
  });
});
