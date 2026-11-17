import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { McpToolBlockComponent } from '@/features/chat/plugins/blocks/mcpTool';
import type { Block } from '@/features/chat/core/types/block';
import { createWorkshopIntegration } from '../integration';
import type { WorkshopAdapter, WorkshopItem } from '../types';

vi.mock('react-i18next', async () => (await import('../../plugin-manager/__tests__/i18nMock')).i18nMock());

const item: WorkshopItem = { id: 'workshop.one', proposalId: 'work-1', revision: 5, name: '真实状态标题', version: '1', capabilities: ['在插件自己的数据目录里保存数据'], changes: ['增加复习入口'], trust: 'full', phase: 'ready', sessionId: 'chat-a' };
function fixture(items: WorkshopItem[] = [item]) {
  const unsubscribe = vi.fn();
  const adapter: WorkshopAdapter = { list: vi.fn().mockResolvedValue(items), get: vi.fn(), act: vi.fn().mockResolvedValue({ item: { ...item, phase: 'installed' } }), subscribe: vi.fn(() => unsubscribe) };
  const sessions = {
    bindSession: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue({ id: 'new-session' }), activateSkill: vi.fn().mockResolvedValue(true),
    navigate: vi.fn(), prefill: vi.fn(), focus: vi.fn(), exists: vi.fn().mockResolvedValue(true), setEditing: vi.fn(),
  };
  const reportError = vi.fn();
  return { adapter, sessions, reportError, unsubscribe, integration: createWorkshopIntegration({ adapter, sessions, reportError }) };
}

async function mountCard(f: ReturnType<typeof fixture>, sessionId = 'chat-a', extra: Record<string, unknown> = {}) {
  const kernel = new UiKernel();
  await kernel.install(defineUiPlugin({ meta: { id: 'example.workshop-ui' }, apply(ctx) {
    ctx.ui.contribute('chat.toolResults', { id: 'confirmation', key: 'dstu_plugin_propose_install', value: f.integration.toolResult });
  } }));
  const block = { id: 'b1', type: 'mcp_tool', status: 'success', messageId: 'm1', toolName: 'builtin-dstu_plugin_propose_install', toolInput: {}, toolOutput: { result: { kind: 'dstu-plugin-workshop', id: 'work-1', title: '过期工具输出', state: 'pending-confirmation', ...extra } }, startedAt: 1, endedAt: 701 } as Block;
  const store = { getState: () => ({ sessionId }) } as never;
  const view = render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={block} store={store} /></UiKernelProvider>);
  return { kernel, view };
}

