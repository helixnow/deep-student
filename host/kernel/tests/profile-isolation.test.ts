/**
 * profile 装载的按插件隔离语义（协调者指令 1）：
 * - 缺服务的插件不安装（inactive），依赖其服务的插件级联 inactive；
 * - `apply` 失败只撤销该插件自身（及因此缺服务的下游），其余插件继续；
 * - 全部未安装条目记 warn、广播 `host://plugins-degraded`，并可由 `plugin:host|status` 读取；
 * - 平台核心服务 `storage`/`paths`/`log` 缺失仍是 HostFatal；
 * - 用官方 `desktop.json` 做装载冒烟：平台插件 + 全部业务插件，校验核心服务与清单。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Message } from '@deepseek-ai/cordis';
import {
  definePlugin,
  HOST_STATUS_COMMAND,
  PLUGINS_DEGRADED_EVENT,
  type DegradedPlugin,
  type HostPlugin,
  type WindowRef,
} from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { installProfile, loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../profile.ts';
import type { BackendEvent } from '../protocol.ts';
import { HostRuntime } from '../runtime.ts';
import { syncStateDatabasePath } from '../../platform/storage/node.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const SOURCE: WindowRef = { window: 'main', webview: 'main' };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-profile-isolation-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createRuntime(events: BackendEvent[] = [], contracts = ContractSet.fromDirectory(`${FIXTURES}contracts`)): HostRuntime {
  return new HostRuntime({
    app: { dataDir: tempDir(), version: '0.0.0-test', platform: 'linux', debug: true },
    contracts,
    outbound: { send: (message) => void events.push(message as BackendEvent) },
  });
}

function plugin(id: string, options: {
  inject?: readonly string[];
  provides?: readonly string[];
  commands?: readonly string[];
  apply?: (ctx: Context) => void;
} = {}): HostPlugin {
  return definePlugin({
    meta: {
      id,
      ...(options.provides ? { provides: options.provides } : {}),
      ...(options.commands ? { commands: options.commands } : {}),
    },
    ...(options.inject ? { inject: options.inject } : {}),
    apply: options.apply ?? (() => undefined),
  });
}

async function status(runtime: HostRuntime): Promise<unknown> {
  return runtime.dispatchInvoke({ id: 'status', cmd: HOST_STATUS_COMMAND, args: {}, source: SOURCE });
}

describe('isolated profile loading', () => {
  it('marks plugins whose services nobody provides as inactive and cascades to their dependents', async () => {
    const events: BackendEvent[] = [];
    const logs: Message[] = [];
    const runtime = createRuntime(events);
    // 默认阈值只导出 error；测试要核对逐条 warn。
    runtime.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    try {
      const rootless = plugin('demo.rootless', {
        inject: ['root'], provides: ['a'],
        apply(ctx) { ctx.provide('a', {}); },
      });
      const dependent = plugin('demo.dependent', {
        inject: ['a'], provides: ['b'],
        apply(ctx) { ctx.provide('b', {}); },
      });
      const cascaded = plugin('demo.cascaded', { inject: ['b'] });
      const independent = plugin('demo.independent');

      const result = await installProfile(runtime, [
        { plugin: rootless }, { plugin: dependent }, { plugin: cascaded }, { plugin: independent },
      ]);

      expect(result.installed.map(entry => entry.id)).toEqual(['demo.independent']);
      expect(result.degraded).toEqual<DegradedPlugin[]>([
        { id: 'demo.rootless', reason: 'SERVICE_MISSING: missing service "root"' },
        { id: 'demo.dependent', reason: 'SERVICE_MISSING: missing service "a" (provided by inactive plugin "demo.rootless")' },
        { id: 'demo.cascaded', reason: 'SERVICE_MISSING: missing service "b" (provided by inactive plugin "demo.dependent")' },
      ]);

      // warn 逐条记录，事件与 status 命令返回同一份清单。
      const warnings = logs.filter(message => message.name === 'host' && message.type === 'warn').map(message => String(message.args[0]));
      expect(warnings).toEqual(result.degraded.map(item => `[host] plugin "${item.id}" is inactive: ${item.reason}`));
      expect(events.filter(event => event.event === PLUGINS_DEGRADED_EVENT).map(event => event.payload)).toEqual([result.degraded]);
      await expect(status(runtime)).resolves.toEqual({ kind: 'ok', value: result.degraded });
    } finally {
      await runtime.dispose();
    }
  });

  it('rolls back only the failing plugin and its dependents, keeping earlier and independent plugins', async () => {
    const events: BackendEvent[] = [];
    const runtime = createRuntime(events);
    try {
      const base = plugin('demo.base', {
        provides: ['base'],
        apply(ctx) { ctx.provide('base', { ok: true }); },
      });
      const broken = plugin('demo.broken', {
        inject: ['base'], provides: ['broken'], commands: ['fixture_greet'],
        apply(ctx) {
          ctx.commands.register('fixture_greet', () => null);
          ctx.provide('broken', {});
          throw new Error('apply exploded');
        },
      });
      const downstream = plugin('demo.downstream', { inject: ['broken'] });
      const independent = plugin('demo.independent');

      const result = await installProfile(runtime, [
        { plugin: base }, { plugin: broken }, { plugin: downstream }, { plugin: independent },
      ]);

      expect(result.installed.map(entry => entry.id)).toEqual(['demo.base', 'demo.independent']);
      expect(result.degraded).toEqual<DegradedPlugin[]>([
        { id: 'demo.broken', reason: 'APPLY_FAILED: apply exploded' },
        { id: 'demo.downstream', reason: 'SERVICE_MISSING: missing service "broken" (provided by inactive plugin "demo.broken")' },
      ]);
      // apply 中注册的命令随该插件回滚；base 与 independent 不受影响。
      expect(runtime.commands.has('fixture_greet')).toBe(false);
      expect(runtime.ctx.get('base')).toBeDefined();
      await expect(status(runtime)).resolves.toEqual({ kind: 'ok', value: result.degraded });
      expect(events.filter(event => event.event === PLUGINS_DEGRADED_EVENT)).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('answers degraded plugin commands with MAINTENANCE during startup maintenance and yields to real handlers', async () => {
    const runtime = createRuntime();
    let maintenance: { reason: string } | null = { reason: 'Migration error: boom' };
    runtime.ctx.provide('storage', { startupMaintenance: () => maintenance } as never);
    const invoke = (cmd: string) => runtime.dispatchInvoke({ id: cmd, cmd, args: { name: 'x' }, source: SOURCE });
    try {
      const broken = plugin('dstu.broken', {
        commands: ['fixture_greet', 'fixture_struct'],
        apply() { throw new Error('schema missing'); },
      });
      const result = await installProfile(runtime, [{ plugin: broken }]);
      expect(result.degraded).toEqual([{ id: 'dstu.broken', reason: 'APPLY_FAILED: schema missing' }]);
      expect(runtime.commands.has('fixture_greet')).toBe(false);

      // 错误形状按命令错误契约选择：string 契约得到 Rust 文本，`{code,message}` 契约得到带 data 的对象
      // （真实 `_shared.json` AppError 形状由 backup 的官方 profile 测试覆盖）。
      await expect(invoke('fixture_greet')).resolves.toEqual({
        kind: 'err', error: 'MAINTENANCE_MODE: broken is temporarily unavailable',
      });
      await expect(invoke('fixture_struct')).resolves.toEqual({
        kind: 'err',
        error: {
          code: 'MAINTENANCE',
          message: 'MAINTENANCE_MODE: broken is temporarily unavailable',
          data: { code: 'MAINTENANCE', component: 'broken', reason: 'Migration error: boom' },
        },
      });

      // 不在启动维护态：照常 command not found。
      maintenance = null;
      await expect(invoke('fixture_greet')).resolves.toEqual({ kind: 'err', error: 'fixture_greet not allowed. Command not found' });

      // 插件之后正常装配：真实命令优先，占位自动让位。
      maintenance = { reason: 'Migration error: boom' };
      const healthy = plugin('dstu.healthy', {
        commands: ['fixture_greet'],
        apply(ctx) { ctx.commands.register<{ name: string }>('fixture_greet', ({ name }) => `hi ${name}`); },
      });
      expect((await runtime.installIsolated({ plugin: healthy })).ok).toBe(true);
      await expect(invoke('fixture_greet')).resolves.toEqual({ kind: 'ok', value: 'hi x' });
      expect(runtime.commands.has('fixture_greet')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('treats missing platform core services as fatal on official startup', async () => {
    const runtime = createRuntime();
    try {
      await expect(loadStartupProfile(runtime, { official: `${FIXTURES}e2e.profile.json` }))
        .rejects.toThrow('platform core services unavailable: "storage", "paths", "log"');
    } finally {
      await runtime.dispose();
    }
  });

  it('loads the official desktop profile and reports the inactive plugins', async () => {
    const events: BackendEvent[] = [];
    // 冒烟使用仓库真实契约：平台插件的命令必须全部来自 Rust。
    const runtime = createRuntime(events, ContractSet.fromDirectory());
    try {
      const result = await loadStartupProfile(runtime, { official: OFFICIAL_PROFILE_PATH }).catch(error => {
        // A missing core service is the aggregate failure. Preserve it and expose the real
        // plugin apply/dependency reason in full-suite artifacts, without relaxing readiness.
        throw new Error(`${String(error)}; degraded plugins: ${JSON.stringify(runtime.degradedPlugins())}`, { cause: error });
      });
      const ids = result.installed.map(entry => entry.id);
      // 平台核心服务全部就绪（否则 loadStartupProfile 已经抛出 HostFatal）。
      for (const name of ['paths', 'log', 'secrets', 'storage', 'settings', 'startupGate']) expect(runtime.ctx.get(name), name).toBeDefined();
      for (const id of ['dstu.platform.paths', 'dstu.platform.log', 'dstu.platform.storage', 'dstu.platform.settings', 'dstu.plugins', 'dstu.shell']) {
        expect(ids, id).toContain(id);
      }
      // The real W13 provider must be installed before F3 can begin startup cleanup.
      expect(ids).toContain('dstu.sync-startup');
      expect(ids.indexOf('dstu.sync-startup')).toBeLessThan(ids.indexOf('dstu.platform.storage'));
      expect(runtime.ctx.get('storageStartupSync')).toBeDefined();
      // dstu.shell 的 23 个命令确实注册在生产命令表里，而不只是测试可达。
      const shell = result.installed.find(entry => entry.id === 'dstu.shell');
      expect(shell).toBeDefined();
      expect(shell!.plugin.meta.commands).toHaveLength(23);
      for (const command of shell!.plugin.meta.commands ?? []) expect(runtime.commands.has(command), command).toBe(true);
      // 未安装条目必须带原因，且不能同时出现在 installed 中；全部就绪时清单为空。
      for (const item of result.degraded) {
        expect(item.reason.length, item.id).toBeGreaterThan(0);
        expect(ids, item.id).not.toContain(item.id);
      }
      // 官方清单里的每个条目（平台 + 全部业务插件）都必须有去向：已安装或 inactive。
      const profile = JSON.parse(await readFile(OFFICIAL_PROFILE_PATH, 'utf8')) as { plugins: { id: string }[] };
      const accounted = [...ids, ...result.degraded.map(item => item.id)].sort();
      expect(accounted).toEqual(profile.plugins.map(entry => entry.id).sort());
      const graded = events.filter(event => event.event === PLUGINS_DEGRADED_EVENT);
      expect(graded.map(event => event.payload)).toEqual(result.degraded.length ? [result.degraded] : []);
      await expect(status(runtime)).resolves.toEqual({ kind: 'ok', value: result.degraded });
    } finally {
      await runtime.dispose();
    }
  }, 240_000);

  it.each(['success', 'reset-error', 'marker-error'] as const)('W13 official profile consumes the real early reset before storage (%s)', async scenario => {
    const local = tempDir();
    vi.stubEnv('XDG_DATA_HOME', local);
    vi.stubEnv('XDG_CONFIG_HOME', join(local, 'config'));
    vi.stubEnv('XDG_CACHE_HOME', join(local, 'cache'));
    vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
    const runtime = createRuntime([], ContractSet.fromDirectory());
    const marker = join(runtime.app.dataDir, '.purge_on_next_start');
    // Real filesystem failures: a directory cannot be opened as a SQLite file,
    // and the marker's file-unlink operation cannot remove a directory.
    if (scenario === 'marker-error') mkdirSync(marker);
    else writeFileSync(marker, '1');
    if (scenario === 'reset-error') mkdirSync(syncStateDatabasePath(local), { recursive: true });
    const trace: string[] = [];
    const install = runtime.installIsolated.bind(runtime);
    // Observe the actual provider after its real apply. Both installation and reset
    // forward to production implementations; no test service or replacement SQL.
    vi.spyOn(runtime, 'installIsolated').mockImplementation(async entry => {
      const result = await install(entry);
      if (entry.plugin.meta.id === 'dstu.sync-startup' && result.ok) {
        const service = runtime.ctx.get('storageStartupSync')!;
        const reset = service.resetDefaultAfterLocalPurge.bind(service);
        trace.push('provider-ready');
        vi.spyOn(service, 'resetDefaultAfterLocalPurge').mockImplementation(async () => {
          trace.push('reset-before-storage');
          expect(runtime.ctx.get('storage')).toBeUndefined();
          expect(existsSync(marker)).toBe(true);
          await reset();
          expect(statSync(syncStateDatabasePath(local)).isFile()).toBe(true);
          trace.push('reset-complete');
        });
      }
      return result;
    });
    try {
      const loaded = await loadStartupProfile(runtime, { official: OFFICIAL_PROFILE_PATH });
      expect(trace).toEqual(scenario === 'reset-error'
        ? ['provider-ready', 'reset-before-storage']
        : ['provider-ready', 'reset-before-storage', 'reset-complete']);
      if (scenario === 'success') {
        expect(existsSync(marker)).toBe(false);
        expect(runtime.ctx.dataSpace.status().recovery_required).toBe(false);
        expect(runtime.ctx.storage.database('mistakes')).toBeDefined();
      } else {
        expect(existsSync(marker)).toBe(true);
        expect(runtime.ctx.dataSpace.status().recovery_required).toBe(true);
        expect(() => runtime.ctx.storage.database('mistakes')).toThrow('业务数据库保持关闭');
      }
      const ids = loaded.installed.map(entry => entry.id);
      expect(ids.indexOf('dstu.sync-startup')).toBeLessThan(ids.indexOf('dstu.platform.storage'));
    } finally {
      try { await runtime.dispose(); }
      finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
    }
  }, 240_000);
});
