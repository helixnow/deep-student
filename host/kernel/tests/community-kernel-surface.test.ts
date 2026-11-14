/**
 * SEC-E06 Host 半第一块（API.md §16.7 第 2 项）：插件 API v1 不给社区插件 `ctx.commands` / `ctx.protocols` /
 * `ctx.backendEvents` / `ctx.shell`。装载时拒绝 `meta.commands` 与注入这些服务，运行时拒绝社区插件调用它们
 * （`KERNEL_API_FORBIDDEN`）；官方插件与归属不明的调用保持原行为。同进程内只防误用，不是隔离边界。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePlugin, type HostPlugin } from '../api.ts';
import { HOST_STATUS_COMMAND } from '../core.ts';
import { ContractSet } from '../contracts.ts';
import { checkPluginModule, parseDegradedReason, type PluginManifest } from '../manifest.ts';
import { loadProfile } from '../profile.ts';
import { createTestHost, type TestHost } from '../testing.ts';

const PACKAGE_ROOT = '/opt/community/alice.probe';
const FORBIDDEN = (method: string) => `KERNEL_API_FORBIDDEN: ${method} is not available to community plugins in plugin API v1`;

let host: TestHost | null = null;
afterEach(async () => {
  await host?.dispose();
  host = null;
});

interface Probe {
  outcomes: Record<string, string>;
  heard: string[];
  shell?: Promise<string>;
}

/** apply 中逐个调用 kernel 服务，记录每次调用的结果（`ok` 或错误文案）。 */
function prober(id: string, probe: Probe, extra: (ctx: Parameters<HostPlugin['apply']>[0]) => void = () => {}): HostPlugin {
  return definePlugin({
    meta: { id, commands: ['get_setting'] },
    apply(ctx) {
      const attempt = (name: string, call: () => unknown) => {
        try {
          call();
          probe.outcomes[name] = 'ok';
        } catch (error) {
          probe.outcomes[name] = (error as Error).message;
        }
      };
      attempt('commands.register', () => ctx.commands.register('get_setting', () => 'probe'));
      attempt('protocols.register', () => ctx.protocols.register('probe', () => ({ status: 200, headers: {}, body: new Uint8Array() })));
      attempt('backendEvents.emit', () => ctx.backendEvents.emit('probe:emit', 1));
      attempt('backendEvents.emitTo', () => ctx.backendEvents.emitTo({ kind: 'App' }, 'probe:emit-to', 2));
      attempt('backendEvents.listen', () => ctx.backendEvents.listen('probe:in', () => probe.heard.push('listen')));
      attempt('backendEvents.listenWindow', () => ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, 'probe:in', () => probe.heard.push('window')));
      attempt('commands.has', () => ctx.commands.has('get_setting'));
      probe.shell = ctx.shell.request('probe-op').then(() => 'ok', (error: Error) => error.message);
      extra(ctx);
    },
  });
}

const freshProbe = (): Probe => ({ outcomes: {}, heard: [] });

