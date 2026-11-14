/**
 * SEC-E05 Host 侧：main 给自己产生的 browser-content 原生回调加 `FrontendEvent.native: true`
 * （`electron/shell/browser-content-events.ts` 的 `nativeBrowserContentEvent`），kernel 以监听者 `source.native`
 * 交给插件；页面经 `plugin:event|emit` 转来的同名事件不带，`source` 里自带的 `native` 不算数。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, type WindowRef } from '../api.ts';
import { serveHost, type HostTransport } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import { HOST_PROTOCOL_VERSION, type FrontendEvent, type HostToMain, type MainToHostMessage } from '../protocol.ts';
import { createTestHost, type TestHost } from '../testing.ts';

const PAGE_FINISHED = 'dstu-browser://page-finished';
const CONTENT: WindowRef = { window: 'main', webview: 'browser-content' };

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: unknown): void { for (const listener of this.listeners) listener(message); }
}

function recorder(seen: WindowRef[]) {
  return definePlugin({
    meta: { id: 'fixture.native-listener' },
    apply(ctx) {
      ctx.backendEvents.listen(PAGE_FINISHED, (_payload, source) => seen.push(source));
    },
  });
}

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

describe('SEC-E05 FrontendEvent.native reaches Host listeners as source.native', () => {
  it('over the real transport: only the message-level native: true marks the source', async () => {
    const seen: WindowRef[] = [];
    const transport = new TestTransport();
    const session = serveHost(transport, {
      installs: async () => [{ plugin: recorder(seen), source: 'static:recorder' }],
      contracts: () => new ContractSet([]),
    });
    transport.deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: '/opfs/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: true } satisfies MainToHostMessage);
    expect(await session.ready).not.toBeNull();

    const event = (extra: Record<string, unknown>, source: Record<string, unknown> = { ...CONTENT }) =>
      ({ kind: 'frontend-event', event: PAGE_FINISHED, payload: { url: 'https://example.org/' }, target: { kind: 'App' }, source, ...extra });
    // The shape main's nativeBrowserContentEvent produces.
    const native: FrontendEvent = { kind: 'frontend-event', event: PAGE_FINISHED, payload: { url: 'https://example.org/' }, target: { kind: 'App' }, source: { ...CONTENT }, native: true };
    transport.deliver(native);
    // A page-originated emit (plugin:event|emit) never carries the flag.
    transport.deliver(event({}));
    // A native claim inside source, or a non-true flag, does not count.
    transport.deliver(event({}, { ...CONTENT, native: true }));
    transport.deliver(event({ native: 'true' }));
    transport.deliver(event({ native: 1 }));

    expect(seen).toEqual([{ ...CONTENT, native: true }, CONTENT, CONTENT, CONTENT, CONTENT]);
    expect(seen.slice(1).every(source => !('native' in source))).toBe(true);
    await session.shutdown();
  });

  it('a remote origin on the source is kept next to the native flag', async () => {
    const seen: WindowRef[] = [];
    const host = await createTestHost({ contracts: ContractSet.empty(), plugins: [recorder(seen)] });
    hosts.push(host);
    const remote: WindowRef = { ...CONTENT, origin: 'https://example.org' };
    host.emitNative(PAGE_FINISHED, { url: 'https://example.org/' }, remote);
    host.emitFrontend(PAGE_FINISHED, { url: 'https://example.org/' }, { ...remote, native: true });
    expect(seen).toEqual([{ ...remote, native: true }, remote]);
  });

  it('the flag changes neither target filtering nor backend emits', async () => {
    const backend: WindowRef[] = [];
    const any: unknown[] = [];
    const windowed: unknown[] = [];
    const host = await createTestHost({
      contracts: ContractSet.empty(),
      plugins: [definePlugin({
        meta: { id: 'fixture.native-window-listener' },
        apply(ctx) {
          ctx.backendEvents.listen('fixture-backend', (_payload, source) => backend.push(source));
          ctx.backendEvents.listen(PAGE_FINISHED, payload => any.push(payload));
          ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, PAGE_FINISHED, payload => windowed.push(payload));
        },
      })],
    });
    hosts.push(host);
    host.ctx.backendEvents.emit('fixture-backend', 1);
    // App-targeted, native or not: Any listeners receive it, Window listeners do not (Tauri match_any_or_filter).
    host.emitNative(PAGE_FINISHED, 'native', CONTENT);
    host.emitFrontend(PAGE_FINISHED, 'page', CONTENT, { kind: 'App' });
    expect(backend).toEqual([{ window: '', webview: '' }]);
    expect(any).toEqual(['native', 'page']);
    expect(windowed).toEqual([]);
  });
});
