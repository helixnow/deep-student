/**
 * D2 组合根：`serveHost` 在 profile 安装完成后执行 F3 startup finalizer、标记 F2 startupGate，
 * 以及 `frontend-event.target` 经生产 `connection.ts` 路由到 `listenWindow` 监听者。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { serveHost, type HostTransport } from './connection.ts';
import { definePlugin, type WindowRef } from './api.ts';
import { ContractSet } from './contracts.ts';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain, type MainToHostMessage } from './protocol.ts';
import { startupFixtureStates } from './__fixtures__/startup.plugin.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dstu-connection-'));
const SOURCE = { window: 'main', webview: 'main' };
const QUICK = { window: 'quick-assistant', webview: 'quick-assistant' };

afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly messageListeners: ((message: unknown) => void)[] = [];

  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.messageListeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

function handshake(overrides: Partial<Handshake> = {}): Handshake {
  return {
    kind: 'handshake',
    protocol: HOST_PROTOCOL_VERSION,
    appDataDir: DATA_DIR,
    appVersion: '0.0.0-test',
    platform: 'linux',
    debug: true,
    ...overrides,
  };
}

/**
 * Node 应用 manifest 版本来自 package.json，与 Electron/Host 构建入口一致。
 */
function appManifestVersion(): string {
  return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

async function boot(profile: string) {
  const transport = new TestTransport();
  const exits: number[] = [];
  const logs: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const before = startupFixtureStates.length;
  const session = serveHost(transport, {
    profile: `${FIXTURES}${profile}`,
    contracts: () => new ContractSet([]),
    onRuntime: (runtime) => {
      runtime.ctx.logger.exporter({
        export(message) { logs.push(`${message.type} [${message.name}] ${format(...(message.args as unknown[]))}`); },
      });
    },
    exit: (code) => {
      exits.push(code);
      resolveExit(code);
    },
  });
  transport.deliver(handshake());
  const runtime = await session.ready;
  return { transport, session, runtime, exits, exited, logs, state: startupFixtureStates[before]! };
}

describe('startup composition root (D2)', () => {
  it('runs F3 finalizers before marking the F2 gate, and routes frontend targets', async () => {
    const { transport, session, runtime, exits, state } = await boot('startup.profile.json');
    expect(runtime).not.toBeNull();
    expect(transport.sent.some(message => message.kind === 'ready')).toBe(true);
    expect(state).toMatchObject({ recovery: false, finalized: true, gateMarked: true });
    expect(state.finalizerNames).toEqual(['fixture.startup.finalize']);

    // 生产 connection.ts 必须把 FrontendEvent.target 透传给窗口监听者：
    // 广播与 target=main 命中，target=quick 不命中（source 不参与接收范围）。
    transport.deliver({ kind: 'frontend-event', event: 'fixture-targeted', payload: 'broadcast', target: { kind: 'Any' }, source: QUICK });
    transport.deliver({ kind: 'frontend-event', event: 'fixture-targeted', payload: 'main-target', target: { kind: 'Window', label: 'main' }, source: QUICK });
    transport.deliver({ kind: 'frontend-event', event: 'fixture-targeted', payload: 'quick-target', target: { kind: 'Window', label: 'quick-assistant' }, source: SOURCE });
    expect(state.received).toEqual(['broadcast', 'main-target']);

    await session.shutdown();
    expect(exits).toEqual([0]);
  });

  it('skips business finalizers in recovery mode but still marks the gate', async () => {
    const { session, exits, state } = await boot('startup-recovery.profile.json');
    expect(state).toMatchObject({ recovery: true, finalized: false, gateMarked: true });
    expect(state.finalizerNames).toEqual(['fixture.startup.finalize']);
    await session.shutdown();
    expect(exits).toEqual([0]);
  });

  it('fails boot without ready or gate mark when a finalizer throws', async () => {
    const { transport, runtime, exits, exited, logs, state } = await boot('startup-failure.profile.json');
    expect(runtime).toBeNull();
    expect(transport.sent.some(message => message.kind === 'ready')).toBe(false);
    const fatal = transport.sent.find(message => message.kind === 'fatal');
    expect(fatal).toMatchObject({ kind: 'fatal' });
    expect((fatal as { message: string }).message).toContain('fixture startup finalizer failed');
    // HostFatal 只带 message/stack；失败阶段与原始 cause 必须进入 Host 日志，主进程才能在 stderr 展示。
    expect(logs.some(line => line.includes('startup finalization failed at runStartupFinalizers'))).toBe(true);
    expect(logs.some(line => line.includes('fixture startup finalizer failed'))).toBe(true);
    expect(state).toMatchObject({ recovery: false, finalized: false, gateMarked: false });
    await expect(exited).resolves.toBe(1);
    expect(exits).toEqual([1]);
  });
});

describe('page-load-started lifecycle port (WP-074)', () => {
  it('routes PageLoadEvent::Started from the main connection to host/window listeners until unload', async () => {
    const { transport, session, runtime } = await boot('startup.profile.json');
    const seen: [WindowRef, string][] = [];
    await runtime!.install(definePlugin({
      meta: { id: 'fixture.page-load' },
      apply: (ctx) => void ctx.on('host/window', (ref, state) => void seen.push([ref, state])),
    }));
    // 独立 webview（window/webview label 不同）带 main 认证的 origin；Host 原样派发，不合并 label。
    const embedded = { window: 'main', webview: 'reader-1', origin: 'https://example.com' };

    transport.deliver({ kind: 'window', ref: SOURCE, state: 'created' });
    transport.deliver({ kind: 'window', ref: embedded, state: 'page-load-started' });
    transport.deliver({ kind: 'window', ref: SOURCE, state: 'focused' });
    transport.deliver({ kind: 'window', ref: SOURCE, state: 'close-requested' });
    transport.deliver({ kind: 'invoke', id: 'wp074-1', cmd: 'fixture_unregistered', args: {}, source: embedded });
    transport.deliver({ kind: 'window', ref: SOURCE, state: 'page-load-started' });
    transport.deliver({ kind: 'window', ref: SOURCE, state: 'destroyed' });

    expect(seen).toEqual([
      [SOURCE, 'created'],
      [embedded, 'page-load-started'],
      [SOURCE, 'focused'],
      [SOURCE, 'close-requested'],
      [SOURCE, 'page-load-started'],
      [SOURCE, 'destroyed'],
    ]);
    // focus / close-requested / invoke 都不产生页面加载通知。
    expect(seen.filter(([, state]) => state === 'page-load-started').map(([ref]) => ref)).toEqual([embedded, SOURCE]);
    await vi.waitFor(() => expect(transport.sent.some(message => message.kind === 'result' && message.id === 'wp074-1')).toBe(true));

    await runtime!.unload('fixture.page-load');
    transport.deliver({ kind: 'window', ref: embedded, state: 'page-load-started' });
    expect(seen).toHaveLength(6);

    await session.shutdown();
  });
});

describe('app version (F4)', () => {
  it('app_version_is_injected_from_app_manifest', async () => {
    const version = appManifestVersion();
    // 对应 Rust `app_version_is_injected_from_app_manifest`：版本不得为空或成员 crate 的 0.0.0。
    expect(version).not.toBe('');
    expect(version).not.toBe('0.0.0');

    const transport = new TestTransport();
    const session = serveHost(transport, {
      profile: `${FIXTURES}startup.profile.json`,
      contracts: () => new ContractSet([]),
    });
    transport.deliver(handshake({ appVersion: version }));
    const runtime = await session.ready;
    expect(runtime).not.toBeNull();
    // 生产握手路径：manifest 版本经 handshake → ctx.app.version，不回退到 0.0.0/空串。
    expect(runtime!.app.version).toBe(version);
    expect(runtime!.ctx.app.version).toBe(version);
    await session.shutdown();
  });
});
