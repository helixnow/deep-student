import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { SecureStore } from '../../../platform/secrets/api.ts';
import { McpOAuthManager, type OAuthRuntime, type StartOAuthParams } from '../src/oauth-manager.ts';
import mcp from '../index.ts';

const STILL_PENDING = 'still pending';
const SETTLE_BOUND_MS = 1500;

function listeningServers(): number {
  return process.getActiveResourcesInfo().filter(resource => resource === 'TCPServerWrap').length;
}

/** libuv drops a closed server handle in the close phase; the next timer runs after it. */
function nextLoopTurn(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0); });
}

function within<T>(promise: Promise<T>): Promise<T | typeof STILL_PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof STILL_PENDING>(resolve => { setTimeout(() => resolve(STILL_PENDING), SETTLE_BOUND_MS); }),
  ]);
}

function settledValue(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(value => ({ resolved: value }), (error: unknown) => error instanceof Error ? error.message : error);
}

class MemorySecureStore {
  readonly secureDir = '/memory/.secure';
  readonly enabled = true;
  readonly values = new Map<string, string>();
  async saveSecret(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function managerRuntime(fetchImpl: typeof fetch, openUrl: (url: string) => Promise<void> = async () => undefined): OAuthRuntime {
  return {
    fetch: fetchImpl,
    openUrl,
    secureStore: new MemorySecureStore() as unknown as SecureStore,
    now: () => new Date(),
  };
}

function startParams(overrides: Partial<StartOAuthParams> = {}): StartOAuthParams {
  return {
    serverId: 'srv', resourceUrl: 'https://as.test/mcp', clientId: null, clientSecret: null,
    scopes: [], openBrowser: true, ...overrides,
  };
}

const offline = (async () => { throw new Error('offline'); }) as typeof fetch;

describe('V09-P1-4 McpOAuthManager releases the OAuth callback listener', () => {
  it('V09-P1-4: three failed startOAuth calls leave no extra TCPServerWrap behind', async () => {
    const metadataWithoutRegistration = (async () => jsonResponse({
      authorization_endpoint: 'https://as.test/authorize', token_endpoint: 'https://as.test/token',
    })) as typeof fetch;
    const failures: [string, McpOAuthManager, RegExp][] = [
      ['DCR request fails (offline fetch)', new McpOAuthManager(managerRuntime(offline)), /^offline$/u],
      ['no client_id and no registration_endpoint',
        new McpOAuthManager(managerRuntime(metadataWithoutRegistration)), /no registration_endpoint/u],
      ['system browser cannot be opened',
        new McpOAuthManager(managerRuntime(offline, async () => { throw new Error('no opener'); })),
        /Failed to open system browser: no opener/u],
    ];
    const before = listeningServers();
    for (const [label, manager, message] of failures) {
      const params = label === 'system browser cannot be opened' ? startParams({ clientId: 'client-1' }) : startParams();
      await expect(manager.startOAuth(params), label).rejects.toThrow(message);
    }
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
  });

  it('V09-P1-4: dispose() cancels an authorization waiting for its callback and closes the port', async () => {
    let opened: (url: string) => void = () => undefined;
    const browserOpened = new Promise<string>(resolve => { opened = resolve; });
    const manager = new McpOAuthManager(managerRuntime(offline, async url => { opened(url); }));
    const before = listeningServers();
    const flow = settledValue(manager.startOAuth(startParams({ clientId: 'client-1' })));
    await browserOpened;
    expect(listeningServers()).toBe(before + 1);
    manager.dispose();
    expect(await within(flow)).toBe('OAuth authorization cancelled');
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
    await expect(manager.startOAuth(startParams({ clientId: 'client-1' }))).rejects.toThrow('OAuth authorization cancelled');
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
  });
});

describe('V09-P1-1 McpOAuthManager.startOAuth honours an abort signal', () => {
  it('V09-P1-1: aborting while waiting for the browser callback ends the flow as cancelled at once', async () => {
    let opened: (url: string) => void = () => undefined;
    const browserOpened = new Promise<string>(resolve => { opened = resolve; });
    const manager = new McpOAuthManager(managerRuntime(offline, async url => { opened(url); }));
    const controller = new AbortController();
    const before = listeningServers();
    const flow = settledValue(manager.startOAuth(startParams({ clientId: 'client-1' }), { signal: controller.signal }));
    await browserOpened;
    controller.abort(new Error('plugin stopping'));
    expect(await within(flow)).toBe('OAuth authorization cancelled');
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
  });

  it('V09-P1-1: aborting while discovery HTTP is in flight does not wait for the 10s request timeout', async () => {
    let discoveryStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      discoveryStarted();
      init?.signal?.addEventListener('abort', () => { reject(init.signal!.reason); }, { once: true });
    })) as typeof fetch;
    const manager = new McpOAuthManager(managerRuntime(hanging));
    const controller = new AbortController();
    const before = listeningServers();
    const flow = settledValue(manager.startOAuth(startParams({ clientId: 'client-1' }), { signal: controller.signal }));
    await started;
    controller.abort(new Error('plugin stopping'));
    expect(await within(flow)).toBe('OAuth authorization cancelled');
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
  });
});

