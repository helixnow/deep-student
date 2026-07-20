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
  ChatV2Page: ({ streamPreset, isSuspended }: { streamPreset?: string; isSuspended?: boolean }) => (
    <div
      data-testid="chat-v2-page"
      data-stream-preset={streamPreset ?? ''}
      data-suspended={isSuspended ? 'true' : 'false'}
    />
  ),
}));

vi.mock('../../system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: { current: null }, sizeClass: 'wide', heightClass: 'tall' }),
}));

vi.mock('../../system/SystemWindowShared', () => ({
  WorkbenchSidebarLayout: ({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) => (
    <div><aside>{sidebar}</aside><main>{children}</main></div>
  ),
  WbSysSkeleton: () => <div data-testid="chat-skeleton" />,
}));

import { ChatAppWindow } from '../ChatAppWindow';
import { STREAM_PRESET_DOWNSHIFT_DELAY_MS } from '../useDeferredStreamPreset';

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

  it('keeps the focused window on balanced full-speed streaming (parity with legacy)', async () => {
    render(<ChatAppWindow {...makeProps()} />);
    const page = await screen.findByTestId('chat-v2-page');
    expect(page).toHaveAttribute('data-stream-preset', 'balanced');
    expect(page).toHaveAttribute('data-suspended', 'false');
  });

  it('downshifts to silky after sustained invisibility and restores immediately on return', async () => {
    const { rerender } = render(<ChatAppWindow {...makeProps()} />);
    const page = await screen.findByTestId('chat-v2-page');

    vi.useFakeTimers();
    try {
      rerender(<ChatAppWindow {...makeProps({ isVisible: false })} />);
      // 瞬时失去可见性：宽限期内仍保持全速档
      expect(page).toHaveAttribute('data-stream-preset', 'balanced');

      act(() => {
        vi.advanceTimersByTime(STREAM_PRESET_DOWNSHIFT_DELAY_MS + 50);
      });
      expect(page).toHaveAttribute('data-stream-preset', 'silky');

      rerender(<ChatAppWindow {...makeProps({ isVisible: true })} />);
      expect(page).toHaveAttribute('data-stream-preset', 'balanced');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the shell suspension signal to the chat page', async () => {
    render(
      <ChatAppWindow {...makeProps({ isActive: false, isVisible: false, isSuspended: true })} />,
    );
    const page = await screen.findByTestId('chat-v2-page');
    expect(page).toHaveAttribute('data-suspended', 'true');
    // 挂载即不可见（background 恢复）：直接从 silky 起步
    expect(page).toHaveAttribute('data-stream-preset', 'silky');
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
