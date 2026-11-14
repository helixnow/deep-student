import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Block } from '../../../core/types/block';
import { useWorkspaceStore } from '../../../workspace/workspaceStore';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key), i18n: { language: 'zh-CN' } }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../../components/ChatContainer', () => ({
  ChatContainer: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`mock-chat-${sessionId}`} />
  ),
}));
vi.mock('../../../components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="mock-md">{content}</div>,
}));
vi.mock('../sessionPreheat', () => ({
  preheatSubagentSession: vi.fn(() => Promise.resolve()),
  shouldPreheatSubagentSession: vi.fn(() => false),
}));

const { default: SubagentEmbed } = await import('../subagentEmbed');
const { default: SleepBlock } = await import('../sleepBlock');

function makeSubagentBlock(patch: Partial<Block> = {}): Block {
  return {
    id: 'blk-sub-1',
    type: 'subagent_embed',
    status: 'success',
    messageId: 'msg-1',
    toolName: 'builtin-subagent_call',
    toolCallId: 'call-1',
    toolInput: { task: 'Inspect recent logs and summarize anomalies' },
    toolOutput: {
      session_id: 'agent-session-abcdef123456',
      workspace_id: 'ws-1',
      status: 'completed',
      task_summary: 'Inspect recent logs and summarize anomalies',
      output: 'Detailed final output should stay hidden when collapsed.',
      created_at: '2026-11-14T10:00:00.000Z',
      completed_at: '2026-11-14T10:01:00.000Z',
    },
    ...patch,
  } as Block;
}

function makeSleepBlock(patch: Partial<Block> = {}): Block {
  return {
    id: 'blk-sleep-1',
    type: 'sleep',
    status: 'running',
    messageId: 'msg-1',
    toolName: 'builtin-coordinator_sleep',
    toolCallId: 'call-sleep-1',
    toolInput: {
      workspace_id: 'ws-1',
      awaiting_agents: ['agent-child-111111222222'],
    },
    toolOutput: undefined,
    ...patch,
  } as Block;
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ agents: [] });
});

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ agents: [] });
});

describe('subagentEmbed modern mcpTool visual alignment', () => {
  it('uses neutral card styling and activity sweep without primary ring or spinner while running', () => {
    const { container } = render(
      <SubagentEmbed
        block={makeSubagentBlock({
          status: 'running',
          toolOutput: undefined,
          content: `${JSON.stringify({
            phase: 'dispatched',
            workspace_id: 'ws-1',
            agent_session_id: 'agent-session-abcdef123456',
            status: 'running',
            can_background: false,
          })}\n`,
        })}
      />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('border-border/50');
    expect(card.className).not.toContain('ring-2');
    expect(card.className).not.toContain('ring-primary/30');
    expect(container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('hides output preview and session footer when collapsed, and reveals them on expand', () => {
    const { container } = render(<SubagentEmbed block={makeSubagentBlock()} />);

    expect(screen.queryByText('Detailed final output should stay hidden when collapsed.')).toBeNull();
    expect(screen.queryByText('abcdef123456')).toBeNull();
    expect(screen.queryByTestId('mock-chat-agent-session-abcdef123456')).toBeNull();
    expect(container.querySelector('.text-success')).not.toBeNull(); // CheckCircle icon only

    // Click header to expand
    fireEvent.click(screen.getByText('Inspect recent logs and summarize anomalies'));

    expect(screen.getByText('Detailed final output should stay hidden when collapsed.')).toBeInTheDocument();
    expect(screen.getByText('abcdef123456')).toBeInTheDocument();
    expect(screen.getByTestId('mock-chat-agent-session-abcdef123456')).toBeInTheDocument();
  });

  it('shows compact destructive error strip when failed and collapsed', () => {
    const { container } = render(
      <SubagentEmbed
        block={makeSubagentBlock({
          status: 'error',
          toolOutput: {
            session_id: 'agent-session-abcdef123456',
            workspace_id: 'ws-1',
            status: 'failed',
            error: 'Subagent timed out during step 2',
          },
        })}
      />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-destructive/30');
    expect(screen.getByText('Subagent timed out during step 2')).toBeInTheDocument();
    expect(screen.queryByText('abcdef123456')).toBeNull();
  });
});

describe('sleepBlock modern mcpTool visual alignment', () => {
  it('uses neutral card styling without indigo banner or white wake button while sleeping', () => {
    useWorkspaceStore.setState({
      agents: [
        {
          sessionId: 'agent-child-111111222222',
          workspaceId: 'ws-1',
          role: 'worker',
          skillId: 'explorer',
          status: 'running',
          joinedAt: '',
          lastActiveAt: '',
        },
      ],
    });
    const { container } = render(<SleepBlock block={makeSleepBlock()} />);
    const html = container.innerHTML;

    expect(html).not.toContain('bg-indigo-');
    expect(html).not.toContain('border-indigo-');
    expect(html).not.toContain('bg-white');
    expect(html).not.toContain('dark:bg-gray-800');
    expect(container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();

    const wakeBtn = screen.getByRole('button', { name: 'sleep.wakeButton' });
    expect(wakeBtn).toBeInTheDocument();
    expect(screen.getByText('explorer')).toBeInTheDocument();
  });

  it('uses neutral border and destructive border only for cancelled without loud status banners', () => {
    const { container: awakenedContainer } = render(
      <SleepBlock
        block={makeSleepBlock({
          status: 'success',
          toolOutput: {
            sleep_id: 'sleep-123456789012',
            workspace_id: 'ws-1',
            coordinator_session_id: 'coord-1',
            awaiting_agents: [],
            wake_condition: { type: 'all_completed' },
            status: 'awakened',
            created_at: '2026-11-14T10:00:00.000Z',
            awakened_at: '2026-11-14T10:00:10.000Z',
          },
        })}
      />
    );
    expect(awakenedContainer.innerHTML).not.toContain('bg-success/10');
    expect((awakenedContainer.firstElementChild as HTMLElement).className).toContain('border-border/50');

    const { container: cancelledContainer } = render(
      <SleepBlock
        block={makeSleepBlock({
          status: 'error',
          toolOutput: {
            sleep_id: 'sleep-123456789012',
            workspace_id: 'ws-1',
            coordinator_session_id: 'coord-1',
            awaiting_agents: [],
            wake_condition: { type: 'all_completed' },
            status: 'cancelled',
            created_at: '2026-11-14T10:00:00.000Z',
          },
        })}
      />
    );
    expect(cancelledContainer.innerHTML).not.toContain('bg-danger/10');
    expect((cancelledContainer.firstElementChild as HTMLElement).className).toContain('border-destructive/30');
  });
});
