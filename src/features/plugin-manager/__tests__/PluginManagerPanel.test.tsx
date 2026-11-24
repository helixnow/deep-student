import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UiErrorBudget } from '@/ui-kernel/services/errors';

import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import type { ManagedPlugin, PluginConfigSchemaNode } from '../types';
import type { PluginUiHostStatus } from '../ui-status';
import { FakePluginManagerAdapter, FakePluginUiHostStatus, managedPlugin } from './fixtures';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});

const configSchema: PluginConfigSchemaNode = {
  type: 'object',
  dict: {
    enabled: { type: 'boolean', meta: { default: false } },
    mode: { type: 'union', list: [{ type: 'const', value: 'fast' }, { type: 'const', value: 'safe' }] },
  },
};

function setup(
  plugins: ManagedPlugin[],
  options: { budget?: UiErrorBudget; uiStatus?: PluginUiHostStatus } = {},
) {
  const adapter = new FakePluginManagerAdapter(plugins);
  const controller = new PluginManagerController(adapter);
  const user = userEvent.setup();
  const view = render(
    <PluginManagerPanel controller={controller} errorBudget={options.budget} uiStatus={options.uiStatus} />,
  );
  return { adapter, controller, user, view };
}

async function openDetails(id: string) {
  const button = await screen.findByRole('button', { name: `查看 ${id} 的详情`, hidden: true });
  const group = button.closest('details');
  if (group && !group.open) await userEvent.click(group.querySelector('summary')!);
  await userEvent.click(button);
  return screen.findByRole('dialog');
}

