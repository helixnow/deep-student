/**
 * O16 — ChatWindowSkeleton 骨架屏测试
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatWindowSkeleton } from '../ChatWindowSkeleton';

describe('ChatWindowSkeleton', () => {
  it('renders an accessible loading status with default label', () => {
    render(<ChatWindowSkeleton />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-label')).toBe('正在加载会话…');
  });

  it('accepts a custom status text', () => {
    render(<ChatWindowSkeleton statusText="正在准备会话…" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('正在准备会话…');
  });

  it('renders message-bubble bones and a composer placeholder (hidden from AT)', () => {
    const { container } = render(<ChatWindowSkeleton />);

    const thread = container.querySelector('.wb-chat-skeleton__thread');
    expect(thread).not.toBeNull();
    expect(thread?.getAttribute('aria-hidden')).toBe('true');

    // 用户气泡 + 助手头像行 + 输入栏面板都在
    expect(container.querySelectorAll('.wb-chat-skeleton__bubble').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('.wb-chat-skeleton__avatar').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.wb-chat-skeleton__composer')).not.toBeNull();

    // 骨架骨骼带错峰动画延迟变量
    const bones = container.querySelectorAll<HTMLElement>('.wb-chat-skeleton__bone');
    expect(bones.length).toBeGreaterThan(5);
    expect(bones[0].style.getPropertyValue('--wb-chat-bone-i')).toBe('0');
  });
});
