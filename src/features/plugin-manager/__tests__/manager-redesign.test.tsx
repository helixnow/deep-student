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
    expect(screen.getAllByTestId('plugin-summary-state')).toHaveLength(3);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: '搜索名称、作者或插件 ID' }), '小明');
    expect(screen.getAllByTestId('plugin-row')).toHaveLength(1);
    expect(screen.getByText('学习笔记')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('radio', { name: '有问题' }));
    expect(screen.getAllByTestId('plugin-row')).toHaveLength(1);
    expect(screen.getByText('导出')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '可更新' }));
    expect(screen.getByText(/尚未接入更新索引/)).toBeInTheDocument();
  });

  it('provides local discovery and mounts the supplied workshop actions and creations', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.notes', origin: 'community' })]);
    const onCreate = vi.fn(); const onModify = vi.fn();
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} workshop={{ onCreate, onModify, creations: <p>作品进度</p> }} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '用 AI 创作插件' }));
    expect(onCreate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('radio', { name: '发现' }));
    expect(screen.getByText(/第一版仅支持本地来源/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '我的创作' }));
    expect(screen.getByText('作品进度')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '已安装' }));
    await user.click(screen.getByRole('button', { name: '查看 community.notes 的详情' }));
    await user.click(screen.getByRole('button', { name: '让 AI 修改' }));
    expect(onModify).toHaveBeenCalledWith('community.notes');
  });

  it('requires risk confirmation before enabling full-trust community code', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.notes', origin: 'community', enabled: false, trust: 'full', permissions: ['service:notes'] })]);
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    const user = userEvent.setup();
    expect(await screen.findByTestId('plugin-trust-badge')).toHaveTextContent('完全信任');
    await user.click(await screen.findByRole('switch', { name: '启用 community.notes' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('与应用同进程执行');
    expect(dialog).toHaveTextContent('service:notes');
    expect(adapter.calls.setEnabled).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: '确认' }));
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