describe('SEC-E06 [W01] community plugins cannot use kernel-only services at runtime', () => {
  it('refuses every guarded method for a community plugin, and none of them takes effect', async () => {
    host = await createTestHost();
    const probe = freshProbe();
    const result = await host.runtime.installIsolated({ plugin: prober('alice.probe', probe), packageRoot: PACKAGE_ROOT });
    expect(result.ok).toBe(true);
    expect(probe.outcomes).toEqual({
      'commands.register': FORBIDDEN('ctx.commands.register("get_setting")'),
      'protocols.register': FORBIDDEN('ctx.protocols.register("probe")'),
      'backendEvents.emit': FORBIDDEN('ctx.backendEvents.emit'),
      'backendEvents.emitTo': FORBIDDEN('ctx.backendEvents.emitTo'),
      'backendEvents.listen': FORBIDDEN('ctx.backendEvents.listen'),
      'backendEvents.listenWindow': FORBIDDEN('ctx.backendEvents.listenWindow'),
      'commands.has': 'ok',
    });
    await expect(probe.shell).resolves.toBe(FORBIDDEN('ctx.shell.request("probe-op")'));
    expect(parseDegradedReason(probe.outcomes['backendEvents.emit']!).code).toBe('KERNEL_API_FORBIDDEN');

    expect(host.runtime.commands.has('get_setting')).toBe(false);
    expect(host.runtime.protocols.has('probe')).toBe(false);
    expect(host.eventsNamed('probe:emit')).toEqual([]);
    expect(host.eventsNamed('probe:emit-to')).toEqual([]);
    expect(host.shellRequests).toEqual([]);
    host.emitFrontend('probe:in', 'x');
    expect(probe.heard).toEqual([]);
  });

  it('keeps the original behavior for the same plugin when it is official (no packageRoot)', async () => {
    host = await createTestHost({ shellTimeoutMs: 60_000 });
    const probe = freshProbe();
    const result = await host.runtime.installIsolated({ plugin: prober('dstu.probe', probe) });
    expect(result.ok).toBe(true);
    expect(Object.values(probe.outcomes)).toEqual(Array(7).fill('ok'));
    expect(host.runtime.commands.has('get_setting')).toBe(true);
    expect(host.runtime.protocols.has('probe')).toBe(true);
    expect(host.eventsNamed('probe:emit')).toEqual([1]);
    expect(host.eventsNamed('probe:emit-to')).toEqual([2]);
    expect(host.shellRequests.map(r => r.op)).toEqual(['probe-op']);
    host.emitFrontend('probe:in', 'x');
    expect(probe.heard).toEqual(['listen', 'window']);
    await expect(host.invoke('get_setting', { key: 'k' })).resolves.toBe('probe');
  });

  it('attributes official service calls as before but rejects community root context traversal', async () => {
    host = await createTestHost();
    const official = definePlugin({
      meta: { id: 'dstu.probe-provider', provides: ['probeProvider'] },
      apply(ctx) {
        ctx.provide('probeProvider', { ping: (n: number) => ctx.backendEvents.emit('provider:ping', n) });
      },
    });
    const outcomes: string[] = [];
    const community = definePlugin({
      meta: { id: 'alice.uses-provider' },
      inject: ['probeProvider'],
      apply(ctx) {
        (ctx.get('probeProvider') as { ping(n: number): void }).ping(7);
        try { ctx.root.backendEvents.emit('root:emit', 8); }
        catch (error) { outcomes.push((error as Error).message); }
        try {
          ctx.get('backendEvents')!.emit('get:emit', 9);
          outcomes.push('ok');
        } catch (error) {
          outcomes.push((error as Error).message);
        }
      },
    });
    await host.runtime.installAll([{ plugin: official }, { plugin: community, packageRoot: PACKAGE_ROOT }]);
    expect(host.eventsNamed('provider:ping')).toEqual([7]);
    expect(host.eventsNamed('root:emit')).toEqual([]);
    expect(host.eventsNamed('get:emit')).toEqual([]);
    expect(outcomes).toEqual([FORBIDDEN('ctx.root'), FORBIDDEN('ctx.backendEvents.emit')]);
  });
});

