import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { McpToolBlockComponent } from '@/features/chat/plugins/blocks/mcpTool';
import type { Block } from '@/features/chat/core/types/block';
import { createWorkshopIntegration } from '../integration';
import type { WorkshopAdapter, WorkshopItem } from '../types';

const item: WorkshopItem = { id: 'workshop.one', proposalId: 'work-1', revision: 5, name: '真实状态标题', version: '1', capabilities: ['service:notes'], changes: ['增加复习入口'], trust: 'full', phase: 'ready', visualVerified: false };
function fixture() {
  const unsubscribe = vi.fn();
  const adapter: WorkshopAdapter = { list: vi.fn().mockResolvedValue([item]), get: vi.fn(), act: vi.fn().mockResolvedValue({ item: { ...item, phase: 'installed' } }), subscribe: vi.fn(() => unsubscribe) };
  const sessions = { bindSession: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue({ id: 'new-session' }), activateSkill: vi.fn().mockResolvedValue(true), navigate: vi.fn() };
  const reportError = vi.fn();
  return { adapter, sessions, reportError, unsubscribe, integration: createWorkshopIntegration({ adapter, sessions, reportError }) };
}

describe('workshop composition (real UI slot, adapter doubles)', () => {
  it('renders through existing tool result slot, reconciles persisted output and releases subscriptions', async () => {
    const f = fixture();
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'example.workshop-ui' }, apply(ctx) {
      ctx.ui.contribute('chat.toolResults', { id: 'confirmation', key: 'dstu_plugin_propose_install', value: f.integration.toolResult });
    } }));
    const block = { id: 'b1', type: 'mcp_tool', status: 'success', messageId: 'm1', toolName: 'builtin-dstu_plugin_propose_install', toolInput: {}, toolOutput: { result: { kind: 'dstu-plugin-workshop', id: 'work-1', title: '过期工具输出' } }, startedAt: 1, endedAt: 2 } as Block;
    const view = render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={block} /></UiKernelProvider>);
    await screen.findByText('真实状态标题 · 1');
    expect(screen.queryByText('过期工具输出')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建/安装' }));
    await waitFor(() => expect(f.adapter.act).toHaveBeenCalledWith('confirm', item));
    await screen.findByText('已安装');
    view.unmount();
    expect(f.unsubscribe).toHaveBeenCalled();
    await act(async () => { await kernel.dispose(); });
  });

  it('manager callbacks create fresh sessions without generating; rejects modifying non-managed packages', async () => {
    const f = fixture();
    f.integration.workshop.onCreate();
    await waitFor(() => expect(f.sessions.navigate).toHaveBeenCalledWith('new-session'));
    expect(f.adapter.act).not.toHaveBeenCalled();
    f.integration.workshop.onModify('outside-package');
    await waitFor(() => expect(f.reportError).toHaveBeenCalledWith(expect.stringContaining('只能修改插件工坊托管')));
    expect(f.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('my creations exposes an installation confirmation after leaving the chat', async () => {
    const f = fixture();
    render(f.integration.workshop.creations);
    const confirm = await screen.findByRole('button', { name: '创建/安装' });
    fireEvent.click(confirm);
    await waitFor(() => expect(f.adapter.act).toHaveBeenCalledWith('confirm', item));
  });
});
