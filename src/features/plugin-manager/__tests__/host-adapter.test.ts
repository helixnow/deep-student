import { describe, expect, it, vi } from 'vitest';
import { HostPluginManagerAdapter, MANAGER_COMMANDS, managerError, managerSchema, createHostPluginManagerAdapter } from '../host-adapter';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

function setup() {
  let revision = 'profile-1';
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case MANAGER_COMMANDS.list: return { revision, safeMode: false, plugins: [
        { id: 'example.web-search', origin: 'community', version: '1.0.0', platforms: ['desktop'], enabled: false,
          state: 'disabled', hasConfig: false, consent: { matched: false }, permissions: [], services: [],
          displayName: 'Web search', author: 'Example', icon: 'MagnifyingGlass', description: 'Search locally', category: 'resources', trust: 'restricted', source: 'package' },
      ] };
      case MANAGER_COMMANDS.config: return { id: args.id, revision, values: { label: 'validated' }, schema: { fields: [{ path: 'label', type: 'string', description: '名称' }] } };
      case MANAGER_COMMANDS.save:
      case MANAGER_COMMANDS.setEnabled:
      case MANAGER_COMMANDS.uninstall: revision = 'profile-2'; return { id: args.id, revision };
      case MANAGER_COMMANDS.consent: return { ...args, permissionsDigest: 'digest' };
      case MANAGER_COMMANDS.setTrust: return { ...args, source: 'package', permissionsDigest: 'digest' };
      case MANAGER_COMMANDS.install: revision = 'profile-2'; return { id: 'example.web-search', version: '2.0.0', enabled: false, revision,
        consentRequired: { code: 'CONSENT_REQUIRED', id: 'example.web-search', version: '2.0.0', permissions: [] }, rollback: 'not-needed' };
      default: throw new Error(`Unexpected command: ${command}`);
    }
  });
  const choosePackage = vi.fn(async (): Promise<string | null> => '/chosen/sample.dstuplugin');
  const adapter = new HostPluginManagerAdapter({ platform: 'desktop', invoke: invoke as never, choosePackage });
  return { invoke, choosePackage, adapter };
}

