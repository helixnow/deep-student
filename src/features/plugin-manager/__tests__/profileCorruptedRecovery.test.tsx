import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const notificationMocks = vi.hoisted(() => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());
vi.mock('@/components/UnifiedNotification', () => notificationMocks);
vi.mock('@/features/settings/api/pluginsApi', () => ({
  pluginsApi: { list: vi.fn(async () => []) },
  PLUGIN_EVENTS: { stateChanged: 'plugin-state-changed', qrcode: 'plugin-qrcode', activity: 'plugin-activity' },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';

describe('SPOF-1 Corrupt user.profile.json recovery in PluginManagerPanel', () => {
  beforeEach(() => {
    notificationMocks.showGlobalNotification.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a prominent recovery banner when inventory reports profileCorrupted and resets + reloads cleanly on click', async () => {
    const adapter = new FakePluginManagerAdapter([
      managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin', enabled: true, runtime: 'running' }),
    ]);
    adapter.profileCorrupted = true;
    adapter.profileError = 'SyntaxError: Unexpected token } in JSON at position 42';
    adapter.resetProfileResult = {
      backedUpTo: '/Users/demo/AppData/plugins/user.profile.json.corrupt-20261125.bak',
      revision: 'profile-clean-1',
    };
    const controller = new PluginManagerController(adapter);
    const user = userEvent.setup();

    render(<PluginManagerPanel controller={controller} />);

    const banner = await screen.findByTestId('plugin-profile-corrupted-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('user.profile.json');
    expect(within(banner).getByTestId('plugin-profile-corrupted-error')).toHaveTextContent('Unexpected token }');

    const resetBtn = within(banner).getByTestId('plugin-profile-reset-button');
    expect(resetBtn).toHaveTextContent('备份并重置损坏的插件配置');

    await user.click(resetBtn);

    await waitFor(() => expect(adapter.calls.resetProfile).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('plugin-profile-corrupted-banner')).toBeNull());
    // Inventory was reloaded cleanly after reset.
    expect(adapter.calls.list).toBeGreaterThanOrEqual(2);

    const successBanner = await screen.findByTestId('plugin-profile-reset-success');
    expect(successBanner).toHaveAttribute('role', 'status');
    expect(successBanner).toHaveTextContent('/Users/demo/AppData/plugins/user.profile.json.corrupt-20261125.bak');
    expect(notificationMocks.showGlobalNotification).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('/Users/demo/AppData/plugins/user.profile.json.corrupt-20261125.bak'),
    );
  });

  it('also renders the recovery banner and recovers when list() rejects with PROFILE_READ_FAILED', async () => {
    const adapter = new FakePluginManagerAdapter([
      managedPlugin({ id: 'dstu.ui.chat', origin: 'builtin', enabled: true, runtime: 'running' }),
    ]);
    adapter.listError = new Error('PROFILE_READ_FAILED: corrupted user.profile.json (EOF)');
    adapter.resetProfileResult = { backedUpTo: null, revision: 'profile-clean-2' };
    const controller = new PluginManagerController(adapter);
    const user = userEvent.setup();

    render(<PluginManagerPanel controller={controller} />);

    const banner = await screen.findByTestId('plugin-profile-corrupted-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(within(banner).getByTestId('plugin-profile-corrupted-error')).toHaveTextContent('PROFILE_READ_FAILED');
    // Generic duplicate list error banner is suppressed while the dedicated recovery banner is shown.
    expect(screen.queryByTestId('plugin-manager-error')).toBeNull();

    await user.click(within(banner).getByTestId('plugin-profile-reset-button'));

    await waitFor(() => expect(adapter.calls.resetProfile).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('plugin-profile-corrupted-banner')).toBeNull());
    expect(await screen.findByTestId('plugin-profile-reset-success')).toHaveTextContent('已重置插件配置文件');
    expect(await screen.findByTestId('plugin-count-builtin')).toHaveTextContent('1');
  });
});
