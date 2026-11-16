import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());

describe('plugin manager redesign', () => {
  it('RF-P2-manager-redesign: searches display names and authors, filters problems and collapses official groups', async () => {
    const adapter = new FakePluginManagerAdapter([
      managedPlugin({ id: 'builtin.chat', displayName: '会话', category: 'L03-chat-pipeline', author: 'dstu' }),
      managedPlugin({ id: 'community.notes', origin: 'community', displayName: '学习笔记', author: '小明', enabled: false, runtime: 'stopped' }),
      managedPlugin({ id: 'community.error', origin: 'community', displayName: '导出', runtime: 'error' }),
    ]);
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    const official = await screen.findByRole('button', { name: '查看 会话 的详情', hidden: true });
    expect(official.closest('details')).not.toHaveAttribute('open');
    expect(official.closest('details')?.querySelector('summary')).toHaveTextContent('对话与 AI');
    // Cards always show their state; a quiet official row only speaks up when it is not simply running.
    expect(screen.getAllByTestId('plugin-card')).toHaveLength(2);
    expect(screen.getAllByTestId('plugin-summary-state')).toHaveLength(2);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: '搜索名称或作者' }), '小明');
    expect(screen.getAllByTestId('plugin-card')).toHaveLength(1);
    expect(screen.queryByTestId('plugin-section-builtin')).toBeNull();
    expect(screen.queryByTestId('plugin-starters')).toBeNull();
    expect(screen.getByText('学习笔记')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('radio', { name: '有问题' }));
    expect(screen.getAllByTestId('plugin-card')).toHaveLength(1);
    expect(screen.getByText('导出')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '内置' }));
    expect(screen.queryByTestId('plugin-section-mine')).toBeNull();
    expect(screen.getAllByTestId('plugin-row')).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: '已停用' }));
    expect(screen.getAllByTestId('plugin-card').map((card) => card.getAttribute('data-plugin-id'))).toEqual(['community.notes']);
    // No update index exists yet: the toolbar does not offer an 可更新 scope it cannot fill.
    expect(screen.queryByRole('radio', { name: '可更新' })).toBeNull();
  });

  it('opens the workshop from starters, the blank starter, the creations list and a card menu', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.notes', origin: 'community', source: 'workshop' })]);
    const onCreate = vi.fn(); const onModify = vi.fn();
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} workshop={{ onCreate, onModify, creations: <p>作品进度</p> }} />);
    const user = userEvent.setup();
    const starters = await screen.findAllByTestId('plugin-starter');
    expect(starters.map((starter) => starter.textContent)).toEqual([
      '做个公式速查的小应用', '选中一段话时，多一个「编成口诀」按钮', '教它一项新本事：说一句「查课表」就列出今天的课',
    ]);
    await user.click(starters[0]!);
    expect(onCreate).toHaveBeenLastCalledWith('做个公式速查的小应用');
    await user.click(screen.getByTestId('plugin-create'));
    expect(onCreate).toHaveBeenLastCalledWith();
    expect(screen.queryByText('作品进度')).toBeNull();
    const toggle = screen.getByTestId('plugin-creations-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('作品进度')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'community.notes 的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '让 AI 改' }));
    expect(onModify).toHaveBeenCalledWith('community.notes');
  });

  it('requires risk confirmation before enabling full-trust community code', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.notes', origin: 'community', enabled: false, trust: 'full', permissions: ['service:notes'] })]);
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('switch', { name: '启用 community.notes' })).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-trust-badge')).toBeNull();
    await user.click(await screen.findByRole('switch', { name: '启用 community.notes' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('它和 DeepStudent 一起运行');
    expect(dialog).toHaveTextContent('使用应用服务「笔记」');
    expect(dialog).not.toHaveTextContent('service:notes');
    expect(adapter.calls.setEnabled).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: '允许并启用' }));
    await waitFor(() => expect(adapter.calls.setEnabled).toEqual([{ id: 'community.notes', enabled: true }]));
  });

  it('changes trust only after explicit confirmation of the displayed exact subject', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.notes', origin: 'community', trust: 'restricted', permissions: ['service:notes'] })]);
    const setTrust = vi.fn(async () => ({ ok: true as const }));
    render(<PluginManagerPanel controller={new PluginManagerController(Object.assign(adapter, { setTrust }))} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '查看 community.notes 的详情' }));
    await user.click(screen.getByRole('button', { name: '更改信任档位' }));
    expect(setTrust).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('community.notes');
    expect(dialog).toHaveTextContent('1.0.0');
    await user.click(within(dialog).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(setTrust).toHaveBeenCalledWith({ id: 'community.notes', version: '1.0.0', permissions: ['service:notes'] }, 'full'));
    expect(adapter.calls.setEnabled).toEqual([]);
  });
});
