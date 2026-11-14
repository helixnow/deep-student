import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { definePlugin, type WindowRef } from './api.ts';
import { ContractSet } from './contracts.ts';
import { checkCoverage } from './coverage.ts';
import { formatF64, rustDebugString } from './serde.ts';
import greeter from './__fixtures__/greeter.plugin.ts';
import { createTestHost } from './testing.ts';
import { illegalEventName, isEventNameValid } from './events.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const contracts = () => ContractSet.fromDirectory(`${FIXTURES}contracts`);

describe('backend events', () => {
  it('forwards emit/emitTo as BackendEvent and delivers to host listeners', async () => {
    const seen: unknown[] = [];
    const bigSeen: unknown[] = [];
    const listener = definePlugin({
      meta: { id: 'fixture.listener' },
      apply(ctx) {
        ctx.backendEvents.listen('fixture-greeted', (payload) => seen.push(['backend', payload]));
        ctx.backendEvents.listen('fixture-pong', (payload) => seen.push(['pong', payload]));
        ctx.backendEvents.listen('fixture-big', (payload) => bigSeen.push(payload));
      },
    });
    const host = await createTestHost({ plugins: [greeter, listener], contracts: contracts() });
    try {
      await host.invoke('fixture_greet', { name: 'Ada' });
      expect(host.events).toEqual([{ kind: 'event', event: 'fixture-greeted', payload: { name: 'Ada' }, target: { kind: 'Any' } }]);
      // 后端 emit 同步触达 Host 的 Any 监听者。
      expect(seen).toEqual([['backend', { name: 'Ada' }]]);

      const quick: WindowRef = { window: 'quick-assistant', webview: 'quick-assistant' };
      host.emitFrontend('fixture-ping', { n: 1 }, quick);
      expect(host.eventsNamed('fixture-pong')).toEqual([{ payload: { n: 1 }, from: 'quick-assistant' }]);
      // 前端 emit 无载荷 → null（Option<JsonValue>）。
      host.emitFrontend('fixture-ping', undefined);
      expect(host.eventsNamed('fixture-pong').at(-1)).toEqual({ payload: null, from: 'main' });
      expect(seen.filter((s) => (s as unknown[])[0] === 'pong')).toHaveLength(2);

      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, 'fixture-direct', 1);
      expect(host.events.at(-1)).toEqual({ kind: 'event', event: 'fixture-direct', payload: 1, target: { kind: 'Window', label: 'main' } });
      expect(() => host.ctx.backendEvents.emit('bad name', null)).toThrow(illegalEventName('bad name'));
      expect(() => host.ctx.backendEvents.emitTo({ kind: 'Window' } as never, 'x', null)).toThrow(/requires a string label/);
      expect(() => host.ctx.backendEvents.emit('fixture-map', new Map())).toThrow(/not plain JSON/);

      // D3：线上载荷把 BigInt 转成 JSON number；Host 监听者仍拿到内部原值。
      host.ctx.backendEvents.emit('fixture-big', { n: 1n, nested: [2n, 9007199254740993n] });
      expect(host.eventsNamed('fixture-big')).toEqual([{ n: 1, nested: [2, 9007199254740992] }]);
      expect(bigSeen).toEqual([{ n: 1n, nested: [2n, 9007199254740993n] }]);
    } finally {
      await host.dispose();
    }
  });

  it('routes window listeners by EventTarget (not source), including backend broadcast, and disposes idempotently', async () => {
    const main: WindowRef = { window: 'main', webview: 'main' };
    const quick: WindowRef = { window: 'quick-assistant', webview: 'quick-assistant' };
    const seen: { window: string; payload: unknown }[] = [];
    let disposeMain!: () => void;
    let disposeQuick!: () => void;
    const plugin = definePlugin({
      meta: { id: 'fixture.window-listener' },
      apply(ctx) {
        disposeMain = ctx.backendEvents.listenWindow(main, 'fixture-windowed', (payload) => void seen.push({ window: 'main', payload }));
        disposeQuick = ctx.backendEvents.listenWindow(quick, 'fixture-windowed', (payload) => void seen.push({ window: 'quick', payload }));
      },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    try {
      // 后端 `emit` 是广播（target Any）：窗口监听者也会收到，与 Rust manager::emit 一致。
      host.ctx.backendEvents.emit('fixture-windowed', 'broadcast');
      expect(seen).toEqual([
        { window: 'main', payload: 'broadcast' },
        { window: 'quick', payload: 'broadcast' },
      ]);

      // `emitTo(Window{main})` 只命中 main 的窗口订阅。
      seen.length = 0;
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, 'fixture-windowed', 'main-target');
      expect(seen).toEqual([{ window: 'main', payload: 'main-target' }]);

      // AnyLabel 按 label 命中 Window 监听者。
      seen.length = 0;
      host.ctx.backendEvents.emitTo({ kind: 'AnyLabel', label: 'main' }, 'fixture-windowed', 'any-label');
      expect(seen).toEqual([{ window: 'main', payload: 'any-label' }]);

      // 前端 `emit` 从 quick 发出仍是广播：source 不参与接收范围。
      seen.length = 0;
      host.emitFrontend('fixture-windowed', 'frontend-broadcast', quick);
      expect(seen).toEqual([
        { window: 'main', payload: 'frontend-broadcast' },
        { window: 'quick', payload: 'frontend-broadcast' },
      ]);

      // 前端 `emitTo(main)` 即使 source 是 quick，也由 main 的窗口订阅接收。
      seen.length = 0;
      host.emitFrontend('fixture-windowed', 'targeted-main', quick, { kind: 'Window', label: 'main' });
      expect(seen).toEqual([{ window: 'main', payload: 'targeted-main' }]);

      // 目标为 quick 时只命中 quick。
      seen.length = 0;
      host.emitFrontend('fixture-windowed', 'targeted-quick', main, { kind: 'Window', label: 'quick-assistant' });
      expect(seen).toEqual([{ window: 'quick', payload: 'targeted-quick' }]);

      // app-scoped `listen`（target Any）仍收到全部事件，包括定向事件。
      let appCalls = 0;
      host.ctx.backendEvents.listen('fixture-windowed', () => void appCalls++);
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, 'fixture-windowed', 'app-1');
      host.ctx.backendEvents.emitTo({ kind: 'App' }, 'fixture-windowed', 'app-2');
      expect(appCalls).toBe(2);

      // `emitTo(App)` 只命中 App 监听者，不误投窗口监听者。
      seen.length = 0;
      host.ctx.backendEvents.emitTo({ kind: 'App' }, 'fixture-windowed', 'app-only');
      expect(seen).toEqual([]);

      // 注销后不再回调；另一个窗口的订阅不受影响。
      disposeMain();
      disposeMain();
      seen.length = 0;
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, 'fixture-windowed', 'after-dispose');
      expect(seen).toEqual([]);
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'quick-assistant' }, 'fixture-windowed', 'quick-alive');
      expect(seen).toEqual([{ window: 'quick', payload: 'quick-alive' }]);
      disposeQuick();
      seen.length = 0;
      host.ctx.backendEvents.emit('fixture-windowed', 'after-quick-dispose');
      expect(seen).toEqual([]);

      expect(() => host.ctx.backendEvents.listenWindow(null as never, 'x', () => {})).toThrow(/window must be a WindowRef with string window\/webview labels/);
      expect(() => host.ctx.backendEvents.listenWindow(main, 'bad name', () => {})).toThrow(illegalEventName('bad name'));
      expect(() => host.ctx.backendEvents.listenWindow(main, 'fixture-windowed', null as never)).toThrow(/receive must be a function/);
    } finally {
      await host.dispose();
    }
  });

  it('serves the L02 McpFrontendBridge contract through the real backend event path', async () => {
    interface McpFrontendBridge {
      listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void): () => void;
      emit(event: string, payload: unknown): void;
    }
    const main: WindowRef = { window: 'main', webview: 'main' };
    const quick: WindowRef = { window: 'quick-assistant', webview: 'quick-assistant' };
    const host = await createTestHost({ contracts: contracts() });
    try {
      // L02 `createMcpToolsService` 直接把 ctx.backendEvents 当作 bridge 使用。
      const bridge: McpFrontendBridge = host.ctx.backendEvents;
      const received: unknown[] = [];
      const dispose = bridge.listenWindow(main, 'mcp-bridge-tools-response:req-1', (payload) => void received.push(payload));
      bridge.emit('mcp-bridge-tools-request', { correlationId: 'req-1' });
      expect(host.eventsNamed('mcp-bridge-tools-request')).toEqual([{ correlationId: 'req-1' }]);

      // 发往其他窗口的响应不能唤醒目标窗口的等待（按 target 隔离，不按 source）。
      host.emitFrontend('mcp-bridge-tools-response:req-1', { tools: ['quick'] }, quick, { kind: 'Window', label: 'quick-assistant' });
      expect(received).toEqual([]);
      // source 是 quick、target 是 main：窗口订阅按 target 接收。
      host.emitFrontend('mcp-bridge-tools-response:req-1', { tools: ['main'] }, quick, { kind: 'Window', label: 'main' });
      expect(received).toEqual([{ tools: ['main'] }]);

      // 响应/超时后的 finally { dispose() }：不再回调。
      dispose();
      dispose();
      host.emitFrontend('mcp-bridge-tools-response:req-1', { tools: ['late'] }, quick, { kind: 'Window', label: 'main' });
      expect(received).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  });

  it('revokes listeners with the plugin and isolates listener errors', async () => {
    const main: WindowRef = { window: 'main', webview: 'main' };
    let calls = 0;
    let windowCalls = 0;
    const throwing = definePlugin({
      meta: { id: 'fixture.throwing' },
      apply(ctx) {
        ctx.backendEvents.listen('fixture-x', () => {
          throw new Error('listener bug');
        });
      },
    });
    const counting = definePlugin({
      meta: { id: 'fixture.counting' },
      apply(ctx) {
        ctx.backendEvents.listen('fixture-x', () => void calls++);
        ctx.backendEvents.listenWindow(main, 'fixture-x', () => void windowCalls++);
      },
    });
    const host = await createTestHost({ plugins: [throwing, counting], contracts: contracts() });
    host.emitFrontend('fixture-x', 1);
    expect(calls).toBe(1);
    expect(windowCalls).toBe(1);
    await host.unload('fixture.counting');
    host.emitFrontend('fixture-x', 1);
    expect(calls).toBe(1);
    expect(windowCalls).toBe(1);
    await host.dispose();
  });

  it('validates event names like Tauri', () => {
    expect(isEventNameValid('chat_v2_stream_abc-1/x:y')).toBe(true);
    expect(isEventNameValid('事件')).toBe(true);
    expect(isEventNameValid('a b')).toBe(false);
    expect(isEventNameValid('a.b')).toBe(false);
    expect(illegalEventName('a.b')).toBe(`only alphanumeric, '-', '/', ':', '_' permitted for event names: "a.b"`);
  });

  it('dispatches window lifecycle as a Cordis event', async () => {
    const states: string[] = [];
    const plugin = definePlugin({ meta: { id: 'fixture.windows' }, apply: (ctx) => void ctx.on('host/window', (ref, state) => void states.push(`${ref.window}:${state}`)) });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    host.window({ window: 'main', webview: 'main' }, 'focused');
    host.window({ window: 'main', webview: 'main' }, 'close-requested');
    expect(states).toEqual(['main:focused', 'main:close-requested']);
    await host.dispose();
  });
});

