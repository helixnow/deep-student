import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from 'zustand';
import type { Block, ChatStore } from '../../../core/types';
import { useWorkspaceStore } from '../../../workspace/workspaceStore';

const { backgroundSubagent, cancelAgent, notify } = vi.hoisted(() => ({
  backgroundSubagent: vi.fn(), cancelAgent: vi.fn(), notify: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../../components/ChatContainer', () => ({ ChatContainer: () => null }));
vi.mock('../../../workspace/api', () => ({ backgroundSubagent, cancelAgent }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notify }));

const { default: SubagentEmbed } = await import('../subagentEmbed');
const parentStore = { getState: () => ({ sessionId: 'parent-session' }) } as StoreApi<ChatStore>;
const progress = { phase: 'dispatched', workspace_id: 'ws-1', agent_session_id: 'child-1',
  run_id: 'run-1', status: 'running', can_background: true };

function makeBlock(patch: Partial<Block> = {}): Block {
  return { id: 'block-1', type: 'subagent_embed', status: 'running', messageId: 'message-1',
    toolName: 'builtin-subagent_call', toolCallId: 'call-1', toolInput: { task: 'research', wait: true },
    content: `${JSON.stringify(progress)}\n`, startedAt: Date.now(), ...patch } as Block;
}

beforeEach(() => {
  vi.clearAllMocks();
  backgroundSubagent.mockResolvedValue(true);
  useWorkspaceStore.setState({ agents: [] });
});
afterEach(() => { cleanup(); useWorkspaceStore.setState({ agents: [] }); });

describe('subagent foreground-to-background action', () => {
  it('releases the owning parent block and keeps the child running with cancel available', async () => {
    const block = makeBlock();
    const view = render(<SubagentEmbed block={block} store={parentStore} />);
    fireEvent.click(screen.getByRole('button', { name: 'workspace:subagentEmbed.background' }));
    await screen.findByText('workspace:subagentEmbed.backgroundRunning');
    expect(backgroundSubagent).toHaveBeenCalledExactlyOnceWith('parent-session', 'block-1');
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'workspace:subagentEmbed.background' })).toBeNull();
    expect(screen.getByRole('button', { name: 'workspace:subagentEmbed.cancel' })).toBeInTheDocument();
    expect(block.toolInput).toEqual({ task: 'research', wait: true });

    view.rerender(<SubagentEmbed store={parentStore} block={makeBlock({ status: 'success', toolOutput: {
      workspace_id: 'ws-1', agent_session_id: 'child-1', run_id: 'run-1', status: 'completed',
      backgrounded: true, output: 'done',
    } })} />);
    expect(screen.getByText('subagent.status.completed')).toBeInTheDocument();
    expect(screen.queryByText('workspace:subagentEmbed.backgroundRunning')).toBeNull();
  });

  it('disables repeat clicks while the request is pending', async () => {
    let accept!: (value: boolean) => void;
    backgroundSubagent.mockReturnValue(new Promise<boolean>(resolve => { accept = resolve; }));
    render(<SubagentEmbed block={makeBlock()} store={parentStore} />);
    const button = screen.getByRole('button', { name: 'workspace:subagentEmbed.background' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(backgroundSubagent).toHaveBeenCalledTimes(1);
    accept(true);
    await screen.findByText('workspace:subagentEmbed.backgroundRunning');
  });

  it('reports errors without claiming the child is in background, and allows retry', async () => {
    backgroundSubagent.mockRejectedValueOnce(new Error('offline'));
    render(<SubagentEmbed block={makeBlock()} store={parentStore} />);
    fireEvent.click(screen.getByRole('button', { name: 'workspace:subagentEmbed.background' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'workspace:subagentEmbed.backgroundFailed'));
    expect(screen.queryByText('workspace:subagentEmbed.backgroundRunning')).toBeNull();
    const button = screen.getByRole('button', { name: 'workspace:subagentEmbed.background' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText('workspace:subagentEmbed.backgroundRunning');
  });

  it('treats an already-settled wait as a no-op', async () => {
    backgroundSubagent.mockResolvedValue(false);
    render(<SubagentEmbed block={makeBlock()} store={parentStore} />);
    fireEvent.click(screen.getByRole('button', { name: 'workspace:subagentEmbed.background' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('info', 'workspace:subagentEmbed.backgroundNoop'));
    expect(screen.queryByText('workspace:subagentEmbed.backgroundRunning')).toBeNull();
  });

  it.each([
    ['before dispatch', { content: undefined }],
    ['without a registered wait', { content: JSON.stringify({ ...progress, can_background: false }) }],
    ['already asynchronous', { toolInput: { task: 'research', wait: false } }],
    ['Super dispatch', { toolName: 'builtin-super_dispatch_worker' }],
    ['historical block', { status: 'success' }],
    ['failed block', { status: 'error' }],
  ] as [string, Partial<Block>][])('hides the action for %s', (_label, patch) => {
    render(<SubagentEmbed block={makeBlock(patch)} store={parentStore} />);
    expect(screen.queryByRole('button', { name: 'workspace:subagentEmbed.background' })).toBeNull();
  });

  it('requires the owning parent store instead of guessing the currently selected session', () => {
    render(<SubagentEmbed block={makeBlock()} />);
    expect(screen.queryByRole('button', { name: 'workspace:subagentEmbed.background' })).toBeNull();
  });

  it('restores the background label from persisted output while the child is still active', () => {
    useWorkspaceStore.setState({ agents: [{ sessionId: 'child-1', workspaceId: 'ws-1', role: 'worker',
      status: 'running', joinedAt: '', lastActiveAt: '' }] });
    render(<SubagentEmbed block={makeBlock({ status: 'success', toolOutput: {
      agent_session_id: 'child-1', workspace_id: 'ws-1', status: 'running', backgrounded: true,
    } })} store={parentStore} />);
    expect(screen.getByText('workspace:subagentEmbed.backgroundRunning')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'workspace:subagentEmbed.background' })).toBeNull();
  });

  it('preserves a queued child status instead of calling it running', () => {
    useWorkspaceStore.setState({ agents: [{ sessionId: 'child-1', workspaceId: 'ws-1', role: 'worker',
      status: 'queued', joinedAt: '', lastActiveAt: '' }] });
    render(<SubagentEmbed block={makeBlock({ toolOutput: { backgrounded: true } })} store={parentStore} />);
    expect(screen.getByText('subagent.status.queued')).toBeInTheDocument();
    expect(screen.queryByText('workspace:subagentEmbed.backgroundRunning')).toBeNull();
  });
});
