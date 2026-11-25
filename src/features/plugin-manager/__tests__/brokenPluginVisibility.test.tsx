import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/settings/api/pluginsApi', () => ({
  pluginsApi: { list: vi.fn(async () => []) },
  PLUGIN_EVENTS: { stateChanged: 'plugin-state-changed', qrcode: 'plugin-qrcode', activity: 'plugin-activity' },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { describeManagerError, describePluginFault, isFaultDegradedReason } from '../reasons';
import type { ManagedPlugin } from '../types';
import { FakePluginManagerAdapter, FakePluginUiHostStatus, managedPlugin } from './fixtures';

describe('G03a: broken & degraded plugin visibility in Plugin Manager', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not let SAFE_MODE_ACTIVE or CONSENT_REQUIRED UI status hide a real Host fault in isFaultDegradedReason', () => {
    expect(isFaultDegradedReason('MANIFEST_INVALID: corrupt package.json', { code: 'SAFE_MODE_ACTIVE', consentRequired: false })).toBe(true);
    expect(isFaultDegradedReason('IMPORT_FAILED: syntax error', { code: 'CONSENT_REQUIRED', consentRequired: true })).toBe(true);
    expect(isFaultDegradedReason('   ', { code: 'SAFE_MODE_ACTIVE', consentRequired: false })).toBe(false);
    expect(isFaultDegradedReason('SAFE_MODE_ACTIVE: paused')).toBe(false);

    const t = (key: string) => key;
    expect(describePluginFault(t, { degradedReason: 'MANIFEST_MISSING:   ' })).toEqual({
      code: 'MANIFEST_MISSING',
      label: 'degraded.code.manifest_missing',
      detail: undefined,
    });
    expect(describeManagerError(t, 'PLUGIN_NOT_FOUND', 'missing plugin')).toMatchObject({
      category: 'runtime',
      explanation: 'error.reasons.pluginNotFound',
    });
    expect(describeManagerError(t, 'PROFILE_READ_FAILED', 'bad json')).toMatchObject({
      category: 'runtime',
      explanation: 'error.reasons.profileReadFailed',
    });
  });

  it('surfaces a pre-seeded broken community plugin without displayName or description, with diagnostic banner and 1-click uninstall', async () => {
    const broken: ManagedPlugin = managedPlugin({
      id: 'community.corrupt-seed',
      displayName: undefined,
      description: undefined,
      version: '—',
      origin: 'community',
      source: 'package',
      enabled: false,
      runtime: 'error',
      consent: 'unknown',
      degraded: { reason: 'MANIFEST_INVALID: Unexpected token } in package.json' },
    });
    const healthy: ManagedPlugin = managedPlugin({
      id: 'community.healthy',
      displayName: '健康社区插件',
      origin: 'community',
      source: 'package',
      enabled: true,
      runtime: 'running',
      consent: 'granted',
    });

    const adapter = new FakePluginManagerAdapter([broken, healthy]);
    const controller = new PluginManagerController(adapter);
    const user = userEvent.setup();

    render(<PluginManagerPanel controller={controller} />);

    // Fault summary banner appears in Normal Mode with 1-click jump to "有问题" filter.
    const banner = await screen.findByTestId('plugin-mine-fault-banner');
    expect(banner).toHaveTextContent('检测到异常或损坏的插件');
    expect(banner).toHaveTextContent('1');

    // Broken card renders clearly using plugin.id fallback, problem status, fault description, diagnostic, and direct Uninstall button.
    const brokenCard = screen.getByText('community.corrupt-seed').closest('[data-testid="plugin-card"]') as HTMLElement;
    expect(brokenCard).toHaveAttribute('data-fault', 'true');
    expect(within(brokenCard).getByTestId('plugin-tile')).toHaveTextContent('C');
    expect(within(brokenCard).getByTestId('plugin-summary-state')).toHaveTextContent('需要处理');
    expect(within(brokenCard).getByTestId('plugin-summary-state')).toHaveAttribute('data-tone', 'bad');
    expect(within(brokenCard).getByTestId('plugin-card-description')).toHaveTextContent('无法正常读取该插件的清单或文件');
    const diagnostic = within(brokenCard).getByTestId('plugin-card-diagnostic');
    expect(diagnostic).toHaveAttribute('data-code', 'MANIFEST_INVALID');
    expect(diagnostic).toHaveTextContent('Unexpected token } in package.json');
    expect(within(brokenCard).getByTestId('plugin-card-fault-actions')).toBeInTheDocument();

    // Clicking "查看异常插件" filters down to only the broken plugin.
    await user.click(within(banner).getByTestId('plugin-mine-view-faulted'));
    expect(screen.getAllByTestId('plugin-card')).toHaveLength(1);
    expect(screen.getByText('community.corrupt-seed')).toBeInTheDocument();

    // Searching by degraded error code/message also matches the broken plugin.
    await user.click(screen.getByRole('radio', { name: '全部' }));
    await user.type(screen.getByRole('textbox', { name: '搜索名称或作者' }), 'MANIFEST_INVALID');
    expect(screen.getAllByTestId('plugin-card')).toHaveLength(1);
    expect(screen.getByText('community.corrupt-seed')).toBeInTheDocument();

    // Direct Uninstall on the broken card works without hunting in overflow menu.
    adapter.plugins = [healthy];
    await user.click(within(brokenCard).getByTestId('plugin-card-uninstall'));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('community.corrupt-seed');
    await user.click(within(confirm).getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(adapter.calls.uninstall).toEqual(['community.corrupt-seed']));
  });

  it('keeps broken-plugin fault status authoritative over pending consent and Safe Mode SAFE_MODE_ACTIVE status', async () => {
    const uiStatus = new FakePluginUiHostStatus(['dstu.ui.chat']);
    uiStatus.setSafeMode(true);
    uiStatus.setDegraded('community.broken-in-safe', {
      code: 'SAFE_MODE_ACTIVE',
      detail: 'paused by safe mode',
      consentRequired: false,
    });

    const broken: ManagedPlugin = managedPlugin({
      id: 'community.broken-in-safe',
      displayName: undefined,
      version: '—',
      origin: 'community',
      source: 'package',
      enabled: true,
      runtime: 'error',
      consent: 'required',
      degraded: { reason: 'MANIFEST_MISSING: package.json not found' },
    });

    const adapter = new FakePluginManagerAdapter([
      managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin' }),
      broken,
    ]);
    const controller = new PluginManagerController(adapter);

    render(<PluginManagerPanel controller={controller} uiStatus={uiStatus} />);

    const card = (await screen.findByText('community.broken-in-safe')).closest('[data-testid="plugin-card"]') as HTMLElement;
    expect(within(card).getByTestId('plugin-summary-state')).toHaveTextContent('需要处理');
    expect(within(card).getByTestId('plugin-card-diagnostic')).toHaveAttribute('data-code', 'MANIFEST_MISSING');
    expect(within(card).getByTestId('plugin-card-diagnostic')).toHaveTextContent('package.json not found');
    expect(within(card).getByTestId('plugin-card-disable')).toBeEnabled();
    expect(within(card).getByTestId('plugin-card-uninstall')).toBeEnabled();
  });

  it('falls back to controller.uninstall when uninstalling an orphaned workshop-sourced plugin throws WORKSHOP_ONLY_MANAGED', async () => {
    const orphanedWorkshop: ManagedPlugin = managedPlugin({
      id: 'workshop.orphaned-broken',
      displayName: undefined,
      version: '—',
      origin: 'community',
      source: 'workshop',
      enabled: false,
      runtime: 'error',
      degraded: { reason: 'MANIFEST_MISSING: no package.json' },
    });

    const adapter = new FakePluginManagerAdapter([orphanedWorkshop]);
    const controller = new PluginManagerController(adapter);
    const onUninstall = vi.fn(async () => {
      throw new Error('WORKSHOP_ONLY_MANAGED: only workshop-managed works can be changed here');
    });
    const user = userEvent.setup();

    render(
      <PluginManagerPanel
        controller={controller}
        workshop={{ onCreate: vi.fn(), onModify: vi.fn(), onUninstall, creations: null }}
      />,
    );

    const card = (await screen.findByText('workshop.orphaned-broken')).closest('[data-testid="plugin-card"]') as HTMLElement;
    adapter.plugins = [];
    await user.click(within(card).getByTestId('plugin-card-uninstall'));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: '卸载' }));

    await waitFor(() => expect(onUninstall).toHaveBeenCalledWith('workshop.orphaned-broken'));
    await waitFor(() => expect(adapter.calls.uninstall).toEqual(['workshop.orphaned-broken']));
  });
});