describe('PluginManagerPanel', () => {
  it('blocks the consent enable path for community plugins in safe mode', async () => {
    const uiStatus = new FakePluginUiHostStatus();
    uiStatus.setSafeMode(true);
    const { user, adapter } = setup([
      managedPlugin({ id: 'community.waiting', origin: 'community', consent: 'required' }),
    ], { uiStatus });
    const detail = await openDetails('community.waiting');
    const button = await within(detail).findByRole('button', { name: '查看 community.waiting 需要的权限并允许' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(adapter.calls.setEnabled).toEqual([]);
    uiStatus.setSafeMode(false);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('uses inventory loading copy rather than configuration copy', () => {
    const adapter = new FakePluginManagerAdapter([]);
    vi.spyOn(adapter, 'list').mockImplementation(() => new Promise(() => {}));
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取插件清单');
    expect(screen.queryByText('正在读取配置')).toBeNull();
  });

  it('keeps configuration open on overlay click and Escape while saving', async () => {
    const { adapter, user } = setup([managedPlugin({ id: 'dstu.ui.chat' })]);
    adapter.config = { schema: configSchema, values: { enabled: true, mode: 'safe' }, revision: 1 };
    let finish!: (result: Awaited<ReturnType<typeof adapter.saveConfig>>) => void;
    vi.spyOn(adapter, 'saveConfig').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await openDetails('dstu.ui.chat');
    const form = await screen.findByTestId('plugin-config-form');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    expect(within(form).getByRole('button', { name: '保存中' })).toBeDisabled();
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.parentElement!.firstElementChild!;
    await user.click(overlay);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    finish({ ok: true, values: { enabled: true, mode: 'safe' }, revision: 2 });
    await waitFor(() => expect(within(form).getByRole('button', { name: '保存' })).toBeEnabled());
  });

  it('keeps uninstall confirmation busy until the Host completes', async () => {
    const { adapter, user } = setup([managedPlugin({ id: 'community.waiting', origin: 'community' })]);
    let finish!: (result: Awaited<ReturnType<typeof adapter.uninstall>>) => void;
    vi.spyOn(adapter, 'uninstall').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await openDetails('community.waiting');
    await user.click(await screen.findByRole('button', { name: '卸载 community.waiting' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '卸载' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').some((button) => button.hasAttribute('disabled'))).toBe(true);
    finish({ ok: false, code: 'UNINSTALL_FAILED', detail: 'locked' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('plugin-manager-error')).toHaveTextContent('locked');
  });
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RF-W35-plugin-manager-view: lists official and community plugins with id, version, platform and runtime state', async () => {
    setup([
      managedPlugin({ id: 'dstu.ui.chat', version: '0.11.0', enabled: true, runtime: 'running' }),
      managedPlugin({
        id: 'community.exporter',
        version: '1.4.0',
        origin: 'community',
        platforms: ['desktop', 'mobile'],
        enabled: false,
        runtime: 'stopped',
      }),
    ]);

    const official = await screen.findByText('dstu.ui.chat');
    expect(official.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByTestId('plugin-count-builtin')).toHaveTextContent('1');
    expect(screen.getByTestId('plugin-count-community')).toHaveTextContent('1');
    const dialog = await openDetails('dstu.ui.chat');
    const officialRow = within(dialog).getByTestId('plugin-detail');
    expect(officialRow).toHaveAttribute('data-origin', 'builtin');
    expect(within(officialRow).getByText('0.11.0')).toBeInTheDocument();
    // The platform is not shown next to the version unless it matters (unsupported here).
    expect(within(officialRow).queryByText('桌面')).toBeNull();
    expect(within(officialRow).getByText('官方')).toBeInTheDocument();
    expect(within(officialRow).getByTestId('plugin-summary-state')).toHaveTextContent('运行中');
    expect(within(officialRow).queryByTestId('plugin-host-enabled')).toBeNull();
    expect(within(officialRow).queryByTestId('plugin-runtime-state')).toBeNull();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const communityDialog = await openDetails('community.exporter');
    const community = within(communityDialog).getByTestId('plugin-detail');
    expect(community).toHaveAttribute('data-origin', 'community');
    expect(community).toHaveAttribute('data-runtime', 'stopped');
    expect(within(community).getByTestId('plugin-summary-state')).toHaveTextContent('已停用');
    expect(within(community).queryByText('移动')).toBeNull();
    expect(within(community).getByTestId('plugin-version')).toHaveTextContent('1.4.0');
  });

  it('flags a plugin whose declared platforms do not include the current one', async () => {
    const { adapter, controller } = setup([managedPlugin({ platforms: ['desktop'] })]);
    await screen.findByText('dstu.ui.example');
    await openDetails('dstu.ui.example');

    adapter.platform = 'mobile';
    await controller.refresh();

    await waitFor(() => expect(screen.getByTestId('plugin-platform-unsupported')).toBeInTheDocument());
  });

  it('shows the parsed degraded code plus the Host detail', async () => {
    setup([
      managedPlugin({
        id: 'community.broken',
        origin: 'community',
        runtime: 'error',
        degraded: { reason: 'MANIFEST_MISSING: no package.json next to the module' },
      }),
    ]);

    await openDetails('community.broken');
    const reason = await screen.findByTestId('plugin-degraded');
    expect(reason).toHaveAttribute('data-code', 'MANIFEST_MISSING');
    expect(reason).toHaveTextContent('插件文件不完整，缺少说明文件');
    expect(reason).toHaveTextContent('no package.json next to the module');
  });

  it('lists the unclassified reason without pretending it has an error code', async () => {
    setup([managedPlugin({ id: 'community.legacy', origin: 'community', degraded: { reason: 'missing service __svc_x' } })]);
    await openDetails('community.legacy');

    const reason = await screen.findByTestId('plugin-degraded');
    expect(reason).toHaveAttribute('data-code', 'unclassified');
    expect(reason).toHaveTextContent('missing service __svc_x');
  });

  it('shows why the UI kernel automatically uninstalled a community plugin after 3 render errors', async () => {
    const budget = new UiErrorBudget({ community: 3 }, () => undefined, () => 1000);
    setup(
      [
        managedPlugin({ id: 'community.wobbly', origin: 'community' }),
        managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin' }),
      ],
      { budget },
    );
    await screen.findByText('community.wobbly');
    const dialog = await openDetails('community.wobbly');

    for (let index = 0; index < 3; index += 1) {
      budget.report({ pluginId: 'community.wobbly', origin: 'community', phase: 'render', error: new Error(`boom ${index}`) });
    }

    const row = within(dialog).getByTestId('plugin-detail');
    await waitFor(() => expect(within(row).getByTestId('plugin-auto-uninstalled')).toBeInTheDocument());
    expect(within(row).getByTestId('plugin-auto-uninstalled')).toHaveTextContent('出错 3 次后已经先关掉了');
    expect(row).toHaveAttribute('data-auto-uninstalled', 'true');

    const official = screen.getByText('dstu.ui.chat').closest('[data-testid="plugin-row"]') as HTMLElement;
    expect(within(official).queryByTestId('plugin-auto-uninstalled')).toBeNull();
  });

  it('asks the Host to enable or disable and re-reads the list', async () => {
    const { adapter, user } = setup([managedPlugin({ id: 'community.exporter', origin: 'community', enabled: false, runtime: 'stopped' })]);
    await screen.findByText('community.exporter');

    adapter.plugins = [managedPlugin({ id: 'community.exporter', origin: 'community', enabled: true, runtime: 'stopped' })];
    await user.click(screen.getByRole('switch', { name: '启用 community.exporter' }));

    expect(adapter.calls.setEnabled).toEqual([{ id: 'community.exporter', enabled: true }]);
    await waitFor(() =>
      expect(screen.getByText('community.exporter').closest('[data-testid="plugin-card"]')).toHaveAttribute('data-enabled', 'true'),
    );
  });

  it('turns CONSENT_REQUIRED into the consent dialog and only reloads after an explicit confirm', async () => {
    const { adapter, user } = setup([
      managedPlugin({ id: 'community.exporter', origin: 'community', enabled: false, runtime: 'stopped' }),
    ]);
    await screen.findByText('community.exporter');
    adapter.setEnabledResult = {
      ok: false,
      code: 'CONSENT_REQUIRED',
      consent: {
        id: 'community.exporter',
        version: '1.4.0',
        permissions: ['service:__svc_community_exporter'],
      },
    };

    await user.click(screen.getByRole('switch', { name: '启用 community.exporter' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('plugin-consent-id')).toHaveTextContent('community.exporter');
    expect(within(dialog).getByTestId('plugin-consent-permissions')).toHaveTextContent('service:__svc_community_exporter');
    expect(adapter.calls.grantConsent).toEqual([]);
    expect(adapter.calls.reload).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: '允许并启用' }));

    await waitFor(() => expect(adapter.calls.grantConsent).toHaveLength(1));
    expect(adapter.calls.grantConsent[0]).toEqual({
      id: 'community.exporter',
      version: '1.4.0',
      permissions: ['service:__svc_community_exporter'],
    });
    expect(adapter.calls.reload).toBe(1);
  });

  it('uninstalls a community plugin only after the confirm dialog', async () => {
    const { adapter, user } = setup([managedPlugin({ id: 'community.exporter', origin: 'community' })]);
    await screen.findByText('community.exporter');
    await openDetails('community.exporter');

    await user.click(screen.getByRole('button', { name: '卸载 community.exporter' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(adapter.calls.uninstall).toEqual([]);

    adapter.plugins = [];
    await user.click(within(dialog).getByRole('button', { name: '卸载' }));

    await waitFor(() => expect(adapter.calls.uninstall).toEqual(['community.exporter']));
    await waitFor(() => expect(screen.getByTestId('plugin-manager-empty')).toBeInTheDocument());
  });

  it('never offers uninstall for an official plugin', async () => {
    setup([managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin' })]);
    await screen.findByText('dstu.ui.chat');
    await openDetails('dstu.ui.chat');

    expect(screen.queryByRole('button', { name: '卸载 dstu.ui.chat' })).toBeNull();
  });

  it('opens the Host-provided schema in the configuration dialog', async () => {
    const { adapter, user } = setup([managedPlugin({ id: 'dstu.ui.chat', configurable: true })]);
    await screen.findByText('dstu.ui.chat');
    adapter.config = { schema: configSchema, values: { enabled: true, mode: 'safe' }, revision: 9 };

    await openDetails('dstu.ui.chat');

    const form = await screen.findByTestId('plugin-config-form');
    expect(within(form).getByRole('switch', { name: 'enabled' })).toBeChecked();
    expect(within(form).getByTestId('plugin-config-revision')).toHaveTextContent('修订号 9');
    await user.click(within(form).getByRole('radio', { name: 'fast' }));
    await user.click(within(form).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(adapter.calls.saveConfig).toEqual([{ id: 'dstu.ui.chat', values: { enabled: true, mode: 'fast' }, revision: 9 }]),
    );
  });

  it('shows the offline package feedback, including a rollback hint', async () => {
    const { adapter, user } = setup([managedPlugin()]);
    await screen.findByText('dstu.ui.example');
    adapter.packageResult = {
      status: 'rolled-back',
      previousVersion: '1.0.0',
      reason: 'PLUGIN_PACKAGE_INVALID: checksum mismatch',
    };

    await user.click(screen.getByRole('button', { name: '从文件导入' }));

    const feedback = await screen.findByTestId('plugin-install-feedback');
    expect(feedback).toHaveAttribute('data-status', 'rolled-back');
    expect(feedback).toHaveTextContent('已恢复到 v1.0.0');
  });

  it('shows a list failure as an error banner with its code', async () => {
    const adapter = new FakePluginManagerAdapter([]);
    adapter.listError = new Error('host offline');
    const controller = new PluginManagerController(adapter);
    render(<PluginManagerPanel controller={controller} />);

    const banner = await screen.findByTestId('plugin-manager-error');
    expect(banner).toHaveTextContent('读取插件清单失败');
    expect(banner).toHaveTextContent('LIST_FAILED');
  });

  it('renders an empty state when the Host reports no installed plugins', async () => {
    setup([]);
    expect(await screen.findByTestId('plugin-manager-empty')).toHaveTextContent('没有已安装的插件');
  });

  it('shows the W17 safe-mode session and blocks enabling community plugins', async () => {
    const uiStatus = new FakePluginUiHostStatus(['dstu.ui.chat']);
    uiStatus.setSafeMode(true);
    setup(
      [managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin' }), managedPlugin({ id: 'community.exporter', origin: 'community', enabled: false })],
      { uiStatus },
    );
    await screen.findByText('community.exporter');

    expect(screen.getByTestId('plugin-safe-mode')).toHaveTextContent('安全模式');
    expect(screen.getByRole('switch', { name: '启用 community.exporter' })).toBeDisabled();
    const officialButton = screen.getByRole('button', { name: '查看 dstu.ui.chat 的详情', hidden: true });
    await userEvent.click(officialButton.closest('details')!.querySelector('summary')!);
    expect(screen.getByRole('switch', { name: '停用 dstu.ui.chat' })).toBeEnabled();
    expect(screen.getByTestId('plugin-exit-safe-mode')).toHaveTextContent('退出安全模式并恢复正常启动');
    expect(screen.getByTestId('plugin-import')).toBeDisabled();
    expect(screen.getByTestId('plugin-import-url')).toBeDisabled();
    expect(screen.getByTestId('plugin-import-disabled-reason')).toBeInTheDocument();
    const dialog = await openDetails('community.exporter');
    const community = within(dialog).getByTestId('plugin-detail');
    expect(within(community).getByTestId('plugin-safe-mode-hint')).toBeInTheDocument();
    expect(within(community).getAllByTestId('plugin-summary-state')).toHaveLength(1);
    expect(within(community).getByTestId('plugin-summary-state')).toHaveTextContent('已停用');
    expect(within(dialog).queryByText('已停用 · 未运行')).toBeNull();
  });

  it('follows safe-mode changes pushed by the UI kernel', async () => {
    const uiStatus = new FakePluginUiHostStatus();
    setup([managedPlugin({ id: 'community.exporter', origin: 'community', enabled: false })], { uiStatus });
    await screen.findByText('community.exporter');
    expect(screen.queryByTestId('plugin-safe-mode')).toBeNull();

    uiStatus.setSafeMode(true);

    expect(await screen.findByTestId('plugin-safe-mode')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '启用 community.exporter' })).toBeDisabled();

    uiStatus.setSafeMode(false);
    await waitFor(() => expect(screen.queryByTestId('plugin-safe-mode')).toBeNull());
    expect(screen.getByRole('switch', { name: '启用 community.exporter' })).toBeEnabled();
  });

  it('uses the W17 structured degraded reason instead of the raw Host text', async () => {
    const uiStatus = new FakePluginUiHostStatus(['dstu.ui.chat']);
    uiStatus.setDegraded('dstu.ui.chat', {
      code: 'CONFIG_INVALID',
      detail: 'enabled must be a boolean',
      consentRequired: false,
    });
    setup([managedPlugin({ id: 'dstu.ui.chat' })], { uiStatus });
    await screen.findByText('dstu.ui.chat');
    await openDetails('dstu.ui.chat');

    const reason = screen.getByTestId('plugin-degraded');
    expect(reason).toHaveAttribute('data-code', 'CONFIG_INVALID');
    expect(reason).toHaveTextContent('它的设置不对');
    expect(reason).toHaveTextContent('enabled must be a boolean');
  });

  it('offers the consent entry when the UI kernel reports CONSENT_REQUIRED and opens the exact subject', async () => {
    const uiStatus = new FakePluginUiHostStatus(['community.exporter']);
    uiStatus.setDegraded('community.exporter', {
      code: 'CONSENT_REQUIRED',
      detail: 'consent record missing',
      consentRequired: true,
    });
    const { adapter, user } = setup(
      [managedPlugin({ id: 'community.exporter', origin: 'community', enabled: true, runtime: 'stopped' })],
      { uiStatus },
    );
    await screen.findByText('community.exporter');

    const detailDialog = await openDetails('community.exporter');
    const row = within(detailDialog).getByTestId('plugin-detail');
    expect(within(row).getByTestId('plugin-consent-required')).toBeInTheDocument();
    expect(within(row).getByTestId('plugin-degraded')).toHaveAttribute('data-consent-required', 'true');
    expect(within(row).getByTestId('plugin-degraded')).toHaveTextContent('需要你允许它用这些能力');

    adapter.setEnabledResult = {
      ok: false,
      code: 'CONSENT_REQUIRED',
      consent: {
        id: 'community.exporter',
        version: '1.4.0',
        permissions: ['service:__svc_community_exporter'],
      },
    };

    await user.click(within(row).getByRole('button', { name: '查看 community.exporter 需要的权限并允许' }));

    expect(adapter.calls.setEnabled).toEqual([{ id: 'community.exporter', enabled: true }]);
    const consentId = await screen.findByTestId('plugin-consent-id');
    expect(consentId).toHaveTextContent('community.exporter');
    expect(screen.getByTestId('plugin-consent-version')).toHaveTextContent('1.4.0');
    expect(adapter.calls.grantConsent).toEqual([]);
  });

  it('surfaces the WeChat channel group on desktop only', async () => {
    const desktop = setup([managedPlugin()]);
    expect(await screen.findByText('渠道插件')).toBeInTheDocument();
    desktop.view.unmount();

    const adapter = new FakePluginManagerAdapter([managedPlugin()]);
    adapter.platform = 'mobile';
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    await screen.findByText('dstu.ui.example');
    expect(screen.queryByText('渠道插件')).toBeNull();
  });

  it('stages selected packages via /api/files/stage in WebUI mode', async () => {
    (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__ = true;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ path: '/tmp/staged/pack.dspack' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { adapter, user } = setup([managedPlugin()]);
      await screen.findByText('dstu.ui.example');
      const fileInput = screen.getByTestId('plugin-import-file-input') as HTMLInputElement;
      const file = new File(['zip-bytes'], 'pack.dspack', { type: 'application/octet-stream' });
      await user.upload(fileInput, file);

      await waitFor(() => expect(adapter.calls.installPackagePath).toEqual(['/tmp/staged/pack.dspack']));
      expect(adapter.calls.importPackage).toBe(0);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/files/stage?name=pack.dspack',
        expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
      );
    } finally {
      delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
      vi.unstubAllGlobals();
    }
  });

  it('validates and submits package installation from HTTPS URL', async () => {
    const { adapter, user } = setup([managedPlugin()]);
    await screen.findByText('dstu.ui.example');

    await user.click(screen.getByTestId('plugin-import-url'));
    const input = await screen.findByTestId('plugin-url-install-input');

    await user.type(input, 'http://example.com/bad.dspack');
    await user.click(screen.getByTestId('plugin-url-install-submit'));
    expect(screen.getByTestId('plugin-url-install-error')).toHaveTextContent('https://');
    expect(adapter.calls.installPackageFromUrl).toEqual([]);

    await user.clear(input);
    await user.type(input, 'https://example.com/kaoyan-pack.dspack');
    await user.click(screen.getByTestId('plugin-url-install-submit'));

    await waitFor(() =>
      expect(adapter.calls.installPackageFromUrl).toEqual(['https://example.com/kaoyan-pack.dspack']),
    );
    const feedback = await screen.findByTestId('plugin-install-feedback');
    expect(feedback).toHaveAttribute('data-status', 'installed');
  });

  it('renders declarative study-pack additions under "它增加了什么" in PluginDetail', async () => {
    setup([
      managedPlugin({
        id: 'community.kaoyan-pack',
        origin: 'community',
        kind: 'study-pack',
        contributes: ['prompts', 'templates', 'decks', 'rules', 'widgets'],
        declarative: {
          prompts: ['Essay Coach Prompt'],
          templates: ['Cornell Note Card'],
          decks: ['Core Vocabulary'],
          rules: ['IELTS Writing Rubric'],
          widgets: ['Countdown Widget'],
        },
      }),
    ]);

    const dialog = await openDetails('community.kaoyan-pack');
    const adds = within(dialog).getByTestId('plugin-detail-adds');
    expect(adds).toHaveTextContent('学习提示词');
    expect(adds).toHaveTextContent('卡片模板');
    expect(adds).toHaveTextContent('记忆牌组');
    expect(adds).toHaveTextContent('学习规则');
    expect(adds).toHaveTextContent('学习组件');
    expect(within(dialog).getByTestId('plugin-detail-declarative')).toHaveTextContent('Essay Coach Prompt');
    expect(within(dialog).getByTestId('plugin-detail-declarative')).toHaveTextContent('Core Vocabulary');
  });

  it('S4-16: renders a Safe Mode troubleshooting entry button only when not already in safe mode', async () => {
    const uiStatus = new FakePluginUiHostStatus([]);
    setup([], { uiStatus });
    const enterBtn = await screen.findByTestId('plugin-enter-safe-mode');
    expect(enterBtn).toHaveTextContent('安全模式排查');

    uiStatus.setSafeMode(true);
    await screen.findByTestId('plugin-safe-mode');
    expect(screen.queryByTestId('plugin-enter-safe-mode')).toBeNull();
    expect(screen.getByTestId('plugin-exit-safe-mode')).toBeInTheDocument();
  });
});
