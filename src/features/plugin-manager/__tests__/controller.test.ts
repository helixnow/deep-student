import { describe, expect, it, vi } from 'vitest';

import { PluginManagerController } from '../controller';
import type { PluginConsentSubject } from '../types';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';

const consent: PluginConsentSubject = {
  id: 'community.example',
  version: '1.2.3',
  permissions: ['service:__svc_community_example', 'service:__svc_other'],
};

describe('PluginManagerController', () => {
  it.each(['closed', 'other-plugin', 'same-plugin'])(
    'ignores late config save results after the view is %s', async (next) => {
      const adapter = new FakePluginManagerAdapter([managedPlugin()]);
      const controller = new PluginManagerController(adapter);
      await controller.openConfig('community.first');
      let finish!: (value: Awaited<ReturnType<typeof adapter.saveConfig>>) => void;
      vi.spyOn(adapter, 'saveConfig').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const pending = controller.saveConfig({ label: 'old draft' }, 1);
      controller.closeConfig();
      if (next !== 'closed') await controller.openConfig(next === 'other-plugin' ? 'community.other' : 'community.first');
      const current = controller.getSnapshot().config;
      finish({ ok: true, values: { label: 'late saved value' }, revision: 2 });
      await pending;
      expect(controller.getSnapshot().config).toBe(current);
      expect(controller.getSnapshot().notice).toBeNull();
    },
  );

  it('ignores a late save exception after configuration closes', async () => {
    const adapter = new FakePluginManagerAdapter([]);
    const controller = new PluginManagerController(adapter);
    await controller.openConfig('community.first');
    let fail!: (error: Error) => void;
    vi.spyOn(adapter, 'saveConfig').mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const pending = controller.saveConfig({}, 1);
    controller.closeConfig();
    fail(new Error('offline'));
    await pending;
    expect(controller.getSnapshot().config).toBeNull();
  });
  it('loads the inventory, keeps enabled and runtime apart, and refreshes on Host pushes', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ enabled: true, runtime: 'stopped' })]);
    const controller = new PluginManagerController(adapter);

    await controller.start();

    const state = controller.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.platform).toBe('desktop');
    expect(state.plugins[0]).toMatchObject({ enabled: true, runtime: 'stopped' });
    expect(adapter.calls.list).toBe(1);

    adapter.plugins = [managedPlugin({ enabled: true, runtime: 'running' })];
    adapter.emitChange();
    await vi.waitFor(() => expect(controller.getSnapshot().plugins[0]?.runtime).toBe('running'));
  });

  it('reports list failures without dropping the previous list', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin()]);
    const controller = new PluginManagerController(adapter);
    await controller.start();

    adapter.listError = new Error('host offline');
    await controller.refresh();

    const state = controller.getSnapshot();
    expect(state.status).toBe('error');
    expect(state.error).toMatchObject({ code: 'LIST_FAILED', detail: 'host offline' });
    expect(state.plugins).toHaveLength(1);
  });

  it('reenables through the Host and refreshes instead of guessing the result', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ enabled: false, runtime: 'stopped' })]);
    adapter.setEnabledResult = { ok: true };
    adapter.plugins = [managedPlugin({ enabled: true, runtime: 'stopped' })];
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.setEnabled('dstu.ui.example', true);

    expect(adapter.calls.setEnabled).toEqual([{ id: 'dstu.ui.example', enabled: true }]);
    expect(controller.getSnapshot().plugins[0]?.enabled).toBe(true);
    expect(controller.getSnapshot().busy).toEqual([]);
  });

  it('turns CONSENT_REQUIRED into a pending consent dialog and grants exactly the displayed subject', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.example', origin: 'community' })]);
    adapter.setEnabledResult = { ok: false, code: 'CONSENT_REQUIRED', consent };
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.setEnabled('community.example', true);

    const pending = controller.getSnapshot();
    expect(pending.consent).toEqual(consent);
    expect(pending.error).toBeNull();

    await controller.grantConsent();

    expect(adapter.calls.grantConsent).toEqual([consent]);
    expect(adapter.calls.reload).toBe(1);
    expect(controller.getSnapshot().consent).toBeNull();
    expect(controller.getSnapshot().notice).toEqual({ kind: 'consent-granted', pluginId: 'community.example' });
  });

  it('requests consent through the Host enable path and keeps the exact subject from the refusal', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.example', origin: 'community' })]);
    adapter.setEnabledResult = { ok: false, code: 'CONSENT_REQUIRED', consent };
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.requestConsent('community.example');

    expect(adapter.calls.setEnabled).toEqual([{ id: 'community.example', enabled: true }]);
    expect(controller.getSnapshot().consent).toEqual(consent);
    expect(controller.getSnapshot().busy).toEqual([]);
  });

  it('keeps the consent dialog open when the ledger write fails', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.example' })]);
    adapter.setEnabledResult = { ok: false, code: 'CONSENT_REQUIRED', consent };
    adapter.grantConsentResult = { ok: false, code: 'CONSENT_WRITE_FAILED', detail: 'disk full' };
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.setEnabled('community.example', true);
    await controller.grantConsent();

    const state = controller.getSnapshot();
    expect(state.consent).toEqual(consent);
    expect(state.error).toMatchObject({ code: 'CONSENT_WRITE_FAILED', detail: 'disk full' });
    expect(adapter.calls.reload).toBe(0);
    expect(state.consentBusy).toBe(false);
  });

  it('reports a reload failure after consent was persisted instead of claiming success', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.example' })]);
    adapter.setEnabledResult = { ok: false, code: 'CONSENT_REQUIRED', consent };
    adapter.reloadError = new Error('reload blocked');
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.setEnabled('community.example', true);
    await controller.grantConsent();

    expect(controller.getSnapshot().consent).toBeNull();
    expect(controller.getSnapshot().error).toMatchObject({ code: 'RELOAD_FAILED', detail: 'reload blocked' });
  });

  it('keeps a revision conflict visible instead of overwriting the Host configuration', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ configurable: true })]);
    adapter.config = { schema: { type: 'object', dict: { enabled: { type: 'boolean' } } }, values: { enabled: false }, revision: 4 };
    adapter.saveResult = { ok: false, code: 'REVISION_CONFLICT', detail: 'revision 5' };
    const controller = new PluginManagerController(adapter);
    await controller.start();
    await controller.openConfig('dstu.ui.example');

    const result = await controller.saveConfig({ enabled: true }, 4);

    expect(result).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    const view = controller.getSnapshot().config;
    expect(view?.status).toBe('ready');
    if (view?.status === 'ready') {
      expect(view.conflict).toBe(true);
      expect(view.saving).toBe(false);
      expect(view.config.revision).toBe(4);
    }
    expect(adapter.calls.saveConfig).toEqual([{ id: 'dstu.ui.example', values: { enabled: true }, revision: 4 }]);
  });

  it('advances the revision only from the Host save result', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ configurable: true })]);
    adapter.config = { schema: null, values: { a: 1 }, revision: 2 };
    adapter.saveResult = { ok: true, values: { a: 2 }, revision: 3 };
    const controller = new PluginManagerController(adapter);
    await controller.start();
    await controller.openConfig('dstu.ui.example');

    const result = await controller.saveConfig({ a: 2 }, 2);

    expect(result.ok).toBe(true);
    const view = controller.getSnapshot().config;
    expect(view?.status).toBe('ready');
    if (view?.status === 'ready') {
      expect(view.config.revision).toBe(3);
      expect(view.config.values).toEqual({ a: 2 });
      expect(view.conflict).toBe(false);
    }
    expect(controller.getSnapshot().notice).toEqual({ kind: 'config-saved', pluginId: 'dstu.ui.example', revision: 3 });
  });

  it('closes a plugin configuration after that plugin is uninstalled', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'community.example', origin: 'community' })]);
    const controller = new PluginManagerController(adapter);
    await controller.start();
    await controller.openConfig('community.example');
    expect(controller.getSnapshot().config?.pluginId).toBe('community.example');

    adapter.plugins = [];
    await controller.uninstall('community.example');

    expect(adapter.calls.uninstall).toEqual(['community.example']);
    expect(controller.getSnapshot().config).toBeNull();
    expect(controller.getSnapshot().plugins).toEqual([]);
  });

  it('surfaces the offline package outcome verbatim, including rollback', async () => {
    const adapter = new FakePluginManagerAdapter([]);
    adapter.packageResult = {
      status: 'rejected',
      code: 'PLUGIN_PACKAGE_INVALID',
      detail: 'checksum mismatch',
      rollback: 'restored',
    };
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.installPackage();

    expect(adapter.calls.importPackage).toBe(1);
    expect(controller.getSnapshot().notice).toEqual({
      kind: 'package',
      result: adapter.packageResult,
    });
  });

  it('turns an unexpected adapter rejection into a visible operation error', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin()]);
    adapter.setEnabledError = new Error('host went away');
    const controller = new PluginManagerController(adapter);
    await controller.start();

    await controller.setEnabled('dstu.ui.example', false);

    expect(controller.getSnapshot().error).toMatchObject({ code: 'OPERATION_FAILED', detail: 'host went away' });
    expect(controller.getSnapshot().busy).toEqual([]);
  });
});
