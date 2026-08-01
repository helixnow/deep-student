import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Block } from '@/features/chat/core/types/block';

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
import {
  getShellCommandDescriptor,
  shellCommandPlaceholder,
} from '../ActivityTimeline/ShellCommandTimelineView';

function createShellBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'shell-1',
    type: 'mcp_tool',
    status: 'success',
    messageId: 'message-1',
    toolName: 'builtin-local_shell_execute',
    toolInput: { command: 'uname -s', root_id: 'artifacts', cwd: 'terminal-test' },
    toolOutput: {
      command: 'uname -s',
      root_id: 'artifacts',
      cwd: 'terminal-test',
      success: true,
      exit_code: 0,
      duration_ms: 24,
      stdout: 'Darwin\n',
      stderr: '',
    },
    startedAt: 1_000,
    endedAt: 1_024,
    ...overrides,
  };
}

function createPreflightBlock(overrides: Partial<Block> = {}): Block {
  return createShellBlock({
    id: 'preflight-1',
    toolName: 'builtin-local_shell_preflight',
    toolOutput: {
      command: 'uname -s',
      root_id: 'temp',
      cwd: '.',
      risk_level: 'low',
      reasons: [],
      would_execute: false,
    },
    ...overrides,
  });
}

function createResourceBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'resource-1',
    type: 'mcp_tool',
    status: 'success',
    messageId: 'message-1',
    toolName: 'builtin-resource_list',
    toolInput: {},
    toolOutput: { items: [] },
    ...overrides,
  };
}

describe('ActivityTimeline shell command nodes', () => {
  it('derives a blocked command summary from a successful preflight tool call', () => {
    const descriptor = getShellCommandDescriptor({
      toolName: 'builtin-local_shell_preflight',
      toolInput: { command: 'uname -s', root_id: 'temp' },
      toolOutput: {
        command: 'uname -s',
        root_id: 'temp',
        risk_level: 'blocked',
        would_execute: false,
        reasons: ['working directory does not exist'],
      },
      toolStatus: 'success',
    });

    expect(descriptor).toMatchObject({
      kind: 'preflight',
      command: 'uname -s',
      verbKey: 'blocked',
      tone: 'error',
    });
  });

  it('shows the command summary instead of the English tool name', () => {
    render(<ActivityTimeline blocks={[createShellBlock()]} isStreaming={false} />);

    expect(screen.getByText('timeline.shell.ran')).toBeInTheDocument();
    expect(screen.getByText('uname -s')).toBeInTheDocument();
    expect(screen.queryByText(/Local Shell Execute/i)).not.toBeInTheDocument();
  });

  it('expands the command into the dedicated shell output block', () => {
    render(<ActivityTimeline blocks={[createShellBlock()]} isStreaming={false} />);

    fireEvent.click(screen.getByRole('button', { name: /timeline\.shell\.ran.*uname -s/i }));

    expect(screen.getByText('Darwin')).toBeInTheDocument();
    expect(screen.getByText('shellOutput.exitCode')).toBeInTheDocument();
    expect(screen.queryByText('timeline.tool.input')).not.toBeInTheDocument();
  });

  it('renders preflight and execute as one command lifecycle', () => {
    render(<ActivityTimeline blocks={[createPreflightBlock(), createShellBlock()]} isStreaming={false} />);

    expect(screen.queryByText('timeline.shell.checked')).not.toBeInTheDocument();
    expect(screen.getByText('timeline.shell.ran')).toBeInTheDocument();
    expect(screen.getAllByText('uname -s')).toHaveLength(1);
  });

  it('keeps only the latest blocked preflight when execution never starts', () => {
    render(<ActivityTimeline blocks={[
      createPreflightBlock({
        id: 'preflight-workspace',
        toolOutput: {
          command: 'uname -s',
          root_id: 'workspace',
          risk_level: 'blocked',
          reasons: ['workspace is not configured'],
          would_execute: false,
        },
      }),
      createPreflightBlock({
        id: 'preflight-temp',
        toolOutput: {
          command: 'uname -s',
          root_id: 'temp',
          risk_level: 'blocked',
          reasons: ['approval required'],
          would_execute: false,
        },
      }),
    ]} isStreaming={false} />);

    expect(screen.getAllByText('timeline.shell.blocked')).toHaveLength(1);
    expect(screen.getAllByText('uname -s')).toHaveLength(1);
    expect(screen.queryByText('workspace is not configured')).not.toBeInTheDocument();
  });
});

describe('ActivityTimeline tool groups', () => {
  it('combines adjacent ordinary tool calls into one expandable row', () => {
    render(<ActivityTimeline blocks={[
      createResourceBlock(),
      createResourceBlock({ id: 'resource-2', toolName: 'builtin-folder_list' }),
    ]} isStreaming={false} />);

    const group = screen.getByRole('button', { name: /timeline\.tool\.groupSummary/i });
    expect(screen.queryByText('tools.resource_list')).not.toBeInTheDocument();

    fireEvent.click(group);

    expect(screen.getByText('tools.resource_list')).toBeInTheDocument();
    expect(screen.getByText('tools.folder_list')).toBeInTheDocument();
  });
});

describe('shellCommandPlaceholder', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    String(options?.defaultValue ?? key);

  it('returns command when present', () => {
    expect(
      shellCommandPlaceholder(
        {
          kind: 'preflight',
          verbKey: 'checking',
          tone: 'running',
          command: 'uname -s',
          reasons: [],
        },
        t,
      ),
    ).toBe('uname -s');
  });

  it('shows preparing copy while checking or running without command', () => {
    expect(
      shellCommandPlaceholder(
        {
          kind: 'preflight',
          verbKey: 'checking',
          tone: 'running',
          command: '',
          reasons: [],
        },
        t,
      ),
    ).toBe('参数生成中…');
    expect(
      shellCommandPlaceholder(
        {
          kind: 'execute',
          verbKey: 'running',
          tone: 'running',
          command: '',
          reasons: [],
        },
        t,
      ),
    ).toBe('参数生成中…');
  });

  it('shows interrupted copy when failed without command', () => {
    expect(
      shellCommandPlaceholder(
        {
          kind: 'execute',
          verbKey: 'failed',
          tone: 'error',
          command: '',
          reasons: [],
        },
        t,
      ),
    ).toBe('命令已中断（未收到参数）');
  });
});
