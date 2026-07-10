/**
 * O16 — ChatWindowFrame 先导轻壳测试
 *
 * 重 chunk（ChatAppWindow）lazy 加载期间应显示消息骨架屏而非空白/转圈；
 * 加载完成后渲染真实窗口并透传 AppWindowProps。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AppWindowProps } from '../../../core/types';

vi.mock('../ChatAppWindow', () => {
  const MockChatAppWindow: React.FC<AppWindowProps> = ({ windowId, instanceKey }) => (
    <div data-testid="mock-chat-app-window" data-window-id={windowId} data-instance-key={instanceKey ?? ''} />
  );
  return { ChatAppWindow: MockChatAppWindow, default: MockChatAppWindow };
});

import { ChatWindowFrame } from '../ChatWindowFrame';

function makeProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'win_frame',
    instanceKey: 'sess_frame',
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('ChatWindowFrame', () => {
  it('shows the message skeleton while the heavy chunk loads, then the real window', async () => {
    render(<ChatWindowFrame {...makeProps()} />);

    // lazy 未解析的首帧：骨架屏占位（非空白/转圈）
    expect(document.querySelector('[data-wb-chat-skeleton]')).not.toBeNull();

    // chunk 就绪后渲染真实窗口，props 完整透传
    const real = await screen.findByTestId('mock-chat-app-window');
    expect(real.getAttribute('data-window-id')).toBe('win_frame');
    expect(real.getAttribute('data-instance-key')).toBe('sess_frame');
    expect(document.querySelector('[data-wb-chat-skeleton]')).toBeNull();
  });
});
