/**
 * Chat V2 - BlockRenderer 单元测试
 *
 * 测试要点：
 * - 应该渲染已注册的块组件
 * - 对未知类型应该渲染 GenericBlock
 * - 应该传递 isStreaming 属性
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { BlockRenderer } from '@/chat-v2/components/BlockRenderer';
import { blockRegistry } from '@/chat-v2/registry';
import type { Block } from '@/chat-v2/core/types';

// Mock blockRegistry
vi.mock('@/chat-v2/registry', () => ({
  blockRegistry: {
    get: vi.fn(),
  },
}));

// Mock 组件
const MockThinkingBlock: React.FC<{ block: Block; isStreaming?: boolean }> = ({
  block,
  isStreaming,
}) => (
  <div data-testid="thinking-block">
    <span data-testid="block-type">{block.type}</span>
    <span data-testid="is-streaming">{isStreaming ? 'true' : 'false'}</span>
    <span data-testid="block-content">{block.content}</span>
  </div>
);

const MockContentBlock: React.FC<{ block: Block; isStreaming?: boolean }> = ({
  block,
  isStreaming,
}) => (
  <div data-testid="content-block">
    <span data-testid="block-type">{block.type}</span>
    <span data-testid="is-streaming">{isStreaming ? 'true' : 'false'}</span>
  </div>
);

describe('BlockRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('should render registered block component', () => {
    // 设置 mock 返回已注册的组件
    vi.mocked(blockRegistry.get).mockReturnValue({
      type: 'thinking',
      component: MockThinkingBlock,
      onAbort: 'keep-content',
    });

    const block: Block = {
      id: 'block-1',
      type: 'thinking',
      status: 'running',
      messageId: 'msg-1',
      content: 'Test thinking content',
    };

    render(<BlockRenderer block={block} isStreaming={true} />);

    // 验证渲染了正确的组件
    expect(screen.getByTestId('thinking-block')).toBeInTheDocument();
    expect(screen.getByTestId('block-type')).toHaveTextContent('thinking');
    expect(screen.getByTestId('block-content')).toHaveTextContent('Test thinking content');

    // 验证从注册表获取组件
    expect(blockRegistry.get).toHaveBeenCalledWith('thinking');
  });

  it('should render GenericBlock for unknown type', () => {
    // 设置 mock 返回 undefined（未注册的类型）
    vi.mocked(blockRegistry.get).mockReturnValue(undefined);

    const block: Block = {
      id: 'block-2',
      type: 'unknown_type',
      status: 'success',
      messageId: 'msg-2',
      content: 'Unknown content',
    };

    render(<BlockRenderer block={block} />);

    // 验证渲染了 fallback 内容（GenericBlock 显示 block type）
    expect(screen.getByText(/unknown_type/i)).toBeInTheDocument();
    expect(screen.getByText(/Unknown content/i)).toBeInTheDocument();

    // 验证尝试从注册表获取组件
    expect(blockRegistry.get).toHaveBeenCalledWith('unknown_type');
  });

  it('should pass isStreaming prop', () => {
    // 设置 mock
    vi.mocked(blockRegistry.get).mockReturnValue({
      type: 'content',
      component: MockContentBlock,
      onAbort: 'keep-content',
    });

    const block: Block = {
      id: 'block-3',
      type: 'content',
      status: 'running',
      messageId: 'msg-3',
    };

    // 测试 isStreaming=true
    const { rerender } = render(<BlockRenderer block={block} isStreaming={true} />);
    expect(screen.getByTestId('is-streaming')).toHaveTextContent('true');

    // 测试 isStreaming=false
    rerender(<BlockRenderer block={block} isStreaming={false} />);
    expect(screen.getByTestId('is-streaming')).toHaveTextContent('false');

    // 测试默认值（undefined 应该转为 false）
    rerender(<BlockRenderer block={block} />);
    expect(screen.getByTestId('is-streaming')).toHaveTextContent('false');
  });

  it('should not use switch/case for block type dispatch', () => {
    // 这个测试验证 BlockRenderer 使用注册表获取组件
    // 而不是通过 switch/case 硬编码
    const block: Block = {
      id: 'block-4',
      type: 'any_type',
      status: 'pending',
      messageId: 'msg-4',
    };

    render(<BlockRenderer block={block} />);

    // 验证调用了 registry.get，而不是硬编码的 switch
    expect(blockRegistry.get).toHaveBeenCalledWith('any_type');
  });
});
