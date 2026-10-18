/**
 * content 正文块 - 用户消息密钥/令牌展示级脱敏组件测试
 *
 * 验证：
 * - 用户消息命中敏感串时默认渲染脱敏文本 + 提示行；
 * - 「显示原文 / 隐藏原文」按钮切换（aria-pressed 同步）；
 * - 内容变化后自动回到默认脱敏；
 * - assistant 消息 / 用户消息无命中时完全走原渲染路径（无提示行）。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';

import type { Block, ChatStore } from '@/features/chat/core/types';

// useMessage 的角色由每个用例控制；content.tsx 只消费 role
const mocks = vi.hoisted(() => ({
  role: 'user' as string,
}));

vi.mock('@/features/chat/components/renderers', () => ({
  StreamingBlockRenderer: ({ content }: { content: string }) => (
    <div data-testid="streaming-content">{content}</div>
  ),
}));

vi.mock('@/features/chat/hooks/useChatStore', () => ({
  useMessage: () => ({ role: mocks.role }),
  useMessageBlocks: () => [],
}));

import { ContentBlock } from '../content';

const SECRET_TEXT = '我的 key 是 ' + 'sk-' + 'abcdefghijklmnopqrstuv' + ' 请勿外传';
const MASKED_TEXT = '我的 key 是 sk-ab•••• 请勿外传';

function createStore(): StoreApi<ChatStore> {
  return {} as StoreApi<ChatStore>;
}

function createBlock(content: string): Block {
  return {
    id: 'blk_content',
    messageId: 'msg_1',
    type: 'content',
    status: 'success',
    content,
  } as Block;
}

function renderContent(content: string, store = createStore()) {
  return render(<ContentBlock block={createBlock(content)} store={store} />);
}

function renderedText(): string {
  return screen.getByTestId('streaming-content').textContent ?? '';
}

describe('content 正文块 - 用户消息展示级脱敏', () => {
  beforeEach(() => {
    mocks.role = 'user';
  });

  it('用户消息命中敏感串时默认渲染脱敏文本并显示提示', () => {
    renderContent(SECRET_TEXT);

    expect(renderedText()).toBe(MASKED_TEXT);
    expect(renderedText()).not.toContain('abcdefghijklmnopqrstuv');
    expect(screen.getByText('已隐藏 1 处疑似密钥/令牌')).toBeInTheDocument();

    const showButton = screen.getByRole('button', { name: '显示原文' });
    expect(showButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('点击「显示原文」渲染原文，再点「隐藏原文」恢复脱敏', () => {
    renderContent(SECRET_TEXT);

    fireEvent.click(screen.getByRole('button', { name: '显示原文' }));
    expect(renderedText()).toBe(SECRET_TEXT);
    const hideButton = screen.getByRole('button', { name: '隐藏原文' });
    expect(hideButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(hideButton);
    expect(renderedText()).toBe(MASKED_TEXT);
    expect(screen.getByRole('button', { name: '显示原文' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('多处命中时提示数量正确', () => {
    const text = `第一处 sk-${'a'.repeat(20)} 第二处 ghp_${'b'.repeat(24)}`;
    renderContent(text);

    expect(screen.getByText('已隐藏 2 处疑似密钥/令牌')).toBeInTheDocument();
    expect(renderedText()).not.toContain('a'.repeat(20));
    expect(renderedText()).not.toContain('b'.repeat(24));
  });

  it('块内容变化后重置「显示原文」状态（回到默认脱敏）', () => {
    const store = createStore();
    const { rerender } = renderContent(SECRET_TEXT, store);

    fireEvent.click(screen.getByRole('button', { name: '显示原文' }));
    expect(renderedText()).toBe(SECRET_TEXT);

    const nextText = '新的 key 是 ' + 'sk-' + 'zyxwvutsrqponmlkjihg' + ' 已更换';
    rerender(<ContentBlock block={createBlock(nextText)} store={store} />);

    expect(renderedText()).toBe('新的 key 是 sk-zy•••• 已更换');
    expect(screen.getByRole('button', { name: '显示原文' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('assistant 消息不脱敏、不显示提示行', () => {
    mocks.role = 'assistant';
    renderContent(SECRET_TEXT);

    expect(renderedText()).toBe(SECRET_TEXT);
    expect(screen.queryByText(/已隐藏/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('用户消息未命中敏感串时走原文路径且不显示提示行', () => {
    const text = '帮我总结这段普通中文内容，顺便看看这个 URL：https://example.com/page?page=2';
    renderContent(text);

    expect(renderedText()).toBe(text);
    expect(screen.queryByText(/已隐藏/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