describe('HostPluginManagerAdapter', () => {
  it('uses the native file picker filter and the statically named production invoke bridge', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const fake = setup();
    vi.mocked(invoke).mockImplementation(fake.invoke as never);
    vi.mocked(open).mockResolvedValue('/chosen/sample.dstuplugin');
    const adapter = createHostPluginManagerAdapter('desktop');
    await adapter.list();
    await adapter.readConfig('example.web-search');
    await adapter.saveConfig('example.web-search', {}, 'profile-1');
    await adapter.grantConsent({ id: 'example.web-search', version: '1.0.0', permissions: [] });
    await adapter.reload();
    await adapter.setTrust({ id: 'example.web-search', version: '1.0.0', permissions: [] }, 'restricted');
    await adapter.uninstall('example.web-search');
    expect(await adapter.importPackage()).toMatchObject({ status: 'installed' });
    expect(open).toHaveBeenCalledWith({ multiple: false, directory: false, filters: [{ name: 'Deep Student Plugin', extensions: ['dstuplugin'] }] });
    expect(new Set(fake.invoke.mock.calls.map(([command]) => command))).toEqual(new Set(Object.values(MANAGER_COMMANDS)));
  });
  it('maps the inventory without conflating enabled intent and running state', async () => {
    const { adapter } = setup();
    expect(await adapter.list()).toMatchObject({ plugins: [{ id: 'example.web-search', runtime: 'stopped', enabled: false, consent: 'required',
      displayName: 'Web search', author: 'Example', icon: 'MagnifyingGlass', description: 'Search locally', category: 'resources', trust: 'restricted', source: 'package', permissions: [] }] });
  });

  it('uses the published commands, exact opaque revisions, and reads back validated config', async () => {
    const { adapter, invoke } = setup();
    const config = await adapter.readConfig('example.web-search');
    expect(config.revision).toBe('profile-1');
    expect(await adapter.saveConfig('example.web-search', { label: 'draft' }, config.revision))
      .toEqual({ ok: true, values: { label: 'validated' }, revision: 'profile-2' });
    expect(invoke).toHaveBeenCalledWith(MANAGER_COMMANDS.save, { id: 'example.web-search', values: { label: 'draft' }, revision: 'profile-1' });
    await adapter.list();
    await adapter.grantConsent({ id: 'example.web-search', version: '1.0.0', permissions: [] });
    await adapter.reload();
    await adapter.setEnabled('example.web-search', false);
    await adapter.setTrust({ id: 'example.web-search', version: '1.0.0', permissions: [] }, 'full');
    expect(invoke).toHaveBeenCalledWith(MANAGER_COMMANDS.setTrust, { id: 'example.web-search', version: '1.0.0', permissions: [], trust: 'full', confirmed: true });
    await adapter.uninstall('example.web-search');
    expect(await adapter.importPackage()).toMatchObject({ status: 'installed', enabled: false, consentRequired: { version: '2.0.0' } });
    expect(new Set(invoke.mock.calls.map(([command]) => command))).toEqual(new Set(Object.values(MANAGER_COMMANDS)));
    expect(invoke).toHaveBeenCalledWith(MANAGER_COMMANDS.install, { path: '/chosen/sample.dstuplugin', revision: 'profile-2' });
  });

  it('treats picker cancellation as no operation', async () => {
    const { adapter, choosePackage, invoke } = setup();
    choosePackage.mockResolvedValue(null);
    expect(await adapter.importPackage()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('opens consent only for a structured refusal matching the requested plugin', async () => {
    const { adapter, invoke } = setup();
    await adapter.list();
    const reject = (id: string) => ({ error_type: 'Configuration', message: 'CONSENT_REQUIRED: review permissions',
      details: { code: 'CONSENT_REQUIRED', id, version: '1.0.0', permissions: ['service:log'] } });
    invoke.mockRejectedValueOnce(reject('example.web-search'));
    expect(await adapter.setEnabled('example.web-search', true)).toEqual({ ok: false, code: 'CONSENT_REQUIRED',
      consent: { id: 'example.web-search', version: '1.0.0', permissions: ['service:log'] } });
    invoke.mockRejectedValueOnce(reject('other.plugin'));
    expect(await adapter.setEnabled('example.web-search', true)).not.toHaveProperty('consent');
  });

  it('maps profile CAS conflicts while keeping SAFE_MODE_ACTIVE and Host error details', async () => {
    const { adapter, invoke } = setup();
    invoke.mockRejectedValueOnce({ message: 'PROFILE_CONFLICT: changed elsewhere' });
    expect(await adapter.saveConfig('example.web-search', {}, 'stale-token')).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    invoke.mockRejectedValueOnce({ message: 'SAFE_MODE_ACTIVE: writes forbidden' });
    expect(await adapter.uninstall('example.web-search')).toMatchObject({ ok: false, code: 'SAFE_MODE_ACTIVE' });
    expect(invoke.mock.calls.at(-1)?.[0]).toBe(MANAGER_COMMANDS.list); // always refresh after failed mutation
    expect(managerError(JSON.stringify({ message: 'CONFIG_INVALID: invalid input' })).code).toBe('CONFIG_INVALID');
  });

  it.each(['not-needed', 'restored', 'failed'] as const)('does not invent rollback success for %s', async (rollback) => {
    const { adapter, invoke } = setup();
    await adapter.list();
    invoke.mockRejectedValueOnce({ message: 'PLUGIN_PACKAGE_INVALID: bad archive', details: { code: 'PLUGIN_PACKAGE_INVALID', rollback } });
    expect(await adapter.importPackage()).toMatchObject({ status: 'rejected', code: 'PLUGIN_PACKAGE_INVALID',
      rollback: rollback === 'not-needed' ? 'unchanged' : rollback });
  });

  it('projects booleans/enums while preserving unsupported and hidden values outside editable fields', () => {
    expect(managerSchema({ fields: [{ path: 'mode', type: 'enum', options: ['fast', 'safe'] },
      { path: 'hidden', type: 'string', hidden: true }, { path: 'object', type: 'object', fields: [] }] }))
      .toMatchObject({ type: 'object', dict: { mode: { type: 'union' }, object: { type: 'object' } } });
    expect(managerSchema({ fields: [{ path: 'hidden', type: 'string', hidden: true }] })).toEqual({ type: 'object', dict: {} });
  });
});
