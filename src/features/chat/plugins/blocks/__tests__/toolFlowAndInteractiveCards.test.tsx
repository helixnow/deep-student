import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Block } from '../../../core/types/block';
import { useWorkspaceStore } from '../../../workspace/workspaceStore';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'defaultValue' in opts && typeof opts.defaultValue === 'string') {
        return opts.defaultValue;
      }
      return opts ? `${key}:${JSON.stringify(opts)}` : key;
    },
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}));

vi.mock('../../../components/renderers', () => ({
  StreamingMarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-streaming-md">{content}</div>
  ),
}));

const { blockRegistry } = await import('../../../registry');
await import('../workspaceStatus');
await import('../workspaceSend');
await import('../workspaceInjection');
await import('../subagentRetry');
const { ToolLimitBlock } = await import('../toolLimit');
const { CompactionSummaryBlock } = await import('../compactionSummary');
const { GenericBlock } = await import('../generic');
const { WorkspaceLogInline } = await import('../../../workspace/components/WorkspaceLogInline');

const WorkspaceStatusBlock = blockRegistry.get('workspace_status')!.component;
const WorkspaceSendBlock = blockRegistry.get('workspace_send')!.component;
const WorkspaceInjectionBlock = blockRegistry.get('workspace_injection')!.component;
const SubagentRetryBlock = blockRegistry.get('subagent_retry')!.component;

function makeBlock(type: Block['type'], patch: Partial<Block> = {}): Block {
  return {
    id: `blk-${type}`,
    type,
    status: 'success',
    messageId: 'msg-1',
    content: '',
    ...patch,
  } as Block;
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({
    workspace: null,
    agents: [],
    messages: [],
    currentWorkspaceId: null,
  });
});

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({
    workspace: null,
    agents: [],
    messages: [],
    currentWorkspaceId: null,
  });
});

