import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import desktopProfile from '../../../../host/profiles/desktop.json';
import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { officialPluginDisplayOrder, officialPluginGroups, pluginIcon } from '../presentation';
import type { ManagedPlugin, PluginOperationResult } from '../types';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());

/** A workshop-made plugin as the Host lists it after the confirmation card: full trust, consent on record. */
const work = (overrides: Partial<ManagedPlugin> = {}) => managedPlugin({
  id: 'workshop.mnemonic', displayName: '编成口诀', description: '把选中的一段话编成口诀', origin: 'community', source: 'workshop',
  trust: 'full', consent: 'granted', permissions: [], enabled: true, runtime: 'running', ...overrides,
});

/** An adapter whose set-enabled answer the test releases by hand, to observe the pending state. */
function deferredAdapter(plugins: ManagedPlugin[]) {
  const adapter = new FakePluginManagerAdapter(plugins);
  let settle: (result: PluginOperationResult) => void = () => undefined;
  adapter.setEnabled = async (id, enabled) => {
    adapter.calls.setEnabled.push({ id, enabled });
    return new Promise<PluginOperationResult>((resolve) => { settle = resolve; });
  };
  return { adapter, settle: (result: PluginOperationResult) => settle(result) };
}

describe('re-enabling a plugin the user already consented to', () => {
  it('turns a consented full-trust plugin off and on again without any confirmation', async () => {
    const adapter = new FakePluginManagerAdapter([work()]);
    const applyHostResult = adapter.setEnabled.bind(adapter);
    adapter.setEnabled = async (id, enabled) => {
      adapter.plugins = [work({ enabled, runtime: enabled ? 'running' : 'stopped' })];
      return applyHostResult(id, enabled);
    };
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    const user = userEvent.setup();
    const row = await screen.findByTestId('plugin-card');
    expect(within(row).getByTestId('plugin-summary-state')).toHaveTextContent('运行中');

    await user.click(within(row).getByRole('switch', { name: '停用 编成口诀' }));
    await waitFor(() => expect(within(screen.getByTestId('plugin-card')).getByTestId('plugin-summary-state')).toHaveTextContent('已停用'));
    expect(screen.getByRole('switch', { name: '启用 编成口诀' })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('switch', { name: '启用 编成口诀' }));
    await waitFor(() => expect(within(screen.getByTestId('plugin-card')).getByTestId('plugin-summary-state')).toHaveTextContent('运行中'));
    expect(screen.getByRole('switch', { name: '停用 编成口诀' })).toHaveAttribute('aria-checked', 'true');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(adapter.calls.setEnabled).toEqual([{ id: 'workshop.mnemonic', enabled: false }, { id: 'workshop.mnemonic', enabled: true }]);
    expect(adapter.calls.grantConsent).toEqual([]);
  });

  it.each([
    ['the consent no longer matches the installed plugin', 'required'],
    ['the Host does not report a consent state', 'unknown'],
  ] as const)('still asks before enabling full-trust code when %s', async (_case, consent) => {
    const adapter = new FakePluginManagerAdapter([work({ enabled: false, runtime: 'stopped', consent })]);
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: '启用 编成口诀' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('允许『编成口诀』运行？');
    expect(dialog).toHaveTextContent('它和 DeepStudent 一起运行');
    expect(dialog).not.toHaveTextContent('workshop.mnemonic');
    expect(adapter.calls.setEnabled).toEqual([]);
    expect(screen.getByRole('switch', { name: '启用 编成口诀', hidden: true })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the consent dialog when the Host refuses a changed plugin, and leaves the switch off', async () => {
    const adapter = new FakePluginManagerAdapter([work({ enabled: false, runtime: 'stopped', trust: 'restricted', source: 'package', consent: 'required' })]);
    adapter.setEnabledResult = { ok: false, code: 'CONSENT_REQUIRED', consent: { id: 'workshop.mnemonic', version: '1.1.0', permissions: ['service:log'] } };
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: '启用 编成口诀' }));
    expect(await screen.findByTestId('plugin-consent-version')).toHaveTextContent('1.1.0');
    expect(screen.getByTestId('plugin-consent-permissions')).toHaveTextContent('service:log');
    expect(screen.getByRole('switch', { name: '启用 编成口诀', hidden: true })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('switch while the Host is answering', () => {
  it('shows the intent at once, stays disabled until the Host answers, then follows the Host', async () => {
    const { adapter, settle } = deferredAdapter([work()]);
    const controller = new PluginManagerController(adapter);
    render(<PluginManagerPanel controller={controller} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: '停用 编成口诀' }));

    const pending = screen.getByRole('switch', { name: '启用 编成口诀' });
    expect(pending).toHaveAttribute('aria-checked', 'false');
    expect(pending).toBeDisabled();
    // Only the switch runs ahead: the row still reports what the Host last said.
    const row = screen.getByTestId('plugin-card');
    expect(row).toHaveAttribute('data-enabled', 'true');
    expect(within(row).getByTestId('plugin-summary-state')).toHaveTextContent('运行中');
    await user.click(pending);
    expect(adapter.calls.setEnabled).toHaveLength(1);

    adapter.plugins = [work({ enabled: false, runtime: 'stopped' })];
    settle({ ok: true });
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用 编成口诀' })).not.toBeDisabled());
    expect(screen.getByRole('switch', { name: '启用 编成口诀' })).toHaveAttribute('aria-checked', 'false');
    expect(within(screen.getByTestId('plugin-card')).getByTestId('plugin-summary-state')).toHaveTextContent('已停用');
    expect(controller.getSnapshot().pendingEnabled).toEqual({});
  });

  it('puts the switch back and reports the error when the Host fails', async () => {
    const { adapter, settle } = deferredAdapter([work()]);
    const controller = new PluginManagerController(adapter);
    render(<PluginManagerPanel controller={controller} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: '停用 编成口诀' }));
    expect(screen.getByRole('switch', { name: '启用 编成口诀' })).toHaveAttribute('aria-checked', 'false');

    settle({ ok: false, code: 'PLUGIN_UNLOAD_BLOCKED', detail: 'PLUGIN_UNLOAD_BLOCKED: still in use' });
    expect(await screen.findByTestId('plugin-manager-error')).toHaveTextContent('PLUGIN_UNLOAD_BLOCKED');
    const restored = screen.getByRole('switch', { name: '停用 编成口诀' });
    expect(restored).toHaveAttribute('aria-checked', 'true');
    expect(restored).not.toBeDisabled();
    expect(within(screen.getByTestId('plugin-card')).getByTestId('plugin-summary-state')).toHaveTextContent('运行中');
    expect(controller.getSnapshot().pendingEnabled).toEqual({});
  });

  it('puts the switch back when the request itself throws', async () => {
    const adapter = new FakePluginManagerAdapter([work()]);
    adapter.setEnabledError = new Error('ipc closed');
    const controller = new PluginManagerController(adapter);
    await controller.start();
    await controller.setEnabled('workshop.mnemonic', false);
    expect(controller.getSnapshot()).toMatchObject({ pendingEnabled: {}, busy: [], error: { code: 'OPERATION_FAILED', detail: 'ipc closed' } });
  });
});

