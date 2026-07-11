import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AppWindowProps } from '../../../core/types';

interface FakeChatState {
  title: string;
}

const fakeSessions = new Map<string, StoreApi<FakeChatState>>();
const managerListeners = new Set<(event: { type: string; sessionId: string }) => void>();
let currentSessionId: string | null = null;

function makeFakeStore(sessionId: string, title = ''): StoreApi<FakeChatState> {
  const store = createStore<FakeChatState>(() => ({ title }));
  fakeSessions.set(sessionId, store);
  return store;
}

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    get: (sessionId: string) => fakeSessions.get(sessionId),
    getCurrentSessionId: () => currentSessionId,
    subscribe: (listener: (event: { type: string; sessionId: string }) => void) => {
      managerListeners.add(listener);
      return () => managerListeners.delete(listener);
    },
  },
}));

vi.mock('@/components/ModernSidebar', () => ({
  ModernSidebar: ({ navigationScope }: { navigationScope?: string }) => (
    <div data-testid="chat-sidebar" data-navigation-scope={navigationScope} />
  ),
}));

vi.mock('@/features/chat/pages', () => ({
  ChatV2Page: () => <div data-testid="chat-v2-page" />,
}));

vi.mock('../../system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: { current: null }, sizeClass: 'wide', heightClass: 'tall' }),
}));

vi.mock('../../system/SystemWindowShared', () => ({
  WbSysSidebarLayout: ({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) => (
    <div><aside>{sidebar}</aside><main>{children}</main></div>
  ),
  WbSysSkeleton: () => <div data-testid="chat-skeleton" />,
}));

import { ChatAppWindow } from '../ChatAppWindow';

function makeProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'chat-window',
    instanceKey: null,
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('ChatAppWindow', () => {
  beforeEach(() => {
    fakeSessions.clear();
    managerListeners.clear();
    currentSessionId = null;
  });

  it('renders the complete Chat page with the conversation-only original sidebar', async () => {
    render(<ChatAppWindow {...makeProps()} />);

    expect(await screen.findByTestId('chat-v2-page')).toBeInTheDocument();
    expect(screen.getByTestId('chat-sidebar')).toHaveAttribute('data-navigation-scope', 'chat');
  });

  it('tracks the selected session title inside the singleton window', () => {
    makeFakeStore('sess_a', '会话 A');
    const storeB = makeFakeStore('sess_b', '会话 B');
    currentSessionId = 'sess_a';
    const onTitleChange = vi.fn();
    render(<ChatAppWindow {...makeProps({ onTitleChange })} />);

    expect(onTitleChange).toHaveBeenLastCalledWith('会话 A');
    act(() => {
      currentSessionId = 'sess_b';
      managerListeners.forEach((listener) => listener({
        type: 'current-session-changed',
        sessionId: 'sess_b',
      }));
    });
    expect(onTitleChange).toHaveBeenLastCalledWith('会话 B');

    act(() => storeB.setState({ title: '会话 B 新标题' }));
    expect(onTitleChange).toHaveBeenLastCalledWith('会话 B 新标题');
  });

  it('replays an initial history-session target after a cold launch', () => {
    vi.useFakeTimers();
    const received: string[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    };
    window.addEventListener('navigate-to-session', listener);
    try {
      render(<ChatAppWindow {...makeProps({ instanceKey: 'sess_history' })} />);
      act(() => vi.runAllTimers());
      expect(received).toEqual(['sess_history', 'sess_history', 'sess_history']);
    } finally {
      window.removeEventListener('navigate-to-session', listener);
      vi.useRealTimers();
    }
  });
});