describe('workspaceStatus neutral card & semantic tokens', () => {
  it('defaults details to collapsed and uses neutral ToolActivitySweep header while running', () => {
    useWorkspaceStore.setState({
      workspace: {
        id: 'ws-1',
        name: 'Research Workspace',
        creatorSessionId: 'coord-1',
        status: 'active',
        createdAt: '2026-11-14T10:00:00.000Z',
      } as any,
      currentWorkspaceId: 'ws-1',
      agents: [
        {
          sessionId: 'agent-12345678',
          workspaceId: 'ws-1',
          role: 'worker',
          skillId: 'explorer',
          status: 'running',
          joinedAt: '2026-11-14T10:00:00.000Z',
          lastActiveAt: '2026-11-14T10:00:00.000Z',
        },
      ],
      messages: [
        {
          id: 'm1',
          workspaceId: 'ws-1',
          senderSessionId: 'coord-1',
          messageType: 'task',
          content: 'Check paper metadata',
          createdAt: '2026-11-14T10:01:00.000Z',
        },
      ],
    });

    const { container } = render(
      <WorkspaceStatusBlock
        block={makeBlock('workspace_status', {
          status: 'running',
          toolInput: { workspaceId: 'ws-1', workspaceName: 'Research Workspace' },
        })}
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('border-border/50');
    expect(card.className).toContain('bg-card');
    expect(container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    // Collapsed by default: agent list not expanded
    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByText(/ID: 12345678/)).not.toBeInTheDocument();

    // Expanding reveals agents and semantic message type badges (no hardcoded bg-blue-100)
    fireEvent.click(toggle);
    expect(screen.getByText(/ID: 12345678/)).toBeInTheDocument();
    const recentToggle = screen.getByText(/workspace\.status\.recentMessagesCount/);
    fireEvent.click(recentToggle);
    expect(container.innerHTML).not.toContain('bg-blue-100');
    expect(container.innerHTML).toContain('bg-info/10');
  });

  it('renders historical snapshot without top full-width colored banner and collapsed by default', () => {
    const { container } = render(
      <WorkspaceStatusBlock
        block={makeBlock('workspace_status', {
          toolOutput: {
            workspace_id: 'ws-old',
            status: 'completed',
            snapshotName: 'Legacy WS',
            snapshotAgents: [{ session_id: 'agent-old-1111', role: 'worker', status: 'completed' }],
          },
        })}
      />,
    );

    expect(container.innerHTML).not.toContain('bg-info/10 border-b border-info/30');
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
  });
});

describe('workspaceSend & workspaceInjection & WorkspaceLogInline', () => {
  it('replaces animate-spin with ToolActivitySweep + PulseDot while running', () => {
    const { container: sendContainer } = render(
      <WorkspaceSendBlock
        block={makeBlock('workspace_send', {
          status: 'running',
          toolInput: { content: 'Please check section 2', message_type: 'task' },
        })}
      />,
    );
    expect(sendContainer.firstElementChild?.className).toContain('bg-card');
    expect(sendContainer.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(sendContainer.querySelector('.animate-spin')).toBeNull();

    const { container: injContainer } = render(
      <WorkspaceInjectionBlock
        block={makeBlock('workspace_injection', {
          status: 'running',
          content: 'Injected instruction',
          toolOutput: { message_types: ['progress'] },
        })}
      />,
    );
    expect(injContainer.firstElementChild?.className).toContain('bg-card');
    expect(injContainer.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(injContainer.querySelector('.animate-spin')).toBeNull();
  });

  it('renders WorkspaceLogInline with neutral h-7 w-7 badge and text-xs title', () => {
    useWorkspaceStore.setState({
      workspace: {
        id: 'ws-log',
        name: 'Log WS',
        creatorSessionId: 'coord-1',
        status: 'active',
        createdAt: '2026-11-14T10:00:00.000Z',
      } as any,
      messages: [
        {
          id: 'm1',
          workspaceId: 'ws-log',
          senderSessionId: 'coord-1',
          messageType: 'result',
          content: 'Done',
          createdAt: '2026-11-14T10:01:00.000Z',
        },
      ],
    });

    const { container } = render(<WorkspaceLogInline />);
    const title = screen.getByText('workspace.log.title');
    expect(title.className).toContain('text-xs');
    expect(container.querySelector('.h-7.w-7')).not.toBeNull();
  });
});

describe('subagentRetry neutral alignment', () => {
  it('removes full-card tinting, rounded-full avatar, and animate-spin', () => {
    const { container, rerender } = render(
      <SubagentRetryBlock
        block={makeBlock('subagent_retry', {
          status: 'running',
          toolInput: { agentSessionId: 'sub-session-12345678' },
        })}
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('border-border/50');
    expect(card.className).not.toContain('bg-warning/5');
    expect(container.querySelector('.rounded-full.w-8.h-8')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.tool-activity-sweep--active')).not.toBeNull();

    rerender(
      <SubagentRetryBlock
        block={makeBlock('subagent_retry', {
          status: 'error',
          toolInput: { agentSessionId: 'sub-session-12345678' },
          toolOutput: { message: 'Failed after max retries', timestamp: '2026-11-14T10:00:00.000Z', reason: 'max_retries_exceeded' },
        })}
      />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('border-destructive/30');
    expect((container.firstElementChild as HTMLElement).className).not.toContain('bg-destructive/5');
  });
});

describe('toolLimit neutral surface & warning-foreground CTA', () => {
  it('uses bg-card, border-warning/40, h-7 w-7 badge, and text-warning-foreground', () => {
    const onContinue = vi.fn();
    const { container } = render(
      <ToolLimitBlock
        block={makeBlock('tool_limit', {
          content: 'Tool limit reached.\n\n• Step 1',
        })}
        onContinue={onContinue}
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('border-warning/40');
    expect(card.className).not.toContain('bg-warning/10');
    expect(card.className).not.toContain('shadow-sm');
    expect(container.querySelector('.h-7.w-7')).not.toBeNull();

    const continueBtn = screen.getByRole('button', { name: /tool_limit\.continue/ });
    expect(continueBtn.className).toContain('text-warning-foreground');
    expect(continueBtn.className).not.toContain('text-white');
    expect(continueBtn.className).toContain('[@media(pointer:coarse)]:!min-h-11');
  });
});

describe('compactionSummary & generic neutral alignment', () => {
  it('renders compactionSummary with neutral card and h-7 w-7 warning icon badge', () => {
    const { container } = render(
      <CompactionSummaryBlock
        block={makeBlock('compaction_summary', {
          content: 'Summary body',
        })}
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('border-border/50');
    expect(card.className).not.toContain('bg-warning/5');
    expect(container.querySelector('.h-7.w-7.bg-warning\\/10')).not.toBeNull();
  });

  it('renders generic block aligned with ToolHeader without animate-spin', () => {
    const { container } = render(
      <GenericBlock
        block={makeBlock('custom_unknown' as Block['type'], {
          status: 'running',
          toolInput: { a: 1 },
        })}
        isStreaming
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('border-border/50');
    expect(container.querySelector('.h-7.w-7')).not.toBeNull();
    expect(container.querySelector('.tool-activity-sweep--active')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByText('custom_unknown')).toBeInTheDocument();
  });
});