describe('official plugins: groups, order and icons', () => {
  // The Host lists by id; lanes are the categories it reports for these official plugins.
  const hostOrder = [
    managedPlugin({ id: 'dstu.agent-skills', category: 'L07-agent-skills-ptc', icon: 'Package' }),
    managedPlugin({ id: 'dstu.anki', category: 'L16-anki', icon: 'Package' }),
    managedPlugin({ id: 'dstu.backup', category: 'L21-backup-governance', icon: 'Package' }),
    managedPlugin({ id: 'dstu.future', category: 'L99-future', icon: 'Package' }),
    managedPlugin({ id: 'dstu.media', category: 'L18-media-docs', icon: 'Package' }),
    managedPlugin({ id: 'dstu.new-notes-helper', category: 'L10-notes', icon: 'Package' }),
    managedPlugin({ id: 'dstu.notes', category: 'L10-notes', icon: 'Package' }),
    managedPlugin({ id: 'dstu.platform.storage', category: 'platform', icon: 'Package' }),
    managedPlugin({ id: 'dstu.qbank', category: 'L14-qbank', icon: 'Package' }),
  ];

  it('orders groups by what a learner uses first and rows in reading order, unknown ones last', () => {
    expect(officialPluginGroups(hostOrder).map((group) => [group.category, group.plugins.map((plugin) => plugin.id)])).toEqual([
      ['manager.categories.learning', ['dstu.notes', 'dstu.qbank', 'dstu.anki', 'dstu.new-notes-helper']],
      ['manager.categories.conversation', ['dstu.agent-skills']],
      ['manager.categories.resources', ['dstu.media']],
      ['manager.categories.integrations', ['dstu.backup']],
      ['manager.categories.platform', ['dstu.platform.storage']],
      ['L99-future', ['dstu.future']],
    ]);
  });

  it('has a display slot for every official desktop plugin and nothing else', () => {
    expect([...officialPluginDisplayOrder].sort()).toEqual(desktopProfile.plugins.map((entry) => entry.id).sort());
  });

  it('gives official rows their group icon unless the plugin brings its own', () => {
    expect(hostOrder.map(pluginIcon)).toEqual(['ChatCircle', 'BookOpen', 'Wrench', 'Package', 'MagnifyingGlass', 'BookOpen', 'BookOpen', 'Package', 'BookOpen']);
    expect(pluginIcon(managedPlugin({ id: 'dstu.notes', category: 'L10-notes', icon: 'Wrench' }))).toBe('Wrench');
    expect(pluginIcon(managedPlugin({ id: 'community.tool', origin: 'community', category: 'learning', icon: 'Package' }))).toBe('Package');
    expect(pluginIcon(managedPlugin({ id: 'community.plain', origin: 'community' }))).toBeUndefined();
  });

  it('renders collapsed groups with counts in that order, below the community group', async () => {
    const adapter = new FakePluginManagerAdapter([...hostOrder, work()]);
    render(<PluginManagerPanel controller={new PluginManagerController(adapter)} />);
    expect(within(await screen.findByRole('list', { name: '我的插件' })).getAllByTestId('plugin-card')).toHaveLength(1);
    const mine = screen.getByTestId('plugin-section-mine');
    expect(mine.compareDocumentPosition(screen.getByTestId('plugin-section-builtin')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('plugin-count-builtin')).toHaveTextContent('9');
    const groups = [...screen.getByTestId('plugin-manager').querySelectorAll('details')];
    expect(groups.map((group) => group.querySelector('summary')?.textContent)).toEqual([
      '学习与复习 · 4', '对话与 AI · 1', '资料与文件 · 1', '集成与同步 · 1', '应用与基础服务 · 1', 'L99-future · 1',
    ]);
    expect(groups.every((group) => !group.open)).toBe(true);
    expect([...groups[0]!.querySelectorAll('[data-testid="plugin-row"]')].map((row) => row.getAttribute('data-plugin-id')))
      .toEqual(['dstu.notes', 'dstu.qbank', 'dstu.anki', 'dstu.new-notes-helper']);
  });
});
