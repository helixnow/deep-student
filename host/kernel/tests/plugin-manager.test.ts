/**
 * 插件管理可信命令（P1-1/P1-3，K3/K7）：`plugin:manager|*` 的主窗口本地页校验、
 * 修订号 CAS、配置 schema 投影与热更新、启停/卸载、同意账本与装载前门。
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeFiles } from '../../platform/files/index.ts';
import { MemoryZipSink, ZipWriter } from '../../platform/zip/core/index.ts';
import { nodeZipCodec } from '../../platform/zip/node/file.ts';
import { PluginPackages } from '../plugin-packages/index.ts';
import {
  PLUGIN_MANAGER_CONFIG_COMMAND,
  PLUGIN_MANAGER_CONFIG_SAVE_COMMAND,
  PLUGIN_MANAGER_CONSENT_COMMAND,
  PLUGIN_MANAGER_LIST_COMMAND,
  PLUGIN_MANAGER_SET_ENABLED_COMMAND,
  PLUGIN_MANAGER_UNINSTALL_COMMAND,
  PLUGIN_MANAGER_INSTALL_COMMAND,
  PLUGIN_MANAGER_SET_TRUST_COMMAND,
  HOST_CALL_COMMAND,
  UI_READY_COMMAND,
  type PluginManagerInstallResult,
  type PluginManagerConfigView,
  type PluginManagerInventory,
  type WindowRef,
} from '../api.ts';
import { CommunityConsentLedger } from '../community-consent.ts';
import type { HostTransport } from '../connection.ts';
import { serveHost } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain } from '../protocol.ts';
import { assertTrustedManagerSource, PluginAdmin, type DstuPluginInstaller } from '../plugin-admin.ts';
import { loadStartupProfile } from '../profile.ts';
import { UserProfileStore } from '../profile-store.ts';
import { HostRuntime } from '../runtime.ts';
import { pluginExecution } from '../plugin-execution.ts';

const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const LOCAL: WindowRef = { window: 'main', webview: 'main' };

let root: string;

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  root = await mkdtemp(join(TMP, 'w01-manager-'));
  (globalThis as { __w01ManagerConfigs?: unknown[] }).__w01ManagerConfigs = [];
  (globalThis as { __w01ManagerApplied?: string[] }).__w01ManagerApplied = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete (globalThis as { __w01ManagerConfigs?: unknown[] }).__w01ManagerConfigs;
  delete (globalThis as { __w01ManagerApplied?: string[] }).__w01ManagerApplied;
});

const applied = () => (globalThis as { __w01ManagerApplied?: string[] }).__w01ManagerApplied ?? [];
const appliedConfigs = () => (globalThis as { __w01ManagerConfigs?: unknown[] }).__w01ManagerConfigs ?? [];

interface Harness {
  runtime: HostRuntime;
  admin: PluginAdmin;
  store: UserProfileStore;
  consent: CommunityConsentLedger;
  userProfile: string;
  officeProfile: string;
  dataDir: string;
  packages: PluginPackages;
}

/** 官方 profile（测试基线）：两个 host/ 内的官方插件。 */
async function baseProfile(): Promise<string> {
  const path = join(root, 'base.profile.json');
  await writeFile(path, JSON.stringify({
    plugins: [
      { id: 'dstu.plain', module: join(FIXTURES, 'manager-plain.plugin.ts') },
      { id: 'dstu.configurable', module: join(FIXTURES, 'manager-configurable.plugin.ts') },
    ],
  }));
  return path;
}

async function harness(options: { safeMode?: boolean; user?: unknown } = {}): Promise<Harness> {
  const dataDir = join(root, 'data');
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
  const officeProfile = await baseProfile();
  const userProfile = join(dataDir, 'plugins', 'user.profile.json');
  if (options.user !== undefined) await writeFile(userProfile, JSON.stringify(options.user));
  const runtime = new HostRuntime({
    app: { dataDir, version: '0.11.0', platform: 'linux', debug: true },
    contracts: ContractSet.empty(),
    safeMode: options.safeMode === true,
  });
  runtime.ctx.provide('paths', {});
  runtime.ctx.provide('storage', {});
  runtime.ctx.provide('log', {});
  const consent = new CommunityConsentLedger(dataDir);
  const store = new UserProfileStore(userProfile, officeProfile);
  const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
  const admin = new PluginAdmin({ runtime, store, official: officeProfile, consent, files, packages });
  admin.register();
  return { runtime, admin, store, consent, userProfile, officeProfile, dataDir, packages };
}

/** 应用目录之外的社区插件包（`.tmp` 在 host/ 外）。 */
async function community(id: string, options: { version?: string; permissions?: string[] } = {}): Promise<{ id: string; module: string; dir: string }> {
  const version = options.version ?? '1.0.0';
  const dir = join(root, 'packages', id.replace(/\./g, '-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `deepstudent-plugin-${id.replace(/\./g, '-')}`,
    version,
    type: 'module',
    engines: { deepStudent: '^0.11' },
    deepStudent: {
      manifestVersion: 1, id, platforms: ['desktop'], host: './index.mjs',
      ...(options.permissions ? { permissions: options.permissions } : {}),
    },
  }, null, 2));
  await writeFile(join(dir, 'index.mjs'), [
    `globalThis.__w01ManagerApplied?.push(${JSON.stringify(id)});`,
    `export default { name: ${JSON.stringify(id)}, meta: { id: ${JSON.stringify(id)}, version: ${JSON.stringify(version)} }, apply() {} };`,
  ].join('\n'));
  return { id, module: join(dir, 'index.mjs'), dir };
}

const invoke = (h: Harness, cmd: string, args: unknown, source: WindowRef = LOCAL) => h.runtime.dispatchInvoke({ id: `c-${cmd}-${Math.random()}`, cmd, args, source });

async function builtinInstaller(h: Harness): Promise<DstuPluginInstaller> {
  let installer: DstuPluginInstaller | undefined;
  await h.runtime.install({ name: 'installer-test', meta: { id: 'dstu.installer-test' }, inject: ['dstuPluginInstaller'], apply(ctx) { installer = ctx.dstuPluginInstaller; } });
  const fiber = h.runtime.get('dstu.installer-test')!.fiber;
  // Test driver enters the real builtin execution scope; an unscoped captured object must not authorize itself.
  return {
    inventory: () => pluginExecution.run(fiber, () => installer!.inventory()),
    configOf: id => pluginExecution.run(fiber, () => installer!.configOf(id)),
    configureManaged: (id, values) => pluginExecution.run(fiber, () => installer!.configureManaged(id, values)),
    setEnabledManaged: (id, enabled) => pluginExecution.run(fiber, () => installer!.setEnabledManaged(id, enabled)),
    plugins: () => pluginExecution.run(fiber, () => installer!.plugins()),
    uninstall: (id, revision) => pluginExecution.run(fiber, () => installer!.uninstall(id, revision)),
    installManagedDirectory: request => pluginExecution.run(fiber, () => installer!.installManagedDirectory(request)),
    onActivation: listener => pluginExecution.run(fiber, () => installer!.onActivation(listener)),
    onFault: listener => pluginExecution.run(fiber, () => installer!.onFault(listener)),
    activateManaged: (id, revision) => pluginExecution.run(fiber, () => installer!.activateManaged(id, revision)),
    isolateManaged: id => pluginExecution.run(fiber, () => installer!.isolateManaged(id)),
    selfCheckContext: (id, names) => pluginExecution.run(fiber, () => installer!.selfCheckContext(id, names)),
  };
}

