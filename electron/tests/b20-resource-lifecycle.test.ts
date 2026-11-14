import { fstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BuiltinAcl } from '../shell/capabilities.ts';
import type { InvokeMessage } from '../shell/bridge-messages.ts';
import { PathResolver } from '../shell/paths.ts';
import { fsPlugin } from '../shell/plugins/fs.ts';
import { httpPlugin } from '../shell/plugins/http.ts';
import { ShellRuntime, type CommandContext } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';
import type { ShellWindow } from '../shell/windows.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(acl = new BuiltinAcl([], 'linux')) {
  const root = mkdtempSync('/tmp/opencode/b20-resources-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new ShellRuntime({
    platform: 'linux', debug: false,
    config: {
      productName: 'B20', version: '0.0.0', identifier: 'b20', devUrl: '', frontendDist: '', windows: [],
      assetScope: { allow: [], deny: [] }, assetProtocolEnabled: false, csp: null, macOSPrivateApi: false,
    },
    paths: new PathResolver({ platform: 'linux', env: {}, fallbackHome: root, identifier: 'b20', tempDir: root, resourceDir: null }),
    assetScope: new FsScope({ platform: 'linux' }),
    fsScope: new FsScope({ platform: 'linux' }),
    appVersion: '0.0.0', localOrigin: 'http://localhost', log: () => undefined,
    acl,
  });
  runtime.host = { abandonWebview: vi.fn() } as unknown as typeof runtime.host;
  runtime.windows = { get: () => undefined } as unknown as typeof runtime.windows;
  cleanups.push(() => runtime.webviewGone('main', 'window-closed'));
  const ctx: CommandContext = { runtime, windowLabel: 'main', webviewLabel: 'main', scope: () => ({ allow: [{ url: 'http://127.0.0.1:*/*' }], deny: [] }) };
  return { runtime, root, ctx };
}

function input(command: string, json: unknown) {
  return { command, json, raw: null, headers: {} };
}

it('reload closes real fs plugin handles without closing another webview', () => {
  const { runtime, root, ctx } = harness();
  runtime.fsScope.allowDirectory(root, true);
  const plugin = fsPlugin({ global: runtime.fsScope, runtime: runtime.fsScope });
  const path = join(root, 'fixture.txt');
  writeFileSync(path, 'hello');
  const rid = plugin.open!(input('open', { path }), ctx) as number;
  const resource = runtime.getResource('main', rid, (r): r is typeof r & { fd: number } => 'fd' in r);
  const fd = resource.fd;
  expect(fstatSync(fd).isFile()).toBe(true);
  const otherClose = vi.fn();
  const otherRid = runtime.addResource('other', { close: otherClose });
  cleanups.push(() => runtime.webviewGone('other', 'window-closed'));

  runtime.webviewGone('main', 'reloaded');

  expect(() => fstatSync(fd)).toThrow(/EBADF/);
  expect(() => runtime.getResource('main', rid, (r): r is typeof r => true)).toThrow('invalid');
  expect(runtime.getResource('other', otherRid, (r): r is typeof r => true)).toBeDefined();
  expect(otherClose).not.toHaveBeenCalled();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it('reload cancels an unread HTTP response and closes its live upstream connection', async () => {
  const { runtime, ctx } = harness();
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const url = await listen(createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: hello\n\n');
    res.on('close', disconnected);
  }));
  const plugin = httpPlugin({ allow: ['http://127.0.0.1:*/*'], deny: [] });
  const rid = plugin.fetch!(input('fetch', { clientConfig: { method: 'GET', url, headers: [] } }), ctx) as number;
  const response = await plugin.fetch_send!(input('fetch_send', { rid }), ctx) as { rid: number };
  runtime.webviewGone('main', 'reloaded');
  await expect(Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))])).resolves.toBe(true);
  expect(() => runtime.getResource('main', response.rid, (r): r is typeof r => true)).toThrow('invalid');
});

it('a response resolving during reload cannot recreate resources for the departed page', async () => {
  const { runtime, ctx } = harness();
  const plugin = httpPlugin({ allow: [], deny: [] });
  const rid = plugin.fetch!(input('fetch', { clientConfig: { method: 'GET', url: 'data:text/plain,hello', headers: [] } }), ctx) as number;
  // fetch_send awaits run(); navigation can discard the resource table before that continuation.
  const response = plugin.fetch_send!(input('fetch_send', { rid }), ctx);
  runtime.webviewGone('main', 'reloaded');
  await expect(response).rejects.toThrow('Request canceled');
});