describe('protocols', () => {
  it('serves whole and streamed bodies', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    try {
      const whole = await host.protocol('fixturestream', 'fixturestream://localhost/whole');
      expect(whole.status).toBe(200);
      expect(whole.text()).toBe('whole body');
      expect(whole.messages.map((m) => [m.kind, m.final])).toEqual([['protocol-result', true]]);

      const streamed = await host.protocol('fixturestream', 'fixturestream://localhost/chunks?n=3');
      expect(streamed.status).toBe(206);
      expect(streamed.text()).toBe('chunk0;chunk1;chunk2;');
      expect(streamed.messages.map((m) => [m.kind, m.final])).toEqual([
        ['protocol-result', false],
        ['protocol-chunk', false],
        ['protocol-chunk', false],
        ['protocol-chunk', false],
        ['protocol-chunk', true],
      ]);

      const failed = await host.protocol('fixturestream', 'fixturestream://localhost/chunks?n=1&fail');
      expect(failed.text()).toBe('chunk0;');
      expect(failed.error).toBe('disk went away');

      const unknown = await host.protocol('nosuchscheme', 'nosuchscheme://x');
      expect(unknown.status).toBe(404);
    } finally {
      await host.dispose();
    }
  });

  it('answers 500 when a handler throws and rejects duplicate schemes', async () => {
    const bad = definePlugin({
      meta: { id: 'fixture.badproto' },
      apply(ctx) {
        ctx.protocols.register('badproto', () => {
          throw new Error('handler bug');
        });
      },
    });
    const dup = definePlugin({ meta: { id: 'fixture.dupproto' }, apply: (ctx) => ctx.protocols.register('badproto', () => ({ status: 200, headers: {}, body: new Uint8Array() })) });
    const host = await createTestHost({ plugins: [bad], contracts: contracts() });
    const response = await host.protocol('badproto', 'badproto://x');
    expect(response.status).toBe(500);
    expect(response.text()).toBe('handler bug');
    await expect(host.install(dup)).rejects.toThrow(/already registered/);
    await host.unload('fixture.badproto');
    await host.install(dup);
    expect((await host.protocol('badproto', 'badproto://x')).status).toBe(200);
    await host.dispose();
  });
});

