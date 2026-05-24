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

describe('ActivityTimeline thinking summary', () => {
  it('uses the concise completed-thinking copy in zh-CN', () => {
    expect(zhChatV2.timeline.thinking.completed).toBe('已思考 {{seconds}} 秒');
  });

  it('renders the thinking chain expanded by default and keeps the compact summary sticky while expanded', () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    const stickySummary = button.parentElement?.parentElement;

    expect(screen.getByText('第一段思维链')).toBeInTheDocument();
    expect(screen.getByText('第二段思维链')).toBeInTheDocument();
    expect(stickySummary?.className).toContain('sticky');
    expect(stickySummary?.className).toContain('top-0');
  });

  it('removes the sticky summary treatment after the user collapses the thinking chain', async () => {
    render(<ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />);

    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
    });

    const collapsedSummary = button.parentElement?.parentElement;
    expect(collapsedSummary?.className).not.toContain('sticky');
    expect(collapsedSummary?.className).not.toContain('top-0');
  });

  it('keeps the summary pinned when collapsing from the sticky top position', async () => {
    const { container } = render(
      <div style={{ height: '180px', overflowY: 'auto' }}>
        <div style={{ height: '220px' }} />
        <ActivityTimeline blocks={[createThinkingBlock()]} isStreaming={false} />
        <div style={{ height: '400px' }} />
      </div>
    );

    const scrollContainer = container.firstElementChild as HTMLDivElement;
    const button = screen.getByRole('button', { name: 'timeline.thinking.completed' });
    const stickySummary = button.parentElement?.parentElement as HTMLDivElement;

    const originalGetBoundingClientRect = stickySummary.getBoundingClientRect.bind(stickySummary);
    vi.spyOn(stickySummary, 'getBoundingClientRect').mockImplementation(() => ({
      ...originalGetBoundingClientRect(),
      top: 0,
      bottom: 32,
    } as DOMRect));
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 180,
      left: 0,
      right: 800,
      width: 800,
      height: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.queryByText('第一段思维链')).not.toBeInTheDocument();
    });

    expect(stickySummary.className).toContain('sticky');
    expect(stickySummary.className).toContain('top-0');
  });
});