async function ok<T>(h: Harness, cmd: string, args: unknown = {}, source: WindowRef = LOCAL): Promise<T> {
  const outcome = await invoke(h, cmd, args, source);
  if (outcome.kind !== 'ok') throw new Error(`expected ok from ${cmd}: ${JSON.stringify(outcome)}`);
  return outcome.value as T;
}

async function err(h: Harness, cmd: string, args: unknown = {}, source: WindowRef = LOCAL): Promise<string> {
  const outcome = await invoke(h, cmd, args, source);
  if (outcome.kind !== 'err') throw new Error(`expected err from ${cmd}: ${JSON.stringify(outcome)}`);
  return JSON.stringify(outcome.error);
}

/** 进程内传输：记录 Host 发出的消息，手动投递 main→Host 消息。 */
class MemoryTransport implements HostTransport {
  readonly received: HostToMain[] = [];
  private listener: (message: unknown) => void = () => undefined;
  send(message: HostToMain): void { this.received.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listener = listener; }
  onClose(): void {}
  close(): void {}
  deliver(message: unknown): void { this.listener(message); }
}

describe('RF-W01-trusted-plugin-admin: plugin manager commands', () => {
  it('RF-P1-managed-plugin-install: P3 activation callbacks restore subscriber owner and self-check returns real non-K7 services', async () => {
    const h = await harness();
    const demo = await community('alice.activation');
    const directory = join(h.dataDir, 'dstu-workshop', demo.id, 'build');
    await mkdir(directory, { recursive: true });
    await cp(demo.dir, directory, { recursive: true });
    const results: unknown[] = [];
    try {
      const installed = await h.admin.installManagedDirectory({ id: demo.id, directory, version: '1.0.0', permissions: [], revision: (await h.store.read()).revision, confirmed: true });
      await h.runtime.install({ name: 'subscriber', meta: { id: 'dstu.subscriber' }, inject: ['dstuPluginInstaller'], async apply(ctx) {
        const capability = ctx.dstuPluginInstaller;
        const check = await capability.selfCheckContext(demo.id, ['storage', 'paths', 'commands', 'dstuPluginInstaller', 'pluginWorkshop']);
        expect(check).toEqual({ trust: 'full', safeMode: false, services: { storage: h.runtime.ctx.get('storage'), paths: h.runtime.ctx.get('paths') } });
        expect(check.services.storage).toBe(h.runtime.ctx.get('storage'));
        ctx.effect(() => capability.onActivation(async result => {
          await Promise.resolve();
          const inventory = await capability.inventory();
          expect(inventory.revision).toBe((await h.store.read()).revision);
          results.push(result);
        }));
      } });
      await ok(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, enabled: true, revision: installed.revision });
      expect(results).toEqual([{ id: demo.id, attemptedVersion: '1.0.0', actualVersion: '1.0.0', success: true, error: null }]);
      const capability = await builtinInstaller(h);
      await h.consent.grant({ id: demo.id, version: '1.0.0', permissions: [] }, { trust: 'restricted', source: 'workshop' });
      expect((await capability.selfCheckContext(demo.id, ['storage'])).trust).toBe('restricted');
    } finally { await h.runtime.dispose(); }
    const safe = await harness({ safeMode: true });
    try {
      const capability = await builtinInstaller(safe);
      expect(await capability.selfCheckContext('alice.new', ['storage', 'paths'])).toEqual({ trust: 'full', safeMode: true, services: {} });
    } finally { await safe.runtime.dispose(); }
  });
  it('RF-P1-managed-plugin-install: execution owners survive remote dispatch, callbacks and ordinary-object forwarding', async () => {
    const h = await harness();
    let captured: DstuPluginInstaller | undefined;
    const events: string[] = [];
    const replies: string[] = [];
    try {
      await h.runtime.install({ name: 'forwarder', meta: { id: 'dstu.forwarder', provides: ['auditForward'], remote: { auditForward: ['inventoryId'] } }, inject: ['dstuPluginInstaller'], apply(ctx) {
        captured = ctx.dstuPluginInstaller;
        ctx.provide('auditForward', { installer: captured, async inventoryId() { await Promise.resolve(); return (await captured!.inventory()).revision; } });
        ctx.backendEvents.listen('audit:request', () => { events.push(captured!.plugins().some(p => p.meta.id === 'dstu.forwarder') ? 'builtin-ok' : 'missing'); });
      } });
      expect(() => captured!.plugins()).toThrow('KERNEL_API_FORBIDDEN');
      await h.runtime.installEntry({ packageRoot: join(root, 'remote'), plugin: { name: 'consumer', meta: { id: 'alice.consumer', provides: ['auditConsumer'], remote: { auditConsumer: ['attack'] } }, apply(ctx) {
        const attack = async () => {
          await Promise.resolve();
          try { await (ctx.get('auditForward').installer as DstuPluginInstaller).inventory(); return 'leaked'; }
          catch (error) { return String(error); }
        };
        ctx.provide('auditConsumer', { attack });
        ctx.on('host/window', async () => { replies.push(await attack()); });
        for (const get of [() => ctx.reflect.store, () => (ctx.commands as unknown as { _kernel: unknown })._kernel, () => ctx.on('internal/get' as never, (() => {}) as never)]) {
          try { get(); replies.push('exposed'); } catch (error) { replies.push(String(error)); }
        }
      } } });
      const official = await ok(h, HOST_CALL_COMMAND, { caller: 'dstu.forwarder', service: 'auditForward', method: 'inventoryId', args: [] });
      expect(official).toBe((await h.store.read()).revision);
      expect(await ok<string>(h, HOST_CALL_COMMAND, { caller: 'alice.consumer', service: 'auditConsumer', method: 'attack', args: [] })).toContain('KERNEL_API_FORBIDDEN');
      h.runtime.deliverWindow({ ref: LOCAL, state: 'created' });
      await new Promise(resolve => setImmediate(resolve));
      expect(replies).toHaveLength(4);
      expect(replies.every(reply => reply.includes('KERNEL_API_FORBIDDEN'))).toBe(true);
      h.runtime.backendEvents.emit('audit:request', null);
      expect(events).toEqual(['builtin-ok']);
    } finally { await h.runtime.dispose(); }
  });
  it.each(['restricted', 'full'] as const)('RF-P1-managed-plugin-install: B1 registry traversal from %s community cannot recover an authorized builtin context', async trust => {
    const h = await harness();
    const outcomes: string[] = [];
    try {
      await h.runtime.install({ name: 'victim', meta: { id: 'dstu.victim' }, apply() {} });
      await builtinInstaller(h);
      await h.runtime.installEntry({ packageRoot: join(root, trust), manifest: { id: `alice.${trust}`, packageName: 'audit', version: '1.0.0', engines: '^0.11', platforms: ['desktop'], permissions: [], requires: {}, trust },
        plugin: { name: trust, meta: { id: `alice.${trust}` }, async apply(ctx) {
          try {
            for (const registration of ctx.root.registry.values()) {
              for (const fiber of registration.fibers) {
                if (fiber.name !== 'installer-test') continue;
                const installer = fiber.ctx.get('dstuPluginInstaller')!;
                const inventory = await installer.inventory();
                await installer.uninstall('dstu.victim', inventory.revision!);
                outcomes.push('leaked');
              }
            }
          } catch (error) { outcomes.push(String(error)); }
          for (const path of [() => ctx.registry, () => ctx.fiber, () => (ctx as unknown as { runtime: unknown }).runtime, () => ctx.get('root'), () => ctx.reflect.get('registry', false), () => ctx.extend({}).root]) {
            try { path(); outcomes.push('exposed'); } catch (error) { outcomes.push(String(error)); }
          }
        } } });
      expect(outcomes).toHaveLength(7);
      expect(outcomes.every(value => value.includes('KERNEL_API_FORBIDDEN'))).toBe(true);
      expect(h.runtime.get('dstu.victim')).toBeDefined();
    } finally { await h.runtime.dispose(); }
  });
  it.each(['restricted', 'full'] as const)('RF-P1-managed-plugin-install: B1 forwarded installer checks execution-time %s caller after await', async trust => {
    const h = await harness();
    const outcomes: string[] = [];
    try {
      await h.runtime.install({ name: 'victim', meta: { id: 'dstu.victim' }, apply() {} });
      await h.runtime.install({ name: 'forwarder', meta: { id: 'dstu.forwarder', provides: ['auditForward'] }, inject: ['dstuPluginInstaller'], apply(ctx) {
        ctx.provide('auditForward', { installer: ctx.dstuPluginInstaller });
      } });
      await h.runtime.installEntry({ packageRoot: join(root, trust), manifest: { id: `alice.${trust}`, packageName: 'audit', version: '1.0.0', engines: '^0.11', platforms: ['desktop'], permissions: [], requires: {}, trust },
        plugin: { name: trust, meta: { id: `alice.${trust}` }, async apply(ctx) {
          await Promise.resolve();
          const forwarded = ctx.get('auditForward').installer as DstuPluginInstaller;
          for (const call of [() => forwarded.inventory(), () => forwarded.plugins(), () => forwarded.uninstall('dstu.victim', 'absent'),
            () => forwarded.onActivation(async () => {}), () => forwarded.selfCheckContext('alice.audit', ['storage']),
            () => forwarded.installManagedDirectory({ id: 'alice.audit', directory: root, revision: 'absent', version: '1.0.0', permissions: [], confirmed: true })]) {
            try { await call(); outcomes.push('leaked'); } catch (error) { outcomes.push(String(error)); }
          }
        } } });
      expect(outcomes).toHaveLength(6);
      expect(outcomes.every(value => value.includes('KERNEL_API_FORBIDDEN'))).toBe(true);
      expect(h.runtime.get('dstu.victim')).toBeDefined();
    } finally { await h.runtime.dispose(); }
  });
  it('RF-P1-managed-plugin-install: B1 undeclared community access cannot retrieve or invoke the installer through any normal context path', async () => {
    const h = await harness();
    try {
      await h.runtime.install({ name: 'victim', meta: { id: 'dstu.victim' }, apply() {} });
      for (const trust of ['restricted', 'full'] as const) {
        const results: string[] = [];
        await h.runtime.installEntry({
          packageRoot: join(root, trust),
          manifest: { id: `alice.${trust}`, packageName: 'audit', version: '1.0.0', engines: '^0.11', platforms: ['desktop'], permissions: [], requires: {}, trust },
          plugin: { name: trust, meta: { id: `alice.${trust}`, version: '1.0.0' }, async apply(ctx) {
            for (const context of [() => ctx, () => ctx.extend({}), () => Object.create(ctx), () => ctx.root]) {
              for (const lookup of [() => context().dstuPluginInstaller, () => context().get('dstuPluginInstaller'), () => context().reflect.get('dstuPluginInstaller', false)]) {
                try {
                  const capability = lookup();
                  if (capability) {
                    const inventory = await capability.inventory();
                    await capability.uninstall('dstu.victim', inventory.revision!);
                    results.push('leaked');
                  } else results.push('absent');
                } catch (error) { results.push(String(error)); }
              }
            }
          } },
        });
        expect(results).toHaveLength(12);
        expect(results).not.toContain('leaked');
        expect(h.runtime.get('dstu.victim')).toBeDefined();
      }
      const inherited: string[] = [];
      await h.runtime.install({ name: 'declared', meta: { id: 'dstu.declared' }, inject: ['dstuPluginInstaller'], async apply(ctx) {
        expect((await ctx.extend({}).dstuPluginInstaller.inventory()).plugins.some(p => p.id === 'dstu.victim')).toBe(true);
        await ctx.plugin({ async apply(child) {
          for (const get of [() => child.dstuPluginInstaller, () => child.get('dstuPluginInstaller'), () => child.reflect.get('dstuPluginInstaller', false)]) {
            for (const call of [
              (cap: DstuPluginInstaller) => cap.inventory(),
              (cap: DstuPluginInstaller) => cap.plugins(),
              (cap: DstuPluginInstaller) => cap.uninstall('dstu.victim', 'any'),
              (cap: DstuPluginInstaller) => cap.installManagedDirectory({ id: 'alice.escape', directory: root, revision: 'any', version: '1.0.0', permissions: [], confirmed: true }),
            ]) {
              try { await call(get()); inherited.push('leaked'); }
              catch (error) { inherited.push(String(error)); }
            }
          }
        } });
      } });
      expect(inherited).toHaveLength(12);
      expect(inherited).not.toContain('leaked');
      expect(inherited.every(error => /KERNEL_API_FORBIDDEN|without inject|inactive context/.test(error))).toBe(true);
      expect(h.runtime.get('dstu.victim')).toBeDefined();
    } finally { await h.runtime.dispose(); }
  });
  it('RF-P1-managed-plugin-install: builtin capability exposes authoritative inventory, actual plugins and CAS uninstall', async () => {
    const h = await harness();
    try {
      await loadStartupProfile(h.runtime, { official: h.officeProfile, userProfile: h.userProfile, platform: 'desktop' });
      const installer = await builtinInstaller(h);
      expect(h.runtime.ctx.get('dstuPluginInstaller')).toBeUndefined();
      const running = installer.plugins();
      expect(Object.isFrozen(running)).toBe(true);
      expect(running).toEqual(h.runtime.plugins().map(entry => entry.plugin));
      expect(running.find(p => p.meta.id === 'dstu.configurable')?.Config).toBe(h.runtime.get('dstu.configurable')?.plugin.Config);
      const before = await installer.inventory();
      expect(before).toEqual(await ok(h, PLUGIN_MANAGER_LIST_COMMAND));
      expect(before.revision).toBe((await h.store.read()).revision);
      await expect(installer.uninstall('dstu.plain', 'stale-revision')).rejects.toThrow('PROFILE_CONFLICT');
      expect(h.runtime.get('dstu.plain')).toBeDefined();
      await installer.uninstall('dstu.plain', before.revision!);
      expect(h.runtime.get('dstu.plain')).toBeUndefined();
      expect(running.some(p => p.meta.id === 'dstu.plain')).toBe(true);
      expect(installer.plugins().some(p => p.meta.id === 'dstu.plain')).toBe(false);
      expect((await installer.inventory()).revision).not.toBe(before.revision);
    } finally { await h.runtime.dispose(); }
    const safe = await harness({ safeMode: true });
    try {
      const installer = await builtinInstaller(safe);
      expect((await installer.inventory()).safeMode).toBe(true);
      await expect(installer.uninstall('dstu.plain', (await safe.store.read()).revision)).rejects.toThrow('SAFE_MODE_ACTIVE');
    } finally { await safe.runtime.dispose(); }
  });
  it('RF-P1-managed-plugin-install: installs managed files, retains them on undo, restores without generation and rolls back failed replacement', async () => {
    const h = await harness();
    const demo = await community('alice.workshop');
    const directory = join(h.dataDir, 'dstu-workshop', demo.id, 'build');
    await mkdir(directory, { recursive: true });
    await cp(demo.dir, directory, { recursive: true });
    const request = { id: demo.id, directory, version: '1.0.0', permissions: [], revision: (await h.store.read()).revision, confirmed: true as const };
    try {
      await expect(h.admin.installManagedDirectory({ ...request, directory: demo.dir })).rejects.toThrow('PLUGIN_WORKSHOP_PATH_INVALID');
      for (const directory of [request.directory + '/..\\other', request.directory + '/..\\..\\plugins', 'C:\\dstu-data\\plugins', '\\\\server\\share\\plugin']) {
        await expect(h.admin.installManagedDirectory({ ...request, directory })).rejects.toThrow('PLUGIN_WORKSHOP_PATH_INVALID');
      }
      await expect(h.admin.installManagedDirectory({ ...request, version: '2.0.0' })).rejects.toThrow('CONSENT_STALE');
      await symlink(demo.module, join(directory, 'escape.mjs'));
      await expect(h.admin.installManagedDirectory(request)).rejects.toThrow();
      await rm(join(directory, 'escape.mjs'));
      const result = await h.admin.installManagedDirectory(request);
      expect(result).toMatchObject({ enabled: false, version: '1.0.0' });
      expect((await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND)).plugins.find(p => p.id === demo.id)).toMatchObject({ trust: 'full', source: 'workshop', consent: { matched: true } });
      const enabled = await ok<{revision:string}>(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, enabled: true, revision: result.revision });
      expect(await ok(h, UI_READY_COMMAND, { id: demo.id, version: '1.0.0' })).toEqual({ id: demo.id, matched: true });
      const previous = (await h.packages.list())[0];
      const failure = vi.spyOn(h.store, 'mutate').mockRejectedValueOnce(new Error('managed profile failure'));
      await expect(h.admin.installManagedDirectory({ ...request, revision: enabled.revision })).rejects.toThrow('managed profile failure');
      failure.mockRestore();
      expect((await h.packages.list())[0]).toEqual(previous);
      expect(h.runtime.get(demo.id)).toBeDefined();
      const brokenDirectory = join(h.dataDir, 'dstu-workshop', demo.id, 'broken');
      await cp(directory, brokenDirectory, { recursive: true });
      const brokenPkg = JSON.parse(await readFile(join(brokenDirectory, 'package.json'), 'utf8'));
      brokenPkg.version = '2.0.0';
      await writeFile(join(brokenDirectory, 'package.json'), JSON.stringify(brokenPkg));
      await writeFile(join(brokenDirectory, 'index.mjs'), `export default {name:'alice.workshop',meta:{id:'alice.workshop',version:'2.0.0'},apply(){throw new Error('broken new version')}}`);
      const broken = await h.admin.installManagedDirectory({ ...request, directory: brokenDirectory, version: '2.0.0', revision: enabled.revision });
      const concurrent = await h.store.mutate(broken.revision, file => file.plugins.push({ id: 'alice.unrelated', module: './unrelated.mjs', disabled: true }));
      expect(await invoke(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, revision: concurrent.revision, enabled: true })).toMatchObject({ kind: 'err', error: { details: { rollback: 'restored' } } });
      expect((await h.packages.list())[0]).toEqual(previous);
      expect(h.runtime.get(demo.id)?.manifest?.version).toBe('1.0.0');
      expect((await h.store.read()).file.plugins).toContainEqual({ id: 'alice.unrelated', module: './unrelated.mjs', disabled: true });
      expect(await h.consent.evaluate({ id: demo.id, version: '1.0.0', permissions: [] })).toMatchObject({ matched: true, trust: 'full', source: 'workshop' });
      const installer = await builtinInstaller(h);
      const undone = await installer.uninstall(demo.id, (await installer.inventory()).revision!) as {revision:string};
      expect(await h.packages.list()).toEqual([]);
      expect(h.runtime.get(demo.id)).toBeUndefined();
      expect(await readFile(join(directory, 'package.json'), 'utf8')).toContain(demo.id);
      const restored = await h.admin.installManagedDirectory({ ...request, revision: undone.revision });
      expect(restored).toMatchObject({ id: demo.id, enabled: false });
      await ok(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, enabled: true, revision: restored.revision });
      expect(await ok(h, UI_READY_COMMAND, { id: demo.id, version: '9.0.0' })).toEqual({ id: demo.id, matched: false });
      expect(h.runtime.get(demo.id)).toBeUndefined();
      expect(h.runtime.degradedPlugins()).toContainEqual({ id: demo.id, reason: 'VERSION_MISMATCH: UI version 9.0.0 differs from Host 1.0.0' });
    } finally { await h.runtime.dispose(); }
  });
  it('RF-P1-plugin-trust: requires exact confirmed trusted subject; full bypasses declarations but retains K7 and safe mode', async () => {
    const demo = await community('alice.trust');
    const kernel = await community('alice.kernel');
    const installer = await community('alice.installer');
    await writeFile(demo.module, `export default {name:'alice.trust',meta:{id:'alice.trust',version:'1.0.0'},inject:['storage'],apply(){}}`);
    await writeFile(kernel.module, `export default {name:'alice.kernel',meta:{id:'alice.kernel',version:'1.0.0'},inject:['commands'],apply(){}}`);
    await writeFile(installer.module, `export default {name:'alice.installer',meta:{id:'alice.installer',version:'1.0.0'},inject:['dstuPluginInstaller'],apply(){}}`);
    const h = await harness({ user: { plugins: [demo, kernel, installer].map(p => ({ id: p.id, module: p.module, disabled: true })) } });
    try {
      const subject = { id: demo.id, version: '1.0.0', permissions: [], trust: 'full', confirmed: true };
      expect(await err(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, subject, { window: 'other', webview: 'other' })).toMatch(/PLUGIN_MANAGER_FORBIDDEN|not allowed by ACL/);
      expect(await err(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, confirmed: false })).toContain('TRUST_CONFIRMATION_REQUIRED');
      expect(await err(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, version: '2.0.0' })).toContain('CONSENT_STALE');
      await ok(h, PLUGIN_MANAGER_CONSENT_COMMAND, subject);
      expect(await err(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, revision: (await h.store.read()).revision, enabled: true })).toContain('PERMISSION_UNDECLARED');
      expect(await ok(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, source: 'workshop' })).toMatchObject({ trust: 'full', source: 'package' });
      await ok(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, revision: (await h.store.read()).revision, enabled: true });
      expect(h.runtime.get(demo.id)).toBeDefined();
      const grantFailure = vi.spyOn(h.consent, 'grant').mockRejectedValueOnce(new Error('ledger write failed'));
      expect(await err(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, trust: 'restricted' })).toContain('CONSENT_WRITE_FAILED');
      grantFailure.mockRestore();
      expect(h.runtime.get(demo.id)).toBeDefined();
      expect(await h.consent.evaluate(subject)).toMatchObject({ trust: 'full', matched: true });
      await ok(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, trust: 'restricted' });
      expect(h.runtime.get(demo.id)).toBeUndefined();
      expect(await err(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: demo.id, revision: (await h.store.read()).revision, enabled: true })).toContain('PERMISSION_UNDECLARED');
      await ok(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, id: kernel.id });
      expect(await err(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: kernel.id, revision: (await h.store.read()).revision, enabled: true })).toContain('KERNEL_API_FORBIDDEN');
      for (const trust of ['restricted', 'full']) {
        await ok(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { ...subject, id: installer.id, trust });
        expect(await err(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: installer.id, revision: (await h.store.read()).revision, enabled: true })).toContain('KERNEL_API_FORBIDDEN');
        expect(h.runtime.get(installer.id)).toBeUndefined();
      }
    } finally { await h.runtime.dispose(); }
    const safe = await harness({ safeMode: true });
    try { expect(await err(safe, PLUGIN_MANAGER_SET_TRUST_COMMAND, {})).toContain('SAFE_MODE_ACTIVE'); }
    finally { await safe.runtime.dispose(); }
  });
  describe('RF-P1-plugin-display: metadata through the real ZIP lifecycle', () => {
  it('RF-W01-package-manager-wiring: installs a real ZIP disabled, grants exact consent, enables, disables and uninstalls its lock pointer', async () => {
    const h = await harness();
    try {
      const sink = new MemoryZipSink();
      const zip = new ZipWriter(sink, { codec: nodeZipCodec });
      await zip.addBytes('package.json', JSON.stringify({ name: 'manager-test', type: 'module', version: '1.0.0', engines: { deepStudent: '^0.11' },
        deepStudent: { manifestVersion: 1, id: 'alice.zip-test', platforms: ['desktop'], host: './index.mjs', permissions: ['service:log'],
          displayName: 'ZIP Study', icon: 'BookOpen', author: 'Alice', description: 'Study tool', category: 'learning', homepage: 'https://example.org/plugin' } }));
      await zip.addBytes('index.mjs', `export default {name:'alice.zip-test',meta:{id:'alice.zip-test',version:'1.0.0'},apply(){}}`);
      await zip.finish();
      const path = join(root, 'sample.dsplugin');
      await writeFile(path, sink.bytes());
      const revision = (await h.store.read()).revision;
      const result = await ok<PluginManagerInstallResult>(h, PLUGIN_MANAGER_INSTALL_COMMAND, { path, revision });
      expect(result).toMatchObject({ id: 'alice.zip-test', enabled: false, consentRequired: { id: 'alice.zip-test', version: '1.0.0', permissions: ['service:log'] } });
      expect(h.runtime.get(result.id)).toBeUndefined();
      const inventory = await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND);
      expect(inventory.plugins.find(p => p.id === result.id)).toMatchObject({ displayName: 'ZIP Study', icon: 'BookOpen', author: 'Alice', description: 'Study tool', category: 'learning', homepage: 'https://example.org/plugin' });
      expect(inventory.plugins.find(p => p.id === 'dstu.plain')).toMatchObject({
        displayName: 'Plain',
        displayNameKey: 'builtinNames.dstu.plain',
        descriptionKey: 'builtinDescriptions.dstu.plain',
        author: 'Deep Student',
        icon: 'Package',
      });
      expect((await h.packages.list())[0]?.enabled).toBe(false);
      const denied = await invoke(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: result.id, enabled: true, revision: result.revision });
      expect(denied).toMatchObject({ kind: 'err', error: { details: { code: 'CONSENT_REQUIRED', id: result.id, version: '1.0.0', permissions: ['service:log'] } } });
      expect((await h.store.read()).revision).toBe(result.revision);
      await ok(h, PLUGIN_MANAGER_CONSENT_COMMAND, { id: result.id, version: '1.0.0', permissions: ['service:log'] });
      const enabled = await ok<{revision:string}>(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: result.id, enabled: true, revision: result.revision });
      expect(h.runtime.get(result.id)).toBeDefined();
      expect((await h.packages.list())[0]?.enabled).toBe(true);
      const previousPackage = (await h.packages.list())[0];
      const upgradeFailure = vi.spyOn(h.store, 'mutate').mockRejectedValueOnce(new Error('upgrade profile failed'));
      expect(await invoke(h, PLUGIN_MANAGER_INSTALL_COMMAND, { path, revision: enabled.revision }))
        .toMatchObject({ kind: 'err', error: { details: { rollback: 'restored' } } });
      upgradeFailure.mockRestore();
      expect((await h.packages.list())[0]).toEqual(previousPackage);
      expect(h.runtime.get(result.id)).toBeDefined();
      const disabled = await ok<{revision:string}>(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: result.id, enabled: false, revision: enabled.revision });
      expect((await h.packages.list())[0]?.enabled).toBe(false);
      await writeFile(join(h.dataDir, 'plugins', previousPackage!.path, 'index.mjs'), 'tampered');
      expect(await err(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: result.id, enabled: true, revision: disabled.revision }))
        .toContain('PLUGIN_PACKAGE_INVALID');
      expect((await h.store.read()).revision).toBe(disabled.revision);
      await writeFile(join(h.dataDir, 'plugins', previousPackage!.path, 'index.mjs'),
        `export default {name:'alice.zip-test',meta:{id:'alice.zip-test',version:'1.0.0'},apply(){}}`);
      const reEnabled = await ok<{revision:string}>(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: result.id, enabled: true, revision: disabled.revision });
      expect(h.runtime.get(result.id)).toBeDefined();

      await ok(h, PLUGIN_MANAGER_SET_TRUST_COMMAND, { id: result.id, version: '1.0.0', permissions: ['service:log'], trust: 'full', confirmed: true });
      const reimport = await ok<PluginManagerInstallResult>(h, PLUGIN_MANAGER_INSTALL_COMMAND, { path, revision: reEnabled.revision });
      expect((await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND)).plugins.find(p => p.id === result.id)).toMatchObject({ trust: 'restricted', source: 'package' });
      const afterImport = await ok<{revision:string}>(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: result.id, enabled: true, revision: reimport.revision });

      // Uninstall whose profile write fails puts back the removed lock pointer and the running plugin.
      const pointerBeforeUninstall = (await h.packages.list())[0];
      const uninstallFailure = vi.spyOn(h.store, 'mutate').mockRejectedValueOnce(new Error('uninstall profile failed'));
      expect(await err(h, PLUGIN_MANAGER_UNINSTALL_COMMAND, { id: result.id, revision: afterImport.revision })).toContain('PROFILE_WRITE_FAILED');
      uninstallFailure.mockRestore();
      expect((await h.packages.list())[0]).toEqual(pointerBeforeUninstall);
      expect(h.runtime.get(result.id)).toBeDefined();

      // If a newer pointer appears before the rollback, it is kept and the old runtime is not restarted.
      const newerPointer = { ...pointerBeforeUninstall!, path: 'releases/alice.zip-test/1.0.0-00000000-0000-4000-8000-000000000001' };
      const racingFailure = vi.spyOn(h.store, 'mutate').mockImplementationOnce(async () => {
        await h.packages.restore(result.id, newerPointer, '');
        throw new Error('uninstall profile failed again');
      });
      const verifyRecordBypass = vi.spyOn(h.packages as unknown as { verifyRecord(record: unknown): Promise<void> }, 'verifyRecord').mockResolvedValue();
      expect(await err(h, PLUGIN_MANAGER_UNINSTALL_COMMAND, { id: result.id, revision: afterImport.revision })).toContain('PROFILE_WRITE_FAILED');
      racingFailure.mockRestore();
      verifyRecordBypass.mockRestore();
      expect((await h.packages.list())[0]?.path).toBe(newerPointer.path);
      expect(h.runtime.get(result.id)).toBeUndefined();
      await h.packages.restore(result.id, pointerBeforeUninstall!, newerPointer.path);
      await ok(h, PLUGIN_MANAGER_UNINSTALL_COMMAND, { id: result.id, revision: afterImport.revision });
      expect(await h.packages.list()).toEqual([]);

      // A profile integration failure restores the package pointer and reports its rollback state.
      const failure = vi.spyOn(h.store, 'mutate').mockRejectedValueOnce(new Error('profile disk failed'));
      const failed = await invoke(h, PLUGIN_MANAGER_INSTALL_COMMAND, { path, revision: (await h.store.read()).revision });
      expect(failed).toMatchObject({ kind: 'err', error: { details: { rollback: 'restored' } } });
      expect(await h.packages.list()).toEqual([]);
      failure.mockRestore();
    } finally { await h.runtime.dispose(); }
  });

  it('falls back to workshop.json title and description when package manifest omits displayName', async () => {
    const h = await harness();
    try {
      const workshopId = 'workshop.plugin-2d5baa5b-b55a-47b7-aa90-684b2c7f533a';
      const workshopDir = join(h.dataDir, 'dstu-workshop', workshopId);
      const workshopPkgDir = join(workshopDir, 'build', 'candidate');
      await mkdir(workshopPkgDir, { recursive: true });
      await writeFile(join(workshopDir, 'workshop.json'), JSON.stringify({ title: '学习专注计时与公式速查', description: '内存计时面板' }));
      await writeFile(join(workshopPkgDir, 'package.json'), JSON.stringify({
        name: 'dstu-workshop-focus', version: '1.0.0', type: 'module', engines: { deepStudent: '^0.11' },
        deepStudent: { manifestVersion: 1, id: workshopId, platforms: ['desktop'], host: './index.mjs' },
      }));
      await writeFile(join(workshopPkgDir, 'index.mjs'), `export default {name:'${workshopId}',meta:{id:'${workshopId}',version:'1.0.0'},apply(){}}`);
      const revision = (await h.store.read()).revision;
      await h.admin.installManagedDirectory({ id: workshopId, directory: workshopPkgDir, version: '1.0.0', permissions: [], revision, confirmed: true });
      const inventory = await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND);
      expect(inventory.plugins.find(p => p.id === workshopId)).toMatchObject({
        displayName: '学习专注计时与公式速查',
        description: '内存计时面板',
      });
    } finally {
      await h.runtime.dispose();
    }
  });
  });
  it('serializes profile CAS writes and preserves unrelated concurrently added entries', async () => {
    const h = await harness();
    try {
      const before = await h.store.read();
      const outcomes = await Promise.allSettled([
        h.store.mutate(before.revision, (file) => file.plugins.push({ id: 'alice.first', module: './first.mjs', disabled: true })),
        h.store.mutate(before.revision, (file) => file.plugins.push({ id: 'alice.second', module: './second.mjs', disabled: true })),
      ]);
      expect(outcomes.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
      const current = await h.store.read();
      expect(current.file.plugins.map((entry) => entry.id)).toEqual(['alice.first']);
      await h.store.mutate(current.revision, (file) => file.plugins.push({ id: 'alice.second', module: './second.mjs', disabled: true }));
      expect((await h.store.read()).file.plugins.map((entry) => entry.id)).toEqual(['alice.first', 'alice.second']);
    } finally { await h.runtime.dispose(); }
  });
  it('lists builtin running, disabled and profile-backed entries with a profile revision', async () => {
    const h = await harness({ user: { extends: 'official', plugins: [{ id: 'dstu.plain', disabled: true }] } });
    try {
      await loadStartupProfile(h.runtime, { official: h.officeProfile, userProfile: h.userProfile, platform: 'desktop' });
      const inventory = await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND);
      expect(inventory.safeMode).toBe(false);
      expect(inventory.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(inventory.plugins).toEqual([
        expect.objectContaining({ id: 'dstu.configurable', origin: 'builtin', enabled: true, state: 'running', hasConfig: true, permissions: [] }),
        expect.objectContaining({ id: 'dstu.plain', origin: 'builtin', enabled: false, state: 'disabled' }),
      ]);
    } finally {
      await h.runtime.dispose();
    }
  });

  it('requires the main window local page for every command', async () => {
    const h = await harness();
    try {
      // 远程来源在 ACL 就被拒；本地但非主 webview 的来源由管理器再拒一次（防误接）。
      for (const source of [
        { window: 'main', webview: 'main', origin: 'https://evil.example' } as WindowRef,
        { window: 'main', webview: 'main', origin: 'null' } as WindowRef,
      ]) {
        expect(await err(h, PLUGIN_MANAGER_LIST_COMMAND, {}, source)).toContain('not allowed by ACL');
      }
      for (const source of [
        { window: 'other', webview: 'other' } as WindowRef,
        { window: 'main', webview: 'child' } as WindowRef,
      ]) {
        expect(await err(h, PLUGIN_MANAGER_LIST_COMMAND, {}, source)).toMatch(/PLUGIN_MANAGER_FORBIDDEN|not allowed by ACL/);
      }
      for (const command of [PLUGIN_MANAGER_LIST_COMMAND, PLUGIN_MANAGER_CONFIG_COMMAND, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND,
        PLUGIN_MANAGER_SET_ENABLED_COMMAND, PLUGIN_MANAGER_UNINSTALL_COMMAND, PLUGIN_MANAGER_CONSENT_COMMAND, PLUGIN_MANAGER_INSTALL_COMMAND]) {
        expect(() => assertTrustedManagerSource({ window: 'main', webview: 'main', origin: 'https://evil.example' }, command)).toThrow('PLUGIN_MANAGER_FORBIDDEN');
        expect(await err(h, command, { caller: 'dstu.shell', window: 'main', origin: undefined }, { window: 'other', webview: 'other' }))
          .toMatch(/PLUGIN_MANAGER_FORBIDDEN|not allowed by ACL/);
      }
    } finally {
      await h.runtime.dispose();
    }
  });

  it('projects the Schemastery config schema, saves with CAS and hot-updates the running plugin', async () => {
    const h = await harness();
    try {
      await loadStartupProfile(h.runtime, { official: h.officeProfile, userProfile: h.userProfile, platform: 'desktop' });
      expect(appliedConfigs()[0]).toEqual({ enabled: true, mode: 'fast', retries: 2, label: 'x', hidden: 'h' });
      const view = await ok<PluginManagerConfigView>(h, PLUGIN_MANAGER_CONFIG_COMMAND, { id: 'dstu.configurable' });
      expect(view.values).toEqual({ enabled: true, mode: 'fast', retries: 2, label: 'x', hidden: 'h' });
      expect(view.schema?.fields).toEqual([
        expect.objectContaining({ path: 'enabled', type: 'boolean', default: true, description: '开关' }),
        expect.objectContaining({ path: 'mode', type: 'enum', options: ['fast', 'safe'], default: 'fast' }),
        expect.objectContaining({ path: 'retries', type: 'number', min: 0, max: 5, step: 1, default: 2 }),
        expect.objectContaining({ path: 'label', type: 'string', default: 'x' }),
        expect.objectContaining({ path: 'hidden', type: 'string', hidden: true, default: 'h' }),
      ]);

      const saved = await ok<{ id: string; revision: string }>(h, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND, {
        id: 'dstu.configurable', revision: view.revision, values: { ...(view.values as object), label: 'custom', mode: 'safe' },
      });
      expect(saved.revision).not.toBe(view.revision);
      expect(appliedConfigs().at(-1)).toEqual({ enabled: true, mode: 'safe', retries: 2, label: 'custom', hidden: 'h' });
      expect(JSON.parse(await readFile(h.userProfile, 'utf8'))).toEqual({
        extends: 'official',
        plugins: [{ id: 'dstu.configurable', module: expect.stringMatching(/^file:\/\/.*manager-configurable\.plugin\.ts$/), config: { enabled: true, mode: 'safe', retries: 2, label: 'custom', hidden: 'h' } }],
      });

      // 过期修订号：不覆盖、不热更新。
      expect(await err(h, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND, { id: 'dstu.configurable', revision: view.revision, values: { label: 'stale' } }))
        .toContain('PROFILE_CONFLICT');
      // schema 校验失败：不写 profile。
      expect(await err(h, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND, { id: 'dstu.configurable', revision: saved.revision, values: { retries: 99 } }))
        .toContain('CONFIG_INVALID');
      expect(appliedConfigs().at(-1)).toEqual({ enabled: true, mode: 'safe', retries: 2, label: 'custom', hidden: 'h' });
    } finally {
      await h.runtime.dispose();
    }
  });

  it('disables and re-enables a plugin while preserving unrelated profile entries', async () => {
    const h = await harness({
      user: { extends: 'official', plugins: [{ id: 'dstu.configurable', module: pathToFileURL(join(FIXTURES, 'manager-configurable.plugin.ts')).href, config: { label: 'kept' } }] },
    });
    try {
      await loadStartupProfile(h.runtime, { official: h.officeProfile, userProfile: h.userProfile, platform: 'desktop' });
      const before = await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND);
      const disabled = await ok<{ revision: string }>(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: 'dstu.configurable', enabled: false, revision: before.revision });
      expect(h.runtime.get('dstu.configurable')).toBeUndefined();
      const afterDisable = JSON.parse(await readFile(h.userProfile, 'utf8'));
      expect(afterDisable.plugins).toEqual([{ id: 'dstu.configurable', module: expect.any(String), config: { label: 'kept' }, disabled: true }]);
      expect((await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND)).plugins.find((p) => p.id === 'dstu.configurable'))
        .toEqual(expect.objectContaining({ enabled: false, state: 'disabled' }));

      await ok(h, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: 'dstu.configurable', enabled: true, revision: disabled.revision });
      expect(h.runtime.get('dstu.configurable')).toBeDefined();
      expect(appliedConfigs().at(-1)).toEqual(expect.objectContaining({ label: 'kept' }));
      expect(JSON.parse(await readFile(h.userProfile, 'utf8')).plugins).toEqual([
        { id: 'dstu.configurable', module: expect.stringMatching(/^file:/), config: { label: 'kept' } },
      ]);
    } finally {
      await h.runtime.dispose();
    }
  });

  it('uninstalls by unloading and removing only that profile entry', async () => {
    const h = await harness({ user: { extends: 'official', plugins: [{ id: 'dstu.configurable', module: pathToFileURL(join(FIXTURES, 'manager-configurable.plugin.ts')).href }] } });
    try {
      await loadStartupProfile(h.runtime, { official: h.officeProfile, userProfile: h.userProfile, platform: 'desktop' });
      const before = await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND);
      const result = await ok<{ id: string; removed: boolean }>(h, PLUGIN_MANAGER_UNINSTALL_COMMAND, { id: 'dstu.configurable', revision: before.revision });
      expect(result).toEqual({ id: 'dstu.configurable', removed: true, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
      // 官方 base 里仍有该插件：卸载只移除用户层条目，重启后它会回到官方默认。
      expect(h.runtime.get('dstu.configurable')).toBeUndefined();
      expect(JSON.parse(await readFile(h.userProfile, 'utf8'))).toEqual({ extends: 'official', plugins: [] });
    } finally {
      await h.runtime.dispose();
    }
  });

  it('blocks community plugins before import until consent is granted, then loads on enable', async () => {
    const demo = await community('alice.manager', { permissions: ['service:review'] });
    // 真实组合根：serveHost 注册管理器并把 W32 账本作为装载前门接入 loadStartupProfile。
    const h = await harness({ user: { extends: 'official', plugins: [{ id: demo.id, module: demo.module }] } });
    const transport = new MemoryTransport();
    const session = serveHost(transport, {
      officialProfile: h.officeProfile,
      contracts: () => ContractSet.empty(),
      onRuntime(runtime) {
        runtime.ctx.provide('paths', {});
        runtime.ctx.provide('storage', {});
        runtime.ctx.provide('log', {});
      },
    });
    try {
      transport.deliver({
        kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: h.dataDir,
        appVersion: '0.11.0', platform: 'linux', debug: true,
      } satisfies Handshake);
      const runtime = await session.ready;
      expect(runtime).not.toBeNull();
      expect(runtime!.plugins().map((entry) => entry.id)).toEqual(['dstu.plain', 'dstu.configurable']);
      expect(runtime!.degradedPlugins()).toEqual([{
        id: 'alice.manager',
        reason: 'CONSENT_REQUIRED: community plugin "alice.manager" 1.0.0 has no matching consent record (missing); confirm it in the plugin manager',
      }]);
      expect(applied()).toEqual([]);

      const h2: Harness = { ...h, runtime: runtime! };
      const inventory = await ok<PluginManagerInventory>(h2, PLUGIN_MANAGER_LIST_COMMAND);
      const entry = inventory.plugins.find((plugin) => plugin.id === 'alice.manager')!;
      expect(entry).toEqual(expect.objectContaining({
        origin: 'community', permissions: ['service:review'], state: 'degraded',
        consent: { matched: false, code: 'CONSENT_REQUIRED', reason: 'missing', grantedPermissions: [] },
      }));

      // 陈旧确认（版本/权限不符）拒绝。
      expect(await err(h2, PLUGIN_MANAGER_CONSENT_COMMAND, { id: 'alice.manager', version: '2.0.0', permissions: ['service:review'] }))
        .toContain('CONSENT_STALE');
      expect(await err(h2, PLUGIN_MANAGER_CONSENT_COMMAND, { id: 'alice.manager', version: '1.0.0', permissions: ['service:review', 'service:extra'] }))
        .toContain('CONSENT_STALE');

      const granted = await ok<{ id: string; permissionsDigest: string }>(h2, PLUGIN_MANAGER_CONSENT_COMMAND, {
        id: 'alice.manager', version: '1.0.0', permissions: ['service:review'],
      });
      expect(granted).toEqual({ id: 'alice.manager', version: '1.0.0', permissions: ['service:review'], permissionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/), trust: 'restricted', source: 'package' });
      expect((await ok<PluginManagerInventory>(h2, PLUGIN_MANAGER_LIST_COMMAND)).plugins.find((plugin) => plugin.id === 'alice.manager')?.consent)
        .toEqual({ matched: true, code: null, reason: null, grantedPermissions: ['service:review'] });

      const revision = (await ok<PluginManagerInventory>(h2, PLUGIN_MANAGER_LIST_COMMAND)).revision!;
      await ok(h2, PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: 'alice.manager', enabled: true, revision });
      expect(runtime!.get('alice.manager')?.manifest?.permissions).toEqual(['service:review']);
      expect(runtime!.uiManifestV2().degraded.some((entry) => entry.id === 'alice.manager')).toBe(false);
      expect(applied()).toEqual(['alice.manager']);
    } finally {
      await session.shutdown();
      await h.runtime.dispose();
    }
  });

  it('rejects every mutation in safe mode', async () => {
    const h = await harness({ safeMode: true });
    try {
      await loadStartupProfile(h.runtime, { official: h.officeProfile, userProfile: h.userProfile, platform: 'desktop' });
      const inventory = await ok<PluginManagerInventory>(h, PLUGIN_MANAGER_LIST_COMMAND);
      expect(inventory.safeMode).toBe(true);
      const revision = inventory.revision!;
      for (const [cmd, args] of [
        [PLUGIN_MANAGER_CONFIG_SAVE_COMMAND, { id: 'dstu.configurable', revision, values: {} }],
        [PLUGIN_MANAGER_SET_ENABLED_COMMAND, { id: 'dstu.plain', enabled: false, revision }],
        [PLUGIN_MANAGER_UNINSTALL_COMMAND, { id: 'dstu.plain', revision }],
        [PLUGIN_MANAGER_CONSENT_COMMAND, { id: 'alice.none', version: '1.0.0', permissions: [] }],
      ] as const) {
        expect(await err(h, cmd, args)).toContain('SAFE_MODE_ACTIVE');
      }
    } finally {
      await h.runtime.dispose();
    }
  });
});
