import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UiErrorBudget } from '@/ui-kernel/services/errors';

const safeModeMocks = vi.hoisted(() => ({
  exitSafeModeAndRestart: vi.fn(async () => undefined),
  enterSafeModeAndRestart: vi.fn(async () => undefined),
}));

vi.mock('../safeMode', () => safeModeMocks);
vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/settings/api/pluginsApi', () => ({
  pluginsApi: { list: vi.fn(async () => []) },
  PLUGIN_EVENTS: { stateChanged: 'plugin-state-changed', qrcode: 'plugin-qrcode', activity: 'plugin-activity' },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { PluginManagerPanel } from '../PluginManagerPanel';
import { SafeModeExitDialog } from '../SafeModeExitDialog';
import { PluginManagerController } from '../controller';
import type { ManagedPlugin } from '../types';
import { FakePluginManagerAdapter, FakePluginUiHostStatus, managedPlugin } from './fixtures';

function setupSafeModePanel(
  plugins: ManagedPlugin[],
  options: { budget?: UiErrorBudget; uiStatus?: FakePluginUiHostStatus } = {},
) {
  const uiStatus = options.uiStatus ?? new FakePluginUiHostStatus(['dstu.ui.chat']);
  uiStatus.setSafeMode(true);
  const adapter = new FakePluginManagerAdapter(plugins);
  const controller = new PluginManagerController(adapter);
  const user = userEvent.setup();
  const view = render(
    <PluginManagerPanel controller={controller} errorBudget={options.budget} uiStatus={uiStatus} />,
  );
  return { adapter, controller, uiStatus, user, view };
}

