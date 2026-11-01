import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SuperInboxEventCard } from '../SuperInboxEventCard';
import { parseInboundOrigin } from '../inboundOrigin';
import { isSuperSession } from '../isSuperSession';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/ChatContainer', () => ({
  ChatContainer: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="worker-chat-container">{sessionId}</div>
  ),
}));

const origin = {
  kind: 'super_inbox',
  items: [
    {
      kind: 'worker',
      status: 'completed',
      workerId: 'subagent_explorer_01',
      title: '整理错题',
      summary: '已整理 12 道错题',
    },
    { kind: 'external', source: 'email', summary: '老师发来作业' },
  ],
};

describe('isSuperSession', () => {
  it('matches only active super_agent metadata', () => {
    expect(isSuperSession({ super_agent: { active: true } })).toBe(true);
    expect(isSuperSession({ super_agent: { active: false, retired_at: 'x' } })).toBe(false);
    expect(isSuperSession({ superagent: { active: true } })).toBe(false);
    expect(isSuperSession(null)).toBe(false);
  });
});

describe('parseInboundOrigin', () => {
  it('normalizes worker and external items, tolerating snake_case', () => {
    const items = parseInboundOrigin({
      items: [
        { type: 'worker.interrupted', agent_session_id: 'agent_1', worker_title: 'A' },
        { kind: 'worker_completion', status: 'failed', worker_id: 'agent_2' },
        { sender: 'external:webhook' },
      ],
    });
    expect(items.map((item) => [item.kind, item.status])).toEqual([
      ['worker', 'interrupted'],
      ['worker', 'failed'],
      ['external', 'message'],
    ]);
    expect(items[0].workerSessionId).toBe('agent_1');
    expect(items[2].source).toBe('webhook');
    expect(parseInboundOrigin('garbage')).toEqual([]);
  });
});

describe('SuperInboxEventCard', () => {
  it('renders one row per event with localized labels', () => {
    render(<SuperInboxEventCard origin={origin} content="<super_agent_inbox>raw</super_agent_inbox>" />);
    const card = screen.getByTestId('super-inbox-event-card');
    const rows = within(card).getAllByTestId('super-inbox-event-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Worker「整理错题」已完成')).toBeInTheDocument();
    expect(within(rows[0]).getByText('已整理 12 道错题')).toBeInTheDocument();
    expect(within(rows[1]).getByText('外部事件 · email')).toBeInTheDocument();
    expect(within(card).getByText('后台事件')).toBeInTheDocument();
    expect(within(card).getByText('2 条')).toBeInTheDocument();
  });

  it('expands and collapses the original text', () => {
    render(<SuperInboxEventCard origin={origin} content="<super_agent_inbox>raw body</super_agent_inbox>" />);
    expect(screen.queryByTestId('super-inbox-event-raw')).toBeNull();
    const toggle = screen.getByRole('button', { name: '查看原文' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('super-inbox-event-raw')).toHaveTextContent('raw body');
    fireEvent.click(screen.getByRole('button', { name: '收起原文' }));
    expect(screen.queryByTestId('super-inbox-event-raw')).toBeNull();
  });

  it('opens the worker session read-only when clicking view', async () => {
    render(<SuperInboxEventCard origin={origin} content="raw" />);
    fireEvent.click(screen.getByRole('button', { name: '查看 Worker「整理错题」的完整会话' }));
    expect(await screen.findByTestId('worker-chat-container')).toHaveTextContent('subagent_explorer_01');
  });

  it('falls back to a generic row for unknown origins', () => {
    render(<SuperInboxEventCard origin={{}} content="" />);
    expect(screen.getByText('收到新的后台事件')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看原文' })).toBeNull();
  });
});