describe('workshop composition (real UI slot, adapter doubles)', () => {
  it('F19: a work of another conversation shows 「在这个对话里修改『X』」; the click binds it here and prefills the composer', async () => {
    const f = fixture([{ ...item, phase: 'installed', sessionId: 'chat-a' }]);
    const { kernel } = await mountCard(f, 'chat-b', { bindRequired: { sessionId: 'chat-b' } });
    fireEvent.click(await screen.findByRole('button', { name: '在这个对话里修改『真实状态标题』' }));
    await waitFor(() => expect(f.adapter.act).toHaveBeenCalledWith('bind', expect.objectContaining({ proposalId: 'work-1' }), { sessionId: 'chat-b' }));
    await waitFor(() => expect(f.sessions.prefill).toHaveBeenCalledWith('chat-b', '把『真实状态标题』改成：'));
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
    await act(async () => { await kernel.dispose(); });
  });

  it('renders through the tool result slot, shows the workshop stage in the header, reconciles persisted output', async () => {
    const f = fixture();
    const { kernel, view } = await mountCard(f);
    await screen.findByText('真实状态标题');
    expect(screen.queryByText('过期工具输出')).toBeNull();
    // The header says what the card waits for, not "done + 700ms".
    expect(screen.getByTestId('workshop-tool-stage').textContent).toBe('等你确认');
    expect(screen.queryByText('700ms')).toBeNull();
    expect(screen.queryByText('0.7s')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() => expect(f.adapter.act).toHaveBeenCalledWith('confirm', item));
    await waitFor(() => expect(screen.getByTestId('workshop-tool-stage').textContent).toBe('已安装'));
    view.unmount();
    expect(f.unsubscribe).toHaveBeenCalled();
    await act(async () => { await kernel.dispose(); });
  });

  it('「让 AI 改」 on the chat card stays in this conversation: prefill 把『<名>』改成： and focus', async () => {
    const f = fixture([{ ...item, phase: 'installed' }]);
    const { kernel } = await mountCard(f, 'chat-a');
    fireEvent.click(await screen.findByRole('button', { name: '让 AI 改' }));
    await waitFor(() => expect(f.sessions.prefill).toHaveBeenCalledWith('chat-a', '把『真实状态标题』改成：'));
    await waitFor(() => expect(f.sessions.focus).toHaveBeenCalledWith('chat-a'));
    expect(f.sessions.create).not.toHaveBeenCalled();
    expect(f.sessions.navigate).not.toHaveBeenCalled();
    await act(async () => { await kernel.dispose(); });
  });

  it('manager 「让 AI 改」 reopens the owning conversation with the sentence and a 正在修改 strip', async () => {
    const f = fixture([{ ...item, phase: 'installed' }]);
    f.integration.workshop.onModify('workshop.one');
    await waitFor(() => expect(f.sessions.navigate).toHaveBeenCalledWith('chat-a'));
    expect(f.sessions.setEditing).toHaveBeenCalledWith('chat-a', '正在修改：真实状态标题 v1');
    expect(f.sessions.prefill).toHaveBeenCalledWith('chat-a', '把『真实状态标题』改成：');
    expect(f.sessions.create).not.toHaveBeenCalled();
  });

  it('manager 「让 AI 改」 opens a new bound conversation when the owner is gone', async () => {
    const f = fixture([{ ...item, phase: 'installed' }]);
    f.sessions.exists.mockResolvedValue(false);
    f.integration.workshop.onModify('workshop.one');
    await waitFor(() => expect(f.sessions.navigate).toHaveBeenCalledWith('new-session'));
    expect(f.sessions.bindSession).toHaveBeenCalledWith('work-1', 5, 'new-session');
    expect(f.sessions.prefill).toHaveBeenCalledWith('new-session', '把『真实状态标题』改成：');
    expect(f.sessions.setEditing).toHaveBeenCalledWith('new-session', '正在修改：真实状态标题 v1');
  });

  it('manager callbacks create fresh sessions without generating; rejects modifying non-managed packages', async () => {
    const f = fixture();
    f.integration.workshop.onCreate();
    await waitFor(() => expect(f.sessions.navigate).toHaveBeenCalledWith('new-session'));
    expect(f.adapter.act).not.toHaveBeenCalled();
    f.integration.workshop.onModify('outside-package');
    await waitFor(() => expect(f.reportError).toHaveBeenCalledWith(expect.stringContaining('WORKSHOP_ONLY_MANAGED')));
    expect(f.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('the manager uninstalls workshop works through the workshop and sees what waits for the user', async () => {
    const f = fixture([{ ...item, phase: 'installed' }, { ...item, id: 'workshop.two', proposalId: 'work-2', name: '等确认', phase: 'ready' }]);
    await f.integration.workshop.onUninstall('workshop.one');
    expect(f.adapter.act).toHaveBeenCalledWith('undo', expect.objectContaining({ id: 'workshop.one' }));
    await expect(f.integration.workshop.pending()).resolves.toEqual([{ pluginId: 'workshop.two', name: '等确认', phase: 'ready' }]);
  });

  it('my creations exposes an installation confirmation after leaving the chat', async () => {
    const f = fixture();
    render(f.integration.workshop.creations);
    const confirm = await screen.findByRole('button', { name: '安装' });
    fireEvent.click(confirm);
    await waitFor(() => expect(f.adapter.act).toHaveBeenCalledWith('confirm', item));
  });
});

describe('工坊创作记录 reads as one thing', () => {
  it('explanation first, each work once: waiting as a card, uninstalled as a row, installed not repeated', async () => {
    const f = fixture([
      { ...item, name: '每日单词', phase: 'ready' },
      { ...item, id: 'workshop.two', proposalId: 'work-2', name: '公式速查', phase: 'installed' },
      { ...item, id: 'workshop.three', proposalId: 'work-3', name: '旧口诀', phase: 'undone' },
    ]);
    const view = render(f.integration.workshop.creations);
    await screen.findByRole('button', { name: '安装' });
    const section = view.getByTestId('workshop-creations-section');
    const text = section.textContent ?? '';
    expect(text.indexOf('等你确认、正在做的作品会在这里')).toBe(0);
    expect(text.match(/每日单词/g)).toHaveLength(1);
    expect(text).not.toContain('公式速查');
    expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument();
    expect(text).toContain('旧口诀');
  });
});


describe('standalone workshop creations', () => {
  it('retains installed and disabled works with modify actions after creation completes', async () => {
    const f = fixture([
      { ...item, name: '已完成公式表', phase: 'installed', installed: { phase: 'installed', version: '1' } },
      { ...item, id: 'workshop.two', proposalId: 'work-2', name: '已停用单词表', phase: 'disabled', installed: { phase: 'disabled', version: '1' } },
    ]);
    render(f.integration.workshop.allCreations);
    await screen.findByText('已完成公式表');
    expect(screen.getByText('已停用单词表')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开已完成公式表' })).toBeInTheDocument();
    expect(screen.queryByText('还没有作品')).toBeNull();
    const modify = screen.getAllByRole('button', { name: '让 AI 改' });
    expect(modify).toHaveLength(2);
    fireEvent.click(modify[0]!);
    await waitFor(() => expect(f.sessions.navigate).toHaveBeenCalledWith('chat-a'));
    expect(f.sessions.prefill).toHaveBeenCalledWith('chat-a', '把『已完成公式表』改成：');
  });
});
