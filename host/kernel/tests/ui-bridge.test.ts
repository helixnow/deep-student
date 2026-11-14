/**
 * 前端插件化 F0b（`docs/plugins/FRONTEND.md` §3、§5）：
 * UI 引导清单（只列 `host/` 之外的用户插件）、`host://ui-manifest` 事件、
 * `plugin:ui|manifest` 与 `plugin:host|call` 的放行/拒绝。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandError,
  definePlugin,
  HOST_CALL_COMMAND,
  UI_MANIFEST_COMMAND,
  UI_MANIFEST_EVENT,
  type WindowRef,
} from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { AppError } from '../../platform/errors/api.ts';
import type { BackendEvent } from '../protocol.ts';
import { DEFAULT_HOST_CALL_CALLER_MODE, HostRuntime, type HostCallCallerMode } from '../runtime.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const HOST_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE: WindowRef = { window: 'main', webview: 'main' };
const contracts = () => ContractSet.fromDirectory(`${FIXTURES}contracts`);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-ui-bridge-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(dataDir: string) {
  return { dataDir, version: '0.0.0-test', platform: 'linux' as const, debug: true };
}

function runtimeWith(outbound?: (message: BackendEvent) => void, hostCallCaller?: HostCallCallerMode): HostRuntime {
  const dir = tempDir();
  return new HostRuntime({
    app: app(dir),
    contracts: contracts(),
    ...(outbound ? { outbound: { send: message => outbound(message as BackendEvent) } } : {}),
    ...(hostCallCaller ? { hostCallCaller } : {}),
  });
}

describe('ui manifest', () => {
  it('lists user plugins with meta.ui, skips official modules and emits host://ui-manifest', async () => {
    const dir = tempDir();
    const events: BackendEvent[] = [];
    const runtime = runtimeWith(message => void events.push(message));
    try {
      // 用户/社区插件：模块在 host/ 之外，meta.ui 相对插件模块解析为绝对路径。
      const demo = definePlugin({
        meta: { id: 'community.demo', provides: ['wordOfDay'], ui: './ui.mjs', version: '1.2.3' },
        apply(ctx) {
          ctx.provide('wordOfDay', { today: () => 'today' });
        },
      });
      await runtime.installAll([{ plugin: demo, source: pathToFileURL(join(dir, 'index.mjs')).href }]);

      const expected = [{ id: 'community.demo', file: join(dir, 'ui.mjs'), version: '1.2.3' }];
      expect(runtime.uiManifest()).toEqual(expected);
      await expect(runtime.dispatchInvoke({ id: 'manifest', cmd: UI_MANIFEST_COMMAND, args: {}, source: SOURCE }))
        .resolves.toEqual({ kind: 'ok', value: expected });

      const manifestEvents = () => events.filter((event): event is Extract<BackendEvent, { kind: 'event' }> => event.kind === 'event' && event.event === UI_MANIFEST_EVENT);
      expect(manifestEvents().map(event => event.payload)).toEqual([expected]);

      // 官方插件的 UI 半已打包进前端：模块位于 host/ 内，即使声明 meta.ui 也不进清单，也不发事件。
      const official = definePlugin({ meta: { id: 'dstu.official-demo', ui: './ui.tsx' }, apply() {} });
      await runtime.installAll([{ plugin: official, source: pathToFileURL(join(HOST_ROOT, 'plugins/official-demo/index.ts')).href }]);
      expect(runtime.uiManifest()).toEqual(expected);
      expect(manifestEvents()).toHaveLength(1);

      await runtime.unload('community.demo');
      expect(runtime.uiManifest()).toEqual([]);
      expect(manifestEvents().map(event => event.payload)).toEqual([expected, []]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('plugin:host|call', () => {
  const service = {
    today: (who: unknown) => `today:${String(who)}`,
    secret: () => 'secret',
    wait: (_arg: unknown, options: { signal: AbortSignal }) => new Promise<string>((resolve) => {
      options.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    }),
    boom: () => {
      throw new CommandError(AppError.validation('boom from plugin'));
    },
    crash: () => {
      throw new Error('crash');
    },
    bad: () => new Map([['a', 1]]),
    big: () => ({ n: 1n, nested: [2n] }),
    echo: (value: unknown) => value,
  };

  async function hostWithRemote(hostCallCaller?: HostCallCallerMode): Promise<HostRuntime> {
    const runtime = runtimeWith(undefined, hostCallCaller);
    const plugin = definePlugin({
      meta: {
        id: 'community.remote',
        provides: ['wordOfDay'],
        remote: { wordOfDay: ['today', 'wait', 'boom', 'crash', 'bad', 'big', 'echo'] },
      },
      apply(ctx) {
        ctx.provide('wordOfDay', service);
      },
    });
    await runtime.install(plugin);
    return runtime;
  }

  const call = (runtime: HostRuntime, args: unknown, signal?: AbortSignal) =>
    runtime.dispatchInvoke({ id: 'call', cmd: HOST_CALL_COMMAND, args, source: SOURCE }, signal);
  /** 生产形状：UI 半以自己的插件 id 调自己 Host 半的服务（默认 `require` 模式）。 */
  const callOwn = (runtime: HostRuntime, args: Record<string, unknown>, signal?: AbortSignal) =>
    call(runtime, { caller: 'community.remote', ...args }, signal);

  it('allows methods listed in meta.remote and passes { signal } as the last argument', async () => {
    const runtime = await hostWithRemote();
    try {
      await expect(callOwn(runtime, { service: 'wordOfDay', method: 'today', args: ['Ada'] }))
        .resolves.toEqual({ kind: 'ok', value: 'today:Ada' });

      const controller = new AbortController();
      const pending = callOwn(runtime, { service: 'wordOfDay', method: 'wait', args: ['forever'] }, controller.signal);
      controller.abort('window-closed');
      await expect(pending).resolves.toEqual({ kind: 'ok', value: 'aborted' });
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects methods missing from meta.remote and services no loaded plugin provides', async () => {
    const runtime = await hostWithRemote();
    try {
      await expect(callOwn(runtime, { service: 'wordOfDay', method: 'secret', args: [] })).resolves.toEqual({
        kind: 'err',
        error: AppError.validation('service "wordOfDay" does not expose "secret" to UI (declare it in meta.remote)'),
      });
      await expect(callOwn(runtime, { service: 'ghost', method: 'today', args: [] })).resolves.toEqual({
        kind: 'err',
        error: AppError.validation('unknown service "ghost"'),
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('converts BigInt at the Host bridge JSON boundary without changing internal values', async () => {
    const runtime = await hostWithRemote();
    try {
      await expect(callOwn(runtime, { service: 'wordOfDay', method: 'big', args: [] }))
        .resolves.toEqual({ kind: 'ok', value: { n: 1, nested: [2] } });
      await expect(callOwn(runtime, { service: 'wordOfDay', method: 'echo', args: [{ n: 1n, nested: [2n] }] }))
        .resolves.toEqual({ kind: 'ok', value: { n: 1, nested: [2] } });
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects non-JSON arguments and return values, and keeps CommandError / panic semantics', async () => {
    const runtime = await hostWithRemote();
    try {
      const invalid = await callOwn(runtime, { service: 'wordOfDay', method: 'today', args: [new Map()] });
      expect(invalid.kind).toBe('err');
      expect((invalid as { error: { error_type: string; message: string } }).error).toMatchObject({ error_type: 'Validation' });
      expect((invalid as { error: { message: string } }).error.message).toContain('invalid arguments for plugin:host|call');

      const bad = await callOwn(runtime, { service: 'wordOfDay', method: 'bad', args: [] });
      expect(bad.kind).toBe('err');
      expect((bad as { error: { error_type: string; message: string } }).error).toMatchObject({ error_type: 'Unknown' });
      expect((bad as { error: { message: string } }).error.message).toContain('returned a value that is not plain JSON');

      await expect(callOwn(runtime, { service: 'wordOfDay', method: 'boom', args: [] })).resolves.toEqual({
        kind: 'err',
        error: AppError.validation('boom from plugin'),
      });
      await expect(callOwn(runtime, { service: 'wordOfDay', method: 'crash', args: [] })).resolves.toMatchObject({ kind: 'panic' });
    } finally {
      await runtime.dispose();
    }
  });

  describe('SEC-E06 caller binding', () => {
    async function twoPlugins(hostCallCaller?: HostCallCallerMode): Promise<{ runtime: HostRuntime; warnings: string[]; quoteCalls: () => number }> {
      const runtime = await hostWithRemote(hostCallCaller);
      const warnings: string[] = [];
      runtime.ctx.logger.exporter({ levels: { default: 4 }, export: message => { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
      let quoteCalls = 0;
      await runtime.install(definePlugin({
        meta: { id: 'community.quotes', provides: ['quotes'], remote: { quotes: ['quote'] } },
        apply(ctx) {
          ctx.provide('quotes', { quote: () => { quoteCalls++; return 'quote'; } });
        },
      }));
      return { runtime, warnings, quoteCalls: () => quoteCalls };
    }

    const CALLER_REQUIRED = AppError.validation('plugin:host|call requires "caller", the plugin id of the calling UI half (SEC-E06)');

    it('a caller reaches the meta.remote methods of the services its own plugin provides', async () => {
      const { runtime, warnings } = await twoPlugins();
      try {
        await expect(call(runtime, { caller: 'community.remote', service: 'wordOfDay', method: 'today', args: ['Ada'] }))
          .resolves.toEqual({ kind: 'ok', value: 'today:Ada' });
        await expect(call(runtime, { caller: 'community.quotes', service: 'quotes', method: 'quote', args: [] }))
          .resolves.toEqual({ kind: 'ok', value: 'quote' });
        await expect(call(runtime, { caller: 'community.remote', service: 'wordOfDay', method: 'secret', args: [] })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation('service "wordOfDay" does not expose "secret" to UI (declare it in meta.remote)'),
        });
        expect(warnings).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });

    it('rejects calls into another plugin\'s service, from unknown plugins, and malformed caller ids', async () => {
      const { runtime } = await twoPlugins();
      try {
        await expect(call(runtime, { caller: 'community.remote', service: 'quotes', method: 'quote', args: [] })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation('plugin "community.remote" cannot call service "quotes" of "community.quotes": a UI half may only call its own Host half'),
        });
        await expect(call(runtime, { caller: 'example.ghost', service: 'wordOfDay', method: 'today', args: [] })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation('plugin "example.ghost" cannot call service "wordOfDay" of "community.remote": a UI half may only call its own Host half'),
        });
        for (const caller of ['', 42, null]) {
          await expect(call(runtime, { caller, service: 'wordOfDay', method: 'today', args: [] }), JSON.stringify(caller)).resolves.toEqual({
            kind: 'err',
            error: AppError.validation('plugin:host|call requires "caller" to be a non-empty string when given'),
          });
        }
        await expect(call(runtime, { caller: 'community.remote', service: 'ghost', method: 'today', args: [] })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation('unknown service "ghost"'),
        });
      } finally {
        await runtime.dispose();
      }
    });

    it('the default mode is require: the UI kernel and the mobile diagnostics page send a caller (K2)', async () => {
      expect(DEFAULT_HOST_CALL_CALLER_MODE).toBe('require');
      const runtime = runtimeWith();
      expect(runtime.hostCallCaller).toBe('require');
      await runtime.dispose();
    });

    it('warn mode: without a caller the call is allowed, counted per service, and warns once per service', async () => {
      const { runtime, warnings } = await twoPlugins('warn');
      try {
        expect(runtime.hostCallsWithoutCaller()).toEqual({});
        for (let i = 0; i < 2; i++) {
          await expect(call(runtime, { service: 'wordOfDay', method: 'today', args: ['Ada'] })).resolves.toEqual({ kind: 'ok', value: 'today:Ada' });
          await expect(call(runtime, { service: 'quotes', method: 'quote', args: [] })).resolves.toEqual({ kind: 'ok', value: 'quote' });
        }
        // Calls with a caller and calls to services nobody provides are not counted.
        await call(runtime, { caller: 'community.quotes', service: 'quotes', method: 'quote', args: [] });
        await call(runtime, { service: 'ghost', method: 'today', args: [] });
        expect(runtime.hostCallsWithoutCaller()).toEqual({ wordOfDay: 2, quotes: 2 });
        expect(warnings).toEqual(['wordOfDay', 'quotes'].map(service =>
          `[host] plugin:host|call to service "${service}" carries no "caller" plugin id; cross-plugin calls are not rejected until the UI kernel sends it (SEC-E06)`));
      } finally {
        await runtime.dispose();
      }
    });

    it('require mode: a call without a caller is refused before any service lookup and the service never runs', async () => {
      const { runtime, warnings, quoteCalls } = await twoPlugins('require');
      try {
        expect(runtime.hostCallCaller).toBe('require');
        await expect(call(runtime, { service: 'quotes', method: 'quote', args: [] })).resolves.toEqual({ kind: 'err', error: CALLER_REQUIRED });
        await expect(call(runtime, { service: 'ghost', method: 'today', args: [] })).resolves.toEqual({ kind: 'err', error: CALLER_REQUIRED });
        await expect(call(runtime, { service: 'quotes', method: 'secret', args: [] })).resolves.toEqual({ kind: 'err', error: CALLER_REQUIRED });
        expect(quoteCalls()).toBe(0);
        expect(runtime.hostCallsWithoutCaller()).toEqual({});
        expect(warnings).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });

    it('require mode: the caller binding itself is unchanged', async () => {
      const { runtime, quoteCalls } = await twoPlugins('require');
      try {
        await expect(call(runtime, { caller: 'community.quotes', service: 'quotes', method: 'quote', args: [] })).resolves.toEqual({ kind: 'ok', value: 'quote' });
        await expect(call(runtime, { caller: 'community.remote', service: 'wordOfDay', method: 'today', args: ['Ada'] })).resolves.toEqual({ kind: 'ok', value: 'today:Ada' });
        await expect(call(runtime, { caller: 'community.remote', service: 'quotes', method: 'quote', args: [] })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation('plugin "community.remote" cannot call service "quotes" of "community.quotes": a UI half may only call its own Host half'),
        });
        await expect(call(runtime, { caller: '', service: 'quotes', method: 'quote', args: [] })).resolves.toEqual({
          kind: 'err',
          error: AppError.validation('plugin:host|call requires "caller" to be a non-empty string when given'),
        });
        expect(quoteCalls()).toBe(1);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
