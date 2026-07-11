/**
 * P7 — ChatSessionSurface 挂载与多窗隔离冒烟（O16 扩展）
 *
 * ChatContainer 被 mock 掉（其内部管线由 chat 侧测试覆盖）；
 * 这里验证 surface 的组合职责：sessionId 透传、窗口级 DOM 作用域标记、
 * 可见性驱动的流式降频 preset（O16：延迟下档 / 立即升档）、
 * 焦点隔离视觉的 data-wb-chat-active 状态。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

vi.mock('@/features/chat/components/ChatContainer', async () => {
  const { useStreamPreferences } = await vi.importActual<
    typeof import('@/features/chat/components/renderers/StreamPreferencesContext')
  >('@/features/chat/components/renderers/StreamPreferencesContext');

  const ChatContainer: React.FC<{ sessionId: string; className?: string }> = ({ sessionId }) => {
    const prefs = useStreamPreferences();
    return (
      <div
        data-testid="mock-chat-container"
        data-session-id={sessionId}
        data-preset={prefs.preset ?? ''}
        data-mode={prefs.mode ?? ''}
      />
    );
  };
  return { ChatContainer, default: ChatContainer };
});

vi.mock('@/features/sandbox/components/SandboxWorkbenchSurface', () => ({
  SandboxWorkbenchSurface: ({ ownerKey }: { ownerKey?: string }) => (
    <div data-testid="mock-sandbox-surface" data-owner-key={ownerKey} />
  ),
}));

import { ChatSessionSurface } from '../ChatSessionSurface';
import { STREAM_PRESET_DOWNSHIFT_DELAY_MS } from '../useDeferredStreamPreset';
import {
  createChatSandboxOwnerKey,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type { SandboxSessionInput } from '@/features/sandbox/types';
import { launchSandboxWorkbench } from '@/features/sandbox/launchSandboxWorkbench';

function sandboxInput(title: string): SandboxSessionInput {
  return {
    sourceType: 'chat-code-block',
    sourceMessageId: `message-${title}`,
    language: 'html',
    title,
    content: `<h1>${title}</h1>`,
  };
}

beforeEach(() => {
  useSandboxWorkbenchStore.setState({
    activeSession: null,
    isOpen: false,
    viewportPreset: 'desktop',
    inspectorOpen: false,
    ownerStates: {},
    activeOwnerKey: 'sandbox:legacy',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatSessionSurface', () => {
  it('renders the session container and scopes the window DOM by sessionId', () => {
    const { container } = render(<ChatSessionSurface sessionId="sess_1" />);

    const inner = screen.getByTestId('mock-chat-container');
    expect(inner.getAttribute('data-session-id')).toBe('sess_1');

    const scoped = container.querySelector('[data-wb-chat-session="sess_1"]');
    expect(scoped).not.toBeNull();
    expect(scoped?.contains(inner)).toBe(true);
    expect(scoped?.getAttribute('data-sandbox-owner-key')).toBe(
      createChatSandboxOwnerKey('sess_1'),
    );
  });

  it('uses balanced preset + blocked mode when visible (parity with ChatV2Page)', () => {
    render(<ChatSessionSurface sessionId="sess_1" isVisible />);
    const inner = screen.getByTestId('mock-chat-container');
    expect(inner.getAttribute('data-preset')).toBe('balanced');
    expect(inner.getAttribute('data-mode')).toBe('blocked');
  });

  it('downshifts streaming preset when the window is not visible', () => {
    render(<ChatSessionSurface sessionId="sess_1" isVisible={false} />);
    const inner = screen.getByTestId('mock-chat-container');
    expect(inner.getAttribute('data-preset')).toBe('silky');
    expect(inner.getAttribute('data-mode')).toBe('blocked');
  });

  it('immediately downshifts when visible but renderThrottleMs > 0 (drag / non-focus)', () => {
    render(
      <ChatSessionSurface sessionId="sess_1" isVisible renderThrottleMs={500} />,
    );
    const inner = screen.getByTestId('mock-chat-container');
    expect(inner.getAttribute('data-preset')).toBe('silky');
  });

  it('defers the downshift after losing visibility (no abrupt stall), then downshifts', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ChatSessionSurface sessionId="sess_1" isVisible />);
    const inner = screen.getByTestId('mock-chat-container');

    // 瞬时失去可见性：宽限期内仍保持全速档
    rerender(<ChatSessionSurface sessionId="sess_1" isVisible={false} />);
    expect(inner.getAttribute('data-preset')).toBe('balanced');

    act(() => {
      vi.advanceTimersByTime(STREAM_PRESET_DOWNSHIFT_DELAY_MS - 50);
    });
    expect(inner.getAttribute('data-preset')).toBe('balanced');

    // 持续不可见：宽限期后真正降档
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(inner.getAttribute('data-preset')).toBe('silky');
  });

  it('upshifts immediately when visibility returns (full-speed catch-up)', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ChatSessionSurface sessionId="sess_1" isVisible={false} />);
    const inner = screen.getByTestId('mock-chat-container');
    expect(inner.getAttribute('data-preset')).toBe('silky');

    rerender(<ChatSessionSurface sessionId="sess_1" isVisible />);
    expect(inner.getAttribute('data-preset')).toBe('balanced');
  });

  it('cancels a pending downshift if visibility returns within the grace window', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ChatSessionSurface sessionId="sess_1" isVisible />);
    const inner = screen.getByTestId('mock-chat-container');

    rerender(<ChatSessionSurface sessionId="sess_1" isVisible={false} />);
    act(() => {
      vi.advanceTimersByTime(STREAM_PRESET_DOWNSHIFT_DELAY_MS / 2);
    });
    rerender(<ChatSessionSurface sessionId="sess_1" isVisible />);

    // 宽限期内的下档定时器应被取消，不会事后偷偷降档
    act(() => {
      vi.advanceTimersByTime(STREAM_PRESET_DOWNSHIFT_DELAY_MS * 2);
    });
    expect(inner.getAttribute('data-preset')).toBe('balanced');
  });

  it('exposes focus state via data-wb-chat-active for input-isolation visuals', () => {
    const { container, rerender } = render(
      <ChatSessionSurface sessionId="sess_1" isActive isVisible />,
    );
    const root = container.querySelector('[data-wb-chat-session="sess_1"]');
    expect(root?.getAttribute('data-wb-chat-active')).toBe('true');
    expect(root?.classList.contains('wb-chat-surface')).toBe(true);

    rerender(<ChatSessionSurface sessionId="sess_1" isActive={false} isVisible />);
    expect(root?.getAttribute('data-wb-chat-active')).toBe('false');
  });

  it('two surfaces with different sessionIds coexist without cross-talk (smoke)', () => {
    const { container } = render(
      <>
        <ChatSessionSurface sessionId="sess_a" isVisible />
        <ChatSessionSurface sessionId="sess_b" isVisible={false} />
      </>,
    );

    const containers = screen.getAllByTestId('mock-chat-container');
    expect(containers).toHaveLength(2);

    const ids = containers.map((el) => el.getAttribute('data-session-id'));
    expect(ids).toEqual(['sess_a', 'sess_b']);

    // 每窗独立的降频档位（Context 逐窗隔离）
    expect(containers[0].getAttribute('data-preset')).toBe('balanced');
    expect(containers[1].getAttribute('data-preset')).toBe('silky');

    // DOM 作用域互不包含
    const rootA = container.querySelector('[data-wb-chat-session="sess_a"]');
    const rootB = container.querySelector('[data-wb-chat-session="sess_b"]');
    expect(rootA?.contains(containers[1])).toBe(false);
    expect(rootB?.contains(containers[0])).toBe(false);
  });

  it('activates the owner of the chat window receiving pointer input', () => {
    const { container } = render(
      <>
        <ChatSessionSurface sessionId="sess_a" isVisible />
        <ChatSessionSurface sessionId="sess_b" isVisible />
      </>,
    );
    const rootA = container.querySelector('[data-wb-chat-session="sess_a"]')!;
    const rootB = container.querySelector('[data-wb-chat-session="sess_b"]')!;

    fireEvent.pointerDown(rootA);
    expect(useSandboxWorkbenchStore.getState().activeOwnerKey).toBe(
      createChatSandboxOwnerKey('sess_a'),
    );
    fireEvent.pointerDown(rootB);
    expect(useSandboxWorkbenchStore.getState().activeOwnerKey).toBe(
      createChatSandboxOwnerKey('sess_b'),
    );
  });

  it('routes the legacy code-block launcher into the window that received the click', () => {
    const { container } = render(
      <>
        <ChatSessionSurface sessionId="sess_a" isVisible />
        <ChatSessionSurface sessionId="sess_b" isVisible />
      </>,
    );
    const rootA = container.querySelector('[data-wb-chat-session="sess_a"]')!;

    fireEvent.pointerDown(rootA);
    act(() => {
      launchSandboxWorkbench(sandboxInput('A'));
    });

    const sandbox = screen.getByTestId('mock-sandbox-surface');
    expect(sandbox).toHaveAttribute('data-owner-key', createChatSandboxOwnerKey('sess_a'));
    expect(selectSandboxWorkbenchOwnerState(
      useSandboxWorkbenchStore.getState(),
      createChatSandboxOwnerKey('sess_b'),
    ).activeSession).toBeNull();
  });

  it('renders only the sandbox session owned by each chat window', () => {
    render(
      <>
        <ChatSessionSurface sessionId="sess_a" isVisible />
        <ChatSessionSurface sessionId="sess_b" isVisible />
      </>,
    );

    const ownerA = createChatSandboxOwnerKey('sess_a');
    const ownerB = createChatSandboxOwnerKey('sess_b');
    act(() => {
      useSandboxWorkbenchStore.getState().openSession(sandboxInput('A'), ownerA);
    });

    expect(screen.getAllByTestId('mock-sandbox-surface')).toHaveLength(1);
    expect(screen.getByTestId('mock-sandbox-surface')).toHaveAttribute('data-owner-key', ownerA);
    expect(selectSandboxWorkbenchOwnerState(useSandboxWorkbenchStore.getState(), ownerB).activeSession).toBeNull();

    act(() => {
      useSandboxWorkbenchStore.getState().openSession(sandboxInput('B'), ownerB);
    });
    expect(screen.getAllByTestId('mock-sandbox-surface').map((node) => node.getAttribute('data-owner-key')))
      .toEqual([ownerA, ownerB]);

    act(() => {
      useSandboxWorkbenchStore.getState().closeSession(ownerB);
    });
    expect(screen.getAllByTestId('mock-sandbox-surface')).toHaveLength(1);
    expect(screen.getByTestId('mock-sandbox-surface')).toHaveAttribute('data-owner-key', ownerA);
    expect(selectSandboxWorkbenchOwnerState(useSandboxWorkbenchStore.getState(), ownerA).activeSession?.title).toBe('A');
  });

});