interface FakeAuthorizationServer {
  server: Server;
  resourceUrl: string;
  tokenRequests: number;
}

async function startFakeAuthorizationServer(): Promise<FakeAuthorizationServer> {
  const state: FakeAuthorizationServer = { server: createServer(), resourceUrl: '', tokenRequests: 0 };
  state.server.on('request', (request, response) => {
    if (request.method === 'POST' && request.url === '/oauth/token') {
      state.tokenRequests += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'token-after-reload', token_type: 'Bearer', expires_in: 3600 }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => { state.server.listen(0, '127.0.0.1', resolve); });
  const address = state.server.address();
  if (address === null || typeof address === 'string') throw new Error('fake AS has no port');
  state.resourceUrl = `http://127.0.0.1:${address.port}/mcp`;
  return state;
}

const hosts: TestHost[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); });
  await nextLoopTurn();
});

async function setupHost(opened: string[], store: MemorySecureStore): Promise<TestHost> {
  const host = await createTestHost({
    plugins: [mcp],
    provide: {
      settings: { get: () => null, save: () => undefined },
      secrets: { openStore: () => store },
      log: { logger: () => undefined },
      webSearch: { doSearch: async () => ({ name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [] }) },
    },
    shell: (op, args) => {
      if (op !== 'plugin:opener|open_url') throw new Error(`unexpected shell op ${op}`);
      opened.push((args as { url: string }).url);
      return null;
    },
  });
  hosts.push(host);
  return host;
}

describe('V09-P1-1 / V09-P1-4 start_mcp_oauth through the real mcp plugin', () => {
  it('V09-P1-1: unloading dstu.mcp cancels an in-flight start_mcp_oauth at once and releases its port', async () => {
    const as = await startFakeAuthorizationServer();
    servers.push(as.server);
    const opened: string[] = [];
    const host = await setupHost(opened, new MemorySecureStore());
    const before = listeningServers();
    const pending = host.startInvoke('start_mcp_oauth', { serverId: 'srv', resourceUrl: as.resourceUrl, clientId: 'client-1' });
    const outcome = settledValue(pending.result);
    await vi.waitFor(() => { expect(opened).toHaveLength(1); });
    expect(listeningServers()).toBe(before + 1);

    const unloaded = host.unload('dstu.mcp').then(() => 'unloaded');
    expect(await within(outcome)).toBe('OAuth authorization cancelled');
    expect(await within(unloaded)).toBe('unloaded');
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
    expect(as.tokenRequests).toBe(0);
  });

  it('V09-P1-1: a page reload only detaches the reply; the authorization keeps running and persists like Rust', async () => {
    const as = await startFakeAuthorizationServer();
    servers.push(as.server);
    const opened: string[] = [];
    const store = new MemorySecureStore();
    const host = await setupHost(opened, store);
    const before = listeningServers();
    const pending = host.startInvoke('start_mcp_oauth', { serverId: 'srv', resourceUrl: as.resourceUrl, clientId: 'client-1' });
    const outcome = settledValue(pending.result);
    await vi.waitFor(() => { expect(opened).toHaveLength(1); });

    pending.abandon('reloaded');
    expect(await within(outcome)).toBe('OAuth authorization continues after the caller abandoned the invoke (reloaded)');
    expect(listeningServers()).toBe(before + 1);

    const authorization = new URL(opened[0]!);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'code-after-reload');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
    await vi.waitFor(() => { expect(store.values.has('internal.oauth.mcp.srv')).toBe(true); });
    expect(await host.invoke('get_mcp_oauth_status', { serverId: 'srv', resourceUrl: as.resourceUrl }))
      .toEqual({ server_id: 'srv', authorized: true });
    expect(as.tokenRequests).toBe(1);
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
  });

  it('V09-P1-4: unloading dstu.mcp stops an authorization that kept running after a page reload', async () => {
    const as = await startFakeAuthorizationServer();
    servers.push(as.server);
    const opened: string[] = [];
    const host = await setupHost(opened, new MemorySecureStore());
    const before = listeningServers();
    const pending = host.startInvoke('start_mcp_oauth', { serverId: 'srv', resourceUrl: as.resourceUrl, clientId: 'client-1' });
    const outcome = settledValue(pending.result);
    await vi.waitFor(() => { expect(opened).toHaveLength(1); }, { timeout: 5000 });

    // The reply is detached, so the kernel no longer aborts this call on unload: only the plugin's dispose effect can stop it.
    pending.abandon('reloaded');
    expect(await within(outcome)).toBe('OAuth authorization continues after the caller abandoned the invoke (reloaded)');
    expect(listeningServers()).toBe(before + 1);

    expect(await within(host.unload('dstu.mcp').then(() => 'unloaded'))).toBe('unloaded');
    await nextLoopTurn();
    expect(listeningServers()).toBe(before);
    expect(as.tokenRequests).toBe(0);
  });
});
