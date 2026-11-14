import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginsSection } from '../PluginsSection';
import { PluginManagerController } from '@/features/plugin-manager/controller';
import { FakePluginManagerAdapter, managedPlugin } from '@/features/plugin-manager/__tests__/fixtures';
import { UiErrorBudget } from '@/ui-kernel/services/errors';

const channelApi = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<unknown[]> => []),
  setEnabled: vi.fn(async () => undefined),
  beginLogin: vi.fn(async () => undefined),
  getConfig: vi.fn(async () => ({
    enabled: false, rateLimitPerMin: 10, modelConfigId: '', systemPrompt: '',
    bound: false, hasToken: false, accountId: '', userId: '', baseUrl: '',
  })),
  getStatus: vi.fn(async () => ({ state: 'stopped', enabled: false, configured: false, bound: false })),
  setConfig: vi.fn(async () => undefined),
  cancelLogin: vi.fn(async () => undefined),
  unbind: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  start: vi.fn(async () => 'stopped'),
  stop: vi.fn(async () => 'stopped'),
}));

vi.mock('@/features/settings/api/pluginsApi', () => ({
  pluginsApi: channelApi,
  PLUGIN_EVENTS: { stateChanged: 'plugin-state-changed', qrcode: 'plugin-qrcode', activity: 'plugin-activity' },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const wechatChannel = {
  id: 'ilinkbot', label: '微信 iLink Bot', blurb: '在微信里与 Deep Student 对话',
  kind: 'channel' as const, state: 'stopped' as const, enabled: false, configured: false, bound: false,
};

beforeEach(() => {
  channelApi.list.mockResolvedValue([]);
  channelApi.beginLogin.mockClear();
});

const warning = '检测到插件异常，系统已自动隔离该插件以保护主程序稳定运行';
const faulty = () => managedPlugin({ id: 'user.words', origin: 'community', source: 'workshop', degraded: { reason: 'APPLY_FAILED: broken' } });
const workshop = () => ({ onCreate: vi.fn(), onModify: vi.fn(), creations: null });

describe('PluginsSection channel plugins', () => {
  it('surfaces the WeChat iLink Bot inside 插件管理 instead of a separate settings page', async () => {
    channelApi.list.mockResolvedValue([wechatChannel]);
    render(<PluginsSection controller={new PluginManagerController(new FakePluginManagerAdapter([managedPlugin()]))} />);

    const row = await screen.findByTestId('channel-plugin-row');
    expect(row).toHaveAttribute('data-plugin-id', 'ilinkbot');
    expect(row).toHaveAttribute('data-bound', 'false');
    expect(screen.getByText('微信 iLink Bot')).toBeInTheDocument();
    expect(screen.getByText('在微信里与 Deep Student 对话')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('channel-bind'));
    await waitFor(() => expect(channelApi.beginLogin).toHaveBeenCalledWith('ilinkbot'));
  });
});

describe('PluginsSection recovery', () => {
  it('highlights degraded community plugins and routes rollback to the version owner', async () => {
    const adapter = new FakePluginManagerAdapter([faulty()]);
    const onRollback = vi.fn().mockResolvedValue(undefined);
    render(<PluginsSection controller={new PluginManagerController(adapter)} onRollback={onRollback} />);
    expect(await screen.findByText(warning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '一键回退上一可用版本' }));
    await waitFor(() => expect(onRollback).toHaveBeenCalledWith('user.words'));
  });

  it('subscribes to UI budget exhaustion without labelling healthy or official plugins as isolated', async () => {
    const adapter = new FakePluginManagerAdapter([
      managedPlugin({ id: 'user.words', origin: 'community' }), managedPlugin({ id: 'official' }),
    ]);
    const budget = new UiErrorBudget({ community: 1 }, vi.fn());
    render(<PluginsSection controller={new PluginManagerController(adapter)} errorBudget={budget} />);
    await waitFor(() => expect(adapter.calls.list).toBeGreaterThan(0));
    expect(screen.queryByText(warning)).toBeNull();
    act(() => { budget.report({ pluginId: 'user.words', origin: 'community', phase: 'render', error: new Error('slot crash') }); });
    expect(await screen.findByText(warning)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键回退上一可用版本' })).toBeDisabled();
  });

  it('waits for confirmed disable before entering the AI repair session', async () => {
    const adapter = new FakePluginManagerAdapter([faulty()]);
    let finish!: () => void;
    vi.spyOn(adapter, 'setEnabled').mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      adapter.plugins = [{ ...faulty(), enabled: false }];
      return { ok: true };
    });
    const paired = workshop();
    render(<PluginsSection controller={new PluginManagerController(adapter)} workshop={paired} />);
    await screen.findByText(warning);
    fireEvent.click(screen.getByRole('button', { name: '停用并让 AI 修复' }));
    expect(paired.onModify).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '停用并让 AI 修复' })).toBeDisabled();
    await act(async () => { finish(); });
    await waitFor(() => expect(paired.onModify).toHaveBeenCalledWith('user.words'));
  });

  it('does not start AI repair when disabling fails', async () => {
    const adapter = new FakePluginManagerAdapter([faulty()]);
    adapter.setEnabledResult = { ok: false, code: 'STOP_FAILED', detail: '无法停用插件' };
    const paired = workshop();
    render(<PluginsSection controller={new PluginManagerController(adapter)} workshop={paired} />);
    await screen.findByText(warning);
    fireEvent.click(screen.getByRole('button', { name: '停用并让 AI 修复' }));
    await waitFor(() => expect(screen.getAllByText(/无法停用插件/).length).toBeGreaterThan(0));
    expect(paired.onModify).not.toHaveBeenCalled();
  });

  it('does not mistake pending consent for a plugin crash', async () => {
    const adapter = new FakePluginManagerAdapter([{ ...faulty(), consent: 'required', degraded: { reason: 'CONSENT_REQUIRED: waiting' } }]);
    render(<PluginsSection controller={new PluginManagerController(adapter)} />);
    await waitFor(() => expect(adapter.calls.list).toBeGreaterThan(0));
    expect(screen.queryByText(warning)).toBeNull();
  });
});