describe('shell bridge', () => {
  it('pairs requests and responses by id and times out', async () => {
    const results: unknown[] = [];
    const plugin = definePlugin({
      meta: { id: 'fixture.shell' },
      async apply(ctx) {
        results.push(await ctx.shell.request('window.title', { label: 'main' }));
        results.push(await ctx.shell.request('dialog.open').catch((error: Error) => `${error.name}: ${error.message}`));
      },
    });
    const host = await createTestHost({
      plugins: [plugin],
      contracts: contracts(),
      shell: (op, args) => {
        if (op === 'window.title') return `title of ${(args as { label: string }).label}`;
        throw new Error('user cancelled');
      },
    });
    expect(results).toEqual(['title of main', 'ShellError: user cancelled']);
    expect(host.shellRequests.map((r) => r.op)).toEqual(['window.title', 'dialog.open']);
    await host.dispose();

    const slow = await createTestHost({ contracts: contracts(), shellTimeoutMs: 20, shell: () => new Promise(() => undefined) });
    await expect(slow.ctx.shell.request('never')).rejects.toThrow('shell request "never" timed out after 20ms');
    await slow.dispose();
  });
});

describe('profiles', () => {
  it('loads, overrides by id and isolates a failing plugin from the rest of the profile', async () => {
    const { HostRuntime } = await import('./runtime.ts');
    const { loadProfile, resolveProfile } = await import('./profile.ts');
    const app = { dataDir: '/tmp/unused', version: '0', platform: 'linux' as const, debug: true };

    const base = new HostRuntime({ app, contracts: contracts() });
    await loadProfile(base, `${FIXTURES}e2e.profile.json`);
    await expect(base.dispatchInvoke({ id: '1', cmd: 'fixture_greet', args: { name: 'A' }, source: { window: 'main', webview: 'main' } })).resolves.toEqual({ kind: 'ok', value: 'Hi, A' });
    await base.dispose();

    const entries = await resolveProfile(`${FIXTURES}override.profile.json`);
    expect(entries.map((e) => [e.id, e.specifier.endsWith('greeter-override.plugin.ts')])).toEqual([['fixture.greeter', true]]);
    const overridden = new HostRuntime({ app, contracts: contracts() });
    await loadProfile(overridden, `${FIXTURES}override.profile.json`);
    await expect(overridden.dispatchInvoke({ id: '1', cmd: 'fixture_greet', args: { name: 'A' }, source: { window: 'main', webview: 'main' } })).resolves.toEqual({ kind: 'ok', value: 'Overridden, A' });
    await overridden.dispose();

    const broken = new HostRuntime({ app, contracts: contracts() });
    const result = await loadProfile(broken, `${FIXTURES}broken.profile.json`);
    expect(result.installed.map((entry) => entry.id)).toEqual(['fixture.greeter']);
    expect(result.degraded).toEqual([{ id: 'fixture.broken', reason: 'APPLY_FAILED: broken plugin failed to start' }]);
    expect(broken.plugins().map((entry) => entry.id)).toEqual(['fixture.greeter']);
    expect(broken.commands.has('fixture_greet')).toBe(true);
    expect(broken.commands.has('fixture_unported')).toBe(false);
    // greeter 仍被安装：它注册的协议流保留；broken 在抛错前注册的命令/副作用被撤销。
    expect(broken.protocols.has('fixturestream')).toBe(true);
    await broken.dispose();
  });

  it('rejects malformed profiles and id mismatches', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { resolveProfile, importProfile } = await import('./profile.ts');
    const dir = mkdtempSync(join(tmpdir(), 'dstu-profile-'));
    try {
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ plugins: [{ id: 'x' }] }));
      await expect(resolveProfile(join(dir, 'bad.json'))).rejects.toThrow(/"module" must be a non-empty string/);
      writeFileSync(join(dir, 'cycle-a.json'), JSON.stringify({ extends: './cycle-b.json', plugins: [] }));
      writeFileSync(join(dir, 'cycle-b.json'), JSON.stringify({ extends: './cycle-a.json', plugins: [] }));
      await expect(resolveProfile(join(dir, 'cycle-a.json'))).rejects.toThrow(/extends cycle/);
      writeFileSync(join(dir, 'mismatch.json'), JSON.stringify({ plugins: [{ id: 'other.id', module: `${FIXTURES}greeter.plugin.ts` }] }));
      await expect(importProfile(await resolveProfile(join(dir, 'mismatch.json')))).rejects.toThrow(/exports meta.id "fixture.greeter", expected "other.id"/);
      writeFileSync(join(dir, 'disable.json'), JSON.stringify({ extends: `${FIXTURES}e2e.profile.json`, plugins: [{ id: 'fixture.greeter', disabled: true }] }));
      expect(await resolveProfile(join(dir, 'disable.json'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coverage', () => {
  it('reports unregistered, unknown, duplicate and runtime mismatches', async () => {
    const report = checkCoverage({
      contracts: contracts(),
      plugins: [
        { id: 'a', commands: ['fixture_greet', 'made_up'] },
        { id: 'b', commands: ['fixture_greet', 'fixture_slow'] },
      ],
      registered: [{ command: 'fixture_greet', plugin: 'a' }, { command: 'fixture_unit', plugin: undefined }],
    });
    expect(report.unregistered).toEqual(['fixture_binary', 'fixture_binary_envelope', 'fixture_echo', 'fixture_headers', 'fixture_raw_json', 'fixture_struct', 'fixture_unit', 'fixture_unported']);
    expect(report.unknown).toEqual([{ plugin: 'a', command: 'made_up' }]);
    expect(report.duplicates).toEqual([{ command: 'fixture_greet', plugins: ['a', 'b'] }]);
    expect(report.declaredNotRegistered).toEqual([
      { plugin: 'b', command: 'fixture_greet' },
      { plugin: 'b', command: 'fixture_slow' },
      { plugin: 'a', command: 'made_up' },
    ]);
    expect(report.registeredNotDeclared).toEqual([{ plugin: null, command: 'fixture_unit' }]);

    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    expect(host.coverage()).toMatchObject({ unregistered: ['fixture_raw_json', 'fixture_struct', 'fixture_unported'], unknown: [], declaredNotRegistered: [], registeredNotDeclared: [] });
    await host.dispose();
  });
});

describe('serde text helpers', () => {
  it('formats f64 like zmij', () => {
    expect(formatF64(1.5)).toBe('1.5');
    expect(formatF64(-0.25)).toBe('-0.25');
    expect(formatF64(0.1)).toBe('0.1');
    expect(formatF64(0.00001)).toBe('0.00001');
    expect(formatF64(0.000001)).toBe('1e-6');
    expect(formatF64(1e21)).toBe('1e+21');
    expect(formatF64(1.25e16)).toBe('1.25e+16');
    expect(formatF64(123456.789)).toBe('123456.789');
    expect(formatF64(1e15)).toBe('1000000000000000.0');
  });

  it('escapes strings like Rust Debug', () => {
    expect(rustDebugString('a"b\\c\n\t')).toBe('"a\\"b\\\\c\\n\\t"');
    expect(rustDebugString('中文')).toBe('"中文"');
    expect(rustDebugString('\u0001​')).toBe('"\\u{1}\\u{200b}"');
  });
});

describe('contract compilation', () => {
  it('compiles fixture contracts and reports broken schemas without hanging invokes', async () => {
    expect(contracts().compileAll()).toEqual([]);
    const broken = {
      lane: 'F1-broken',
      generator: 'hand-written fixture',
      events: [],
      $defs: {},
      commands: [{
        name: 'fixture_broken',
        lane: 'F1-broken',
        rust: { file: 'src/fixture.rs', line: 1, fn: 'fixture_broken' },
        async: true,
        args: [{ key: 'x', rustName: 'x', schema: { $ref: '#/$defs/Missing' }, optional: false }],
        injected: [],
        result: { type: 'null' },
        frontend: 'app' as const,
      }],
    };
    const set = new ContractSet([{ file: 'F1-broken.json', contract: broken }]);
    expect(set.compileAll()).toEqual([expect.stringMatching(/schema of arg "x" of command "fixture_broken" does not compile/)]);
    const plugin = definePlugin({ meta: { id: 'fixture.broken-contract', commands: ['fixture_broken'] }, apply: (ctx) => ctx.commands.register('fixture_broken', () => null) });
    const host = await createTestHost({ plugins: [plugin], contracts: set });
    await expect(host.invoke('fixture_broken', { x: 1 })).rejects.toMatch(/^\[dstu-host\] contract F1-broken.json: schema of arg "x"/);
    await host.dispose();
  });
});