describe('S4-16 Safe Mode Exit Confirmation & Broken Plugin Troubleshooting', () => {
  beforeEach(() => {
    safeModeMocks.exitSafeModeAndRestart.mockClear();
    safeModeMocks.enterSafeModeAndRestart.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens an explicit confirmation dialog listing installed/quarantined/faulted plugins instead of exiting immediately, and supports Cancel', async () => {
    const { adapter, user } = setupSafeModePanel([
      managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin', enabled: true, runtime: 'running' }),
      managedPlugin({
        id: 'community.crasher',
        displayName: '故障插件',
        origin: 'community',
        version: '1.0.2',
        enabled: true,
        runtime: 'error',
        degraded: { reason: 'APPLY_FAILED: ReferenceError: badThing is not defined' },
      }),
      managedPlugin({
        id: 'community.normal',
        displayName: '正常社区插件',
        origin: 'community',
        version: '2.1.0',
        enabled: true,
        runtime: 'stopped',
      }),
      managedPlugin({
        id: 'community.quarantined',
        displayName: '已隔离插件',
        origin: 'community',
        version: '0.5.0',
        enabled: false,
        runtime: 'stopped',
      }),
    ]);

    await screen.findByText('故障插件');
    await user.click(screen.getByTestId('plugin-exit-safe-mode'));

    // Never exits silently on initial click!
    expect(safeModeMocks.exitSafeModeAndRestart).not.toHaveBeenCalled();

    const dialog = await screen.findByTestId('safe-mode-exit-dialog');
    expect(within(dialog).getByTestId('safe-mode-exit-fault-warning')).toHaveTextContent('1 个异常或已降级的第三方插件');

    const items = within(dialog).getAllByTestId('safe-mode-exit-plugin-item');
    expect(items).toHaveLength(3);
    // Faulted plugin is sorted first and highlighted with its failure reason.
    expect(items[0]).toHaveAttribute('data-plugin-id', 'community.crasher');
    expect(items[0]).toHaveAttribute('data-faulted', 'true');
    expect(within(items[0]!).getByTestId('safe-mode-exit-plugin-fault')).toHaveTextContent('badThing is not defined');

    // Faulted + enabled plugin is pre-checked to disable before normal restart.
    expect(within(dialog).getByTestId('safe-mode-exit-disable-community.crasher')).toBeChecked();
    expect(within(dialog).getByTestId('safe-mode-exit-disable-community.normal')).not.toBeChecked();
    expect(within(dialog).getByTestId('safe-mode-exit-disable-community.quarantined')).toBeDisabled();

    // Cancel closes the dialog without disabling or restarting.
    await user.click(within(dialog).getByTestId('safe-mode-exit-cancel'));
    await waitFor(() => expect(screen.queryByTestId('safe-mode-exit-dialog')).toBeNull());
    expect(adapter.calls.setEnabled).toEqual([]);
    expect(safeModeMocks.exitSafeModeAndRestart).not.toHaveBeenCalled();
  });

  it('disables selected faulted plugins before confirming Safe Mode exit and normal restart', async () => {
    const { adapter, user } = setupSafeModePanel([
      managedPlugin({
        id: 'community.crasher',
        displayName: '崩溃插件',
        origin: 'community',
        enabled: true,
        runtime: 'error',
        degraded: { reason: 'IMPORT_FAILED: SyntaxError in index.js' },
      }),
      managedPlugin({
        id: 'community.helper',
        displayName: '笔记助手',
        origin: 'community',
        enabled: true,
        runtime: 'stopped',
      }),
    ]);

    await screen.findByText('崩溃插件');
    await user.click(screen.getByTestId('plugin-exit-safe-mode'));

    const dialog = await screen.findByTestId('safe-mode-exit-dialog');
    expect(within(dialog).getByTestId('safe-mode-exit-confirm')).toHaveTextContent('停用所选（1）并恢复正常启动');

    await user.click(within(dialog).getByTestId('safe-mode-exit-confirm'));

    await waitFor(() => expect(safeModeMocks.exitSafeModeAndRestart).toHaveBeenCalledTimes(1));
    expect(adapter.calls.setEnabled).toEqual([{ id: 'community.crasher', enabled: false }]);
  });

  it('offers one-click "全部停用并正常启动" to keep all enabled third-party plugins disabled on restart', async () => {
    const { adapter, user } = setupSafeModePanel([
      managedPlugin({ id: 'community.alpha', displayName: '插件A', origin: 'community', enabled: true, runtime: 'stopped' }),
      managedPlugin({ id: 'community.beta', displayName: '插件B', origin: 'community', enabled: true, runtime: 'stopped' }),
      managedPlugin({ id: 'community.off', displayName: '插件C', origin: 'community', enabled: false, runtime: 'stopped' }),
    ]);

    await screen.findByText('插件A');
    await user.click(screen.getByTestId('plugin-exit-safe-mode'));

    const dialog = await screen.findByTestId('safe-mode-exit-dialog');
    await user.click(within(dialog).getByTestId('safe-mode-exit-keep-disabled'));

    await waitFor(() => expect(safeModeMocks.exitSafeModeAndRestart).toHaveBeenCalledTimes(1));
    expect(adapter.calls.setEnabled).toEqual([
      { id: 'community.alpha', enabled: false },
      { id: 'community.beta', enabled: false },
    ]);
  });

  it('aborts Safe Mode exit and displays an alert when disabling a faulted plugin fails', async () => {
    const { adapter, user } = setupSafeModePanel([
      managedPlugin({
        id: 'community.stuck',
        displayName: '卡死插件',
        origin: 'community',
        enabled: true,
        runtime: 'error',
        degraded: { reason: 'APPLY_FAILED: boom' },
      }),
    ]);
    adapter.setEnabledResult = { ok: false, code: 'PROFILE_WRITE_FAILED', detail: 'disk read-only' };

    await screen.findByText('卡死插件');
    await user.click(screen.getByTestId('plugin-exit-safe-mode'));

    const dialog = await screen.findByTestId('safe-mode-exit-dialog');
    await user.click(within(dialog).getByTestId('safe-mode-exit-confirm'));

    expect(await within(dialog).findByTestId('safe-mode-exit-error')).toHaveTextContent('disk read-only');
    expect(safeModeMocks.exitSafeModeAndRestart).not.toHaveBeenCalled();
  });

  it('works in standalone mode (for global WorkbenchDesktop Safe Mode banner) by loading plugins via adapter', async () => {
    const onOpenChange = vi.fn();
    const onExit = vi.fn(async () => undefined);
    const adapter = new FakePluginManagerAdapter([
      managedPlugin({
        id: 'community.broken-global',
        displayName: '全局异常插件',
        origin: 'community',
        enabled: true,
        runtime: 'error',
        degraded: { reason: 'MANIFEST_INVALID: missing entry' },
      }),
    ]);
    const user = userEvent.setup();

    render(
      <SafeModeExitDialog
        open={true}
        onOpenChange={onOpenChange}
        adapter={adapter}
        onExit={onExit}
      />,
    );

    const dialog = await screen.findByTestId('safe-mode-exit-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('safe-mode-exit-plugin-list')).toBeInTheDocument());
    expect(within(dialog).getByTestId('safe-mode-exit-disable-community.broken-global')).toBeChecked();

    await user.click(within(dialog).getByTestId('safe-mode-exit-confirm'));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(adapter.calls.setEnabled).toEqual([{ id: 'community.broken-global', enabled: false }]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('surfaces broken plugin error reason and direct disable/uninstall actions right inside Safe Mode', async () => {
    const { adapter, user } = setupSafeModePanel([
      managedPlugin({
        id: 'community.faulty-pkg',
        displayName: '损坏包插件',
        origin: 'community',
        enabled: true,
        runtime: 'error',
        degraded: { reason: 'IMPORT_FAILED: Cannot find module ./missing.js' },
      }),
    ]);

    const card = (await screen.findByText('损坏包插件')).closest('[data-testid="plugin-card"]') as HTMLElement;
    expect(within(card).getByTestId('plugin-summary-state')).toHaveTextContent('需要处理');
    expect(within(card).getByTestId('plugin-card-diagnostic')).toHaveTextContent('Cannot find module ./missing.js');
    expect(screen.getByTestId('plugin-safe-mode-fault-summary')).toHaveTextContent('1 个插件存在故障或降级记录');

    // Direct disable works in Safe Mode (even though enabling stays blocked).
    const disableBtn = within(card).getByTestId('plugin-card-disable');
    expect(disableBtn).toBeEnabled();
    adapter.plugins = [
      managedPlugin({
        id: 'community.faulty-pkg',
        displayName: '损坏包插件',
        origin: 'community',
        enabled: false,
        runtime: 'error',
        degraded: { reason: 'IMPORT_FAILED: Cannot find module ./missing.js' },
      }),
    ];
    await user.click(disableBtn);
    await waitFor(() => expect(adapter.calls.setEnabled).toEqual([{ id: 'community.faulty-pkg', enabled: false }]));
    // Once disabled, switch is locked so user cannot re-enable in Safe Mode.
    await waitFor(() => expect(within(card).getByRole('switch', { name: '启用 损坏包插件' })).toBeDisabled());

    // Opening details in Safe Mode still shows the structured DegradedReason!
    await user.click(within(card).getByTestId('plugin-card-name'));
    const detailDialog = await screen.findByRole('dialog');
    expect(within(detailDialog).getByTestId('plugin-degraded')).toHaveAttribute('data-code', 'IMPORT_FAILED');
    expect(within(detailDialog).getByTestId('plugin-degraded')).toHaveTextContent('Cannot find module ./missing.js');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Direct uninstall on the card works in Safe Mode.
    adapter.plugins = [];
    await user.click(within(card).getByTestId('plugin-card-uninstall'));
    const confirmUninstall = await screen.findByRole('alertdialog');
    await user.click(within(confirmUninstall).getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(adapter.calls.uninstall).toEqual(['community.faulty-pkg']));
  });

  it('displays clear categorized diagnostic errors when importing invalid .dstuplugin/.dspack packages in Safe Mode', async () => {
    const { adapter, user } = setupSafeModePanel([
      managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin' }),
    ]);
    await screen.findByTestId('plugin-safe-mode');

    // 1. Missing root package.json
    adapter.packageResult = {
      status: 'rejected',
      code: 'PLUGIN_PACKAGE_INVALID',
      detail: 'PLUGIN_PACKAGE_INVALID: package.json is missing at the archive root',
      rollback: 'unchanged',
    };
    await user.click(screen.getByTestId('plugin-import'));
    let feedback = await screen.findByTestId('plugin-install-feedback');
    expect(feedback).toHaveAttribute('role', 'alert');
    expect(within(feedback).getByTestId('plugin-install-diagnostic-category')).toHaveAttribute('data-category', 'manifest');
    expect(within(feedback).getByTestId('plugin-install-diagnostic-explanation')).toHaveTextContent('缺少清单文件 package.json');

    // 2. Engine version incompatibility
    adapter.packageResult = {
      status: 'rejected',
      code: 'ENGINE_INCOMPATIBLE',
      detail: 'ENGINE_INCOMPATIBLE: requires app version >=9.0.0; this app is 0.11.0',
      rollback: 'unchanged',
    };
    await user.click(screen.getByTestId('plugin-import'));
    feedback = await screen.findByTestId('plugin-install-feedback');
    expect(within(feedback).getByTestId('plugin-install-diagnostic-category')).toHaveAttribute('data-category', 'compatibility');
    expect(within(feedback).getByTestId('plugin-install-diagnostic-explanation')).toHaveTextContent('>=9.0.0');

    // 3. Missing declared entrypoint asset
    adapter.packageResult = {
      status: 'rejected',
      code: 'PLUGIN_PACKAGE_INVALID',
      detail: 'PLUGIN_PACKAGE_INVALID: missing host entrypoint ./dist/index.js',
      rollback: 'unchanged',
    };
    await user.click(screen.getByTestId('plugin-import'));
    feedback = await screen.findByTestId('plugin-install-feedback');
    expect(within(feedback).getByTestId('plugin-install-diagnostic-category')).toHaveAttribute('data-category', 'manifest');
    expect(within(feedback).getByTestId('plugin-install-diagnostic-explanation')).toHaveTextContent('./dist/index.js');

    // 4. Empty WebUI file upload produces immediate archive diagnostic
    (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__ = true;
    try {
      const fileInput = screen.getByTestId('plugin-import-file-input') as HTMLInputElement;
      const emptyFile = new File([], 'broken.dstuplugin', { type: 'application/octet-stream' });
      await user.upload(fileInput, emptyFile);
      feedback = await screen.findByTestId('plugin-install-feedback');
      expect(within(feedback).getByTestId('plugin-install-diagnostic-category')).toHaveAttribute('data-category', 'archive');
      expect(within(feedback).getByTestId('plugin-install-diagnostic-explanation')).toHaveTextContent('0 字节');
    } finally {
      delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    }
  });
});