it('independent application webviews retain the parent window and trusted origin with isolated replies', () => {
  const { runtime } = harness();
  const invoke = vi.fn();
  runtime.host.invoke = invoke;
  const send = vi.spyOn(runtime, 'sendToWebview').mockImplementation(() => undefined);
  const win = { label: 'main' } as ShellWindow;
  const message: InvokeMessage = {
    type: 'invoke', cmd: 'b20_probe', callback: 1, error: 2,
    payload: { contentType: 'application/json', data: '{}' }, headers: {},
  };
  runtime.handleWebviewInvoke(win, 'tab-a', message, 'http://localhost/path');
  expect(invoke.mock.calls[0]![0].source).toEqual({ window: 'main', webview: 'tab-a' });
  invoke.mock.calls[0]![1].resolve({ ok: true, value: 'a' });
  expect(send).toHaveBeenLastCalledWith('tab-a', expect.objectContaining({ callbackId: 1 }));

  runtime.handleWebviewInvoke(win, 'tab-b', message, 'https://remote.example/path');
  expect(invoke.mock.calls[1]![0].source).toEqual({ window: 'main', webview: 'tab-b', origin: 'https://remote.example' });
  invoke.mock.calls[1]![1].resolve({ ok: true, value: 'b' });
  expect(send).toHaveBeenLastCalledWith('tab-b', expect.objectContaining({ callbackId: 1 }));

  runtime.handleInvoke(win, message, 'http://localhost/path');
  expect(invoke.mock.calls[2]![0].source).toEqual({ window: 'main', webview: 'main' });

  runtime.handleWebviewInvoke(win, 'tab-c', message, 'http://localhost/path', 'main');
  expect(invoke.mock.calls[3]![0].source).toEqual({ window: 'main', webview: 'main' });
  expect(invoke.mock.calls[3]![1].webview).toBe('tab-c');
  invoke.mock.calls[3]![1].resolve({ ok: true, value: 'c' });
  expect(send).toHaveBeenLastCalledWith('tab-c', expect.objectContaining({ callbackId: 1 }));
});

it('a tab can retain main-only capabilities without sharing its resource identity or trusting remote origins', async () => {
  const acl = new BuiltinAcl([{
    identifier: 'b20-main', description: '', local: true, remote: null, windows: [], webviews: ['main'],
    permissions: ['probe:default'], platforms: null,
  }], 'linux', {
    probe: { commands: ['identity'], default: ['allow-identity'], sets: {}, permissions: {} },
  });
  const { runtime } = harness(acl);
  const handler = vi.fn((_input, ctx: CommandContext) => ({ window: ctx.windowLabel, webview: ctx.webviewLabel }));
  runtime.registerPlugin('probe', { identity: handler });
  const send = vi.spyOn(runtime, 'sendToWebview').mockImplementation(() => undefined);
  const message: InvokeMessage = {
    type: 'invoke', cmd: 'plugin:probe|identity', callback: 1, error: 2,
    payload: { contentType: 'application/json', data: '{}' }, headers: {},
  };
  runtime.handleWebviewInvoke({ label: 'main' } as ShellWindow, 'tab-a', message, 'http://localhost/', 'main');
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('tab-a', expect.objectContaining({
    callbackId: 1, body: { kind: 'json', data: '{"window":"main","webview":"tab-a"}' },
  })));
  expect(handler).toHaveBeenCalledTimes(1);
  runtime.handleWebviewInvoke({ label: 'main' } as ShellWindow, 'tab-b', message, 'https://remote.example/', 'main');
  expect(send).toHaveBeenLastCalledWith('tab-b', expect.objectContaining({ callbackId: 2 }));
  expect(handler).toHaveBeenCalledTimes(1);
});

it('HTTP from an independent webview uses the owning window origin', async () => {
  const { runtime, ctx } = harness();
  ctx.runtime.windows = {
    get: (label: string) => label === 'main' ? { webContents: { getURL: () => 'http://localhost/' } } : undefined,
  } as unknown as typeof runtime.windows;
  let origin: string | undefined;
  const url = await listen(createServer((req, res) => { origin = req.headers.origin; res.end('ok'); }));
  const tabCtx = { ...ctx, webviewLabel: 'tab-a' };
  cleanups.push(() => runtime.webviewGone('tab-a', 'window-closed'));
  const plugin = httpPlugin({ allow: ['http://127.0.0.1:*/*'], deny: [] });
  const rid = plugin.fetch!(input('fetch', { clientConfig: { method: 'GET', url, headers: [] } }), tabCtx) as number;
  await plugin.fetch_send!(input('fetch_send', { rid }), tabCtx);
  expect(origin).toBe('http://localhost');
});