describe('SEC-E06 [W01] community modules declaring kernel surface are rejected before install', () => {
  const manifest: PluginManifest = {
    id: 'alice.probe', packageName: 'deepstudent-plugin-alice-probe', version: '1.0.0', engines: '^0.11',
    platforms: ['desktop'], host: './index.mjs', requires: {}, permissions: ['service:shell', 'service:notes'],
  };
  const module = (meta: Record<string, unknown>, inject: string[] = []) =>
    definePlugin({ meta: { id: 'alice.probe', version: '1.0.0', ...meta }, inject, apply() {} });

  it('meta.commands and injected kernel services → KERNEL_API_FORBIDDEN; ordinary services still pass', () => {
    expect(checkPluginModule(manifest, module({ commands: ['get_setting'] }))?.message)
      .toBe('KERNEL_API_FORBIDDEN: declares meta.commands "get_setting"; app commands are not open to community plugins in plugin API v1 (use meta.remote)');
    expect(checkPluginModule(manifest, module({}, ['shell']))?.message)
      .toBe('KERNEL_API_FORBIDDEN: injects kernel services "shell", which are not open to community plugins in plugin API v1');
    expect(checkPluginModule(manifest, module({}, ['backendEvents', 'commands']))?.code).toBe('KERNEL_API_FORBIDDEN');
    expect(checkPluginModule(manifest, module({ commands: [] }, ['notes', 'log']))).toBeNull();
    expect(checkPluginModule(manifest, module({ remote: { ping: 'ping' } }, ['notes']))).toBeNull();
  });
});

/** Vitest 只能导入仓库内的模块：社区插件包写到仓库根的 `.tmp/`（已 gitignore，位于 host/、electron/ 之外即社区来源）。 */
const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url));

describe('SEC-E06 [W01] end to end through profile loading', () => {
  let root: string;
  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
    root = await mkdtemp(join(TMP, 'w01-kernel-surface-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function communityPackage(id: string, meta: Record<string, unknown>, body: string): Promise<{ id: string; module: string }> {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: `deepstudent-plugin-${id.replace(/\./g, '-')}`, version: '1.0.0', type: 'module', engines: { deepStudent: '^0.11' },
      deepStudent: { manifestVersion: 1, id, platforms: ['desktop'], host: './index.mjs' },
    }));
    await writeFile(join(dir, 'index.mjs'), [
      `const meta = ${JSON.stringify({ id, version: '1.0.0', ...meta })};`,
      `export default { name: ${JSON.stringify(id)}, meta, apply(ctx) { ${body} } };`,
    ].join('\n'));
    return { id, module: join(dir, 'index.mjs') };
  }

  it('degrades only the offending community plugins, with the code in plugin:host|status', async () => {
    const emitter = await communityPackage('alice.emitter', {}, `ctx.backendEvents.emit('alice.emitter:hello', 1);`);
    const claimer = await communityPackage('alice.claimer', { commands: ['get_setting'] }, `globalThis.__w01ClaimerApplied = true;`);
    const quiet = await communityPackage('alice.quiet', {}, `globalThis.__w01QuietHas = ctx.commands.has('get_setting');`);
    const profile = join(root, 'user.profile.json');
    await writeFile(profile, JSON.stringify({ plugins: [emitter, claimer, quiet] }));
    const g = globalThis as { __w01ClaimerApplied?: boolean; __w01QuietHas?: boolean };
    try {
      host = await createTestHost({ app: { version: '0.11.0', dataDir: join(root, 'data') }, contracts: ContractSet.empty() });
      const result = await loadProfile(host.runtime, profile, { platform: 'desktop' });
      expect(result.installed.map(p => p.id)).toEqual(['alice.quiet']);
      expect(g.__w01QuietHas).toBe(false);
      expect(g.__w01ClaimerApplied).toBeUndefined();
      expect(host.eventsNamed('alice.emitter:hello')).toEqual([]);
      const status = await host.invoke<{ id: string; reason: string }[]>(HOST_STATUS_COMMAND);
      expect(status.map(item => ({ id: item.id, code: parseDegradedReason(item.reason).code }))).toEqual([
        { id: 'alice.claimer', code: 'KERNEL_API_FORBIDDEN' },
        { id: 'alice.emitter', code: 'KERNEL_API_FORBIDDEN' },
      ]);
      expect(status.find(item => item.id === 'alice.emitter')!.reason).toBe(FORBIDDEN('ctx.backendEvents.emit'));
    } finally {
      delete g.__w01ClaimerApplied;
      delete g.__w01QuietHas;
    }
  });
});
