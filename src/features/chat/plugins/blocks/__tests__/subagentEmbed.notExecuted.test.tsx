import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Block } from '../../../core/types/block';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../../components/ChatContainer', () => ({ ChatContainer: () => null }));

const { default: SubagentEmbedBlockComponent } = await import('../subagentEmbed');

function makeBlock(patch: Partial<Block>): Block {
  return {
    id: 'blk_1',
    type: 'subagent_embed',
    status: 'pending',
    messageId: 'msg_1',
    toolName: 'builtin-super_dispatch_worker',
    toolCallId: 'call_1',
    ...patch,
  } as Block;
}

function renderBlock(block: Block) {
  const Component = SubagentEmbedBlockComponent as unknown as React.FC<{ block: Block; isStreaming?: boolean }>;
  return render(<Component block={block} isStreaming={false} />);
}

// 回归：Super 会话里在派发工具参数生成中途停止，卡片曾永久显示“执行中”转圈。
describe('subagent embed card for dispatches that never executed', () => {
  it('still shows the in-progress placeholder while the tool call is preparing', () => {
    renderBlock(makeBlock({ isPreparing: true, status: 'pending' }));
    expect(screen.getByText('subagent.status.running')).toBeInTheDocument();
    expect(screen.queryByTestId('subagent-embed-not-executed')).toBeNull();
  });

  it('shows "cancelled" instead of a spinner for a terminal preparing block', () => {
    renderBlock(makeBlock({ isPreparing: true, status: 'success' }));
    expect(screen.getByTestId('subagent-embed-not-executed')).toBeInTheDocument();
    expect(screen.getByText('subagent.status.cancelled')).toBeInTheDocument();
    expect(screen.queryByText('subagent.status.running')).toBeNull();
  });

  it('shows "cancelled" rather than a missing-session error when cancelled before execution', () => {
    renderBlock(makeBlock({
      isPreparing: false,
      status: 'error',
      error: 'Stream cancelled before tool execution',
    }));
    expect(screen.getByTestId('subagent-embed-not-executed')).toBeInTheDocument();
    expect(screen.queryByText('subagent.noSessionId')).toBeNull();
  });
});
