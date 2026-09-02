import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('../renderers', () => ({
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/features/chat/components/ui/TextShimmer', () => ({
  TextShimmer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

import { ActivityTimeline } from '../ActivityTimeline';
import type { Block } from '@/features/chat/core/types/block';

const zhChatV2 = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/chatV2.json'), 'utf-8')
) as {
  timeline: {
    thinking: {
      completed: string;
    };
  };
};

function createThinkingBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'thinking-1',
    type: 'thinking',
    status: 'success',
    messageId: 'message-1',
    content: '第一段思维链\n\n第二段思维链',
    startedAt: 1_000,
    endedAt: 9_000,
    ...overrides,
  };
}

function summaryRowOf(button: HTMLElement): HTMLElement | null {
  return button.parentElement;
}

describe('ActivityTimeline thinking summary', () => {
  it('uses the concise completed-thinking copy in zh-CN', () => {
    expect(zhChatV2.timeline.thinking.completed).toBe('已思考 {{seconds}} 秒');
  });

  it('renders completed thinking collapsed by default when auto-collapse is enabled', () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    const summaryRow = summaryRowOf(button);

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
    expect(summaryRow?.className).not.toContain('sticky');
    expect(summaryRow?.parentElement?.className).not.toContain('sticky');
  });

  it('lets the compact summary scroll with the chat when the thinking chain is expanded', () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    fireEvent.click(button);
    const summaryRow = summaryRowOf(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('第一段思维链')).toBeInTheDocument();
    expect(screen.getByText('第二段思维链')).toBeInTheDocument();
    expect(summaryRow?.className).not.toContain('sticky');
    expect(summaryRow?.className).not.toContain('top-0');
    expect(summaryRow?.parentElement?.className).not.toContain('sticky');
  });

  it('hides thinking content after the user collapses the thinking chain', async () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    fireEvent.click(button);
    expect(screen.getByText('第一段思维链')).toBeInTheDocument();

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
    });

    const collapsedSummary = summaryRowOf(button);
    expect(collapsedSummary?.className).not.toContain('sticky');
    expect(collapsedSummary?.className).not.toContain('top-0');
  });
});
