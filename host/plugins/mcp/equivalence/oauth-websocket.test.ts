import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import mcpPlugin from '../index.ts';
import { browse } from './__fixtures__/oauth-browser.ts';
import { acceptKey, createFrameDecoder, OPCODES, type Frame } from './__fixtures__/websocket.ts';
import { startMcpService, type McpService } from './mcp-service.ts';
import { TOOLS, type FixtureRecord } from './protocol.ts';

const services: McpService[] = [];
const hosts: TestHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const service of services.splice(0)) await service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function service(config: Parameters<typeof startMcpService>[0] = {}): Promise<McpService> {
  const created = await startMcpService(config);
  services.push(created);
  return created;
}

/** Runs the service's `bin/xdg-open` the way the opener would, and waits for it to exit. */
function runBrowser(mcp: McpService, url: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(mcp.browserLaunch().command, [url], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

class MemorySecureStore {
  readonly values = new Map<string, string>();
  async saveSecret(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
}

/** The real mcp plugin; `plugin:opener|open_url` runs the stand-in browser of `mcp` (or does nothing). */
async function hostWith(mcp: McpService | null): Promise<{ host: TestHost; store: MemorySecureStore; opened: string[] }> {
  const opened: string[] = [];
  const store = new MemorySecureStore();
  const host = await createTestHost({
    shell: async (op, args) => {
      if (op !== 'plugin:opener|open_url') throw new Error(`unexpected shell op ${op}`);
      const { url } = args as { url: string };
      opened.push(url);
      if (mcp !== null) expect(await runBrowser(mcp, url)).toBe(0);
      return null;
    },
  });
  hosts.push(host);
  const values = new Map<string, string>();
  host.ctx.provide('settings', {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    getSecret: async (key: string) => values.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { values.set(key, value); },
  });
  host.ctx.provide('secrets', { openStore: () => store });
  host.ctx.provide('llm', {});
  host.ctx.provide('webSearch', {});
  host.ctx.provide('log', { logger: () => ({ warn: () => undefined, error: () => undefined, info: () => undefined }) });
  await host.install(mcpPlugin);
  return { host, store, opened };
}

const methods = (records: FixtureRecord[]): (string | null)[] => records.flatMap(record => (record.kind === 'message' ? [record.method] : []));
const lifecycle = (records: FixtureRecord[]): string[] => records.flatMap(record => (record.kind === 'lifecycle' ? [`${record.event}:${record.reason ?? ''}`] : []));

/** A raw client: handshake by hand, masked frames, so codec edge cases are under the test's control. */
async function rawClient(url: string): Promise<{ socket: Socket; handshake: string; frames: () => Promise<Frame[]>; send: (opcode: number, payload: string, fin?: boolean) => void }> {
  const target = new URL(url);
  const socket = connect(Number(target.port), target.hostname);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const key = Buffer.from('wave0-ws-key-016').toString('base64');
  socket.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const decode = createFrameDecoder();
  let pending = Buffer.alloc(0);
  let handshake: string | null = null;
  const received: Frame[] = [];
  const ready = new Promise<void>(resolve => {
    socket.on('data', (chunk: Buffer) => {
      if (handshake === null) {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        handshake = pending.subarray(0, end).toString('latin1');
        received.push(...decode(pending.subarray(end + 4)));
        resolve();
        return;
      }
      received.push(...decode(chunk));
    });
  });
  await ready;
  const send = (opcode: number, payload: string, fin = true): void => {
    const body = Buffer.from(payload, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(body.map((byte, index) => byte ^ (mask[index & 3] ?? 0)));
    socket.write(Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]), mask, masked]));
  };
  const frames = async (): Promise<Frame[]> => { await new Promise(resolve => { setTimeout(resolve, 50); }); return received.splice(0); };
  if (String(handshake).startsWith('HTTP/1.1 101')) expect(handshake).toContain(`Sec-WebSocket-Accept: ${acceptKey(key)}`);
  return { socket, handshake: handshake ?? '', frames, send };
}

describe('WAVE0 MCP service: WebSocket endpoint', () => {
  it('test_mcp_websocket succeeds against ${mcp.success.wsUrl} and the exchange is recorded under ws1', async () => {
    const mcp = await service();
    const { host } = await hostWith(null);
    const result = await host.invoke<Record<string, unknown>>('test_mcp_websocket', { url: mcp.placeholders()['mcp.success.wsUrl'], env: null });
    expect(result).toMatchObject({ success: true, transport: 'websocket', tools_count: TOOLS.length, server: { name: 'mcp-test-server' } });
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const { network } = mcp.records();
    expect(methods(network)).toEqual(['initialize', 'initialized', 'tools/list', 'prompts/list', 'resources/list']);
    expect(network.every(record => record.transport === 'websocket' && record.session === 'ws1')).toBe(true);
    expect(lifecycle(network)[0]).toBe('stream-open:');
    expect(lifecycle(network)).toHaveLength(2);
  });

  it('initialize-error fails the probe after the JSON-RPC error reply', async () => {
    const mcp = await service();
    const { host } = await hostWith(null);
    const result = await host.invoke<Record<string, unknown>>('test_mcp_websocket', { url: mcp.wsUrl('initialize-error'), env: null });
    expect(result).toMatchObject({ success: false, transport: 'websocket' });
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const [initialize] = mcp.records().network.filter(record => record.kind === 'message');
    expect(initialize).toMatchObject({ method: 'initialize', outcome: 'error' });
  });

  it('answers pings, joins fragments, closes on disconnect scripts and echoes a client close', async () => {
    const mcp = await service();
    const client = await rawClient(mcp.wsUrl('disconnect-on-list'));
    expect(client.handshake.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(client.handshake.toLowerCase()).not.toContain('sec-websocket-extensions');
    client.send(OPCODES.ping, 'hb');
    client.send(OPCODES.text, '{"jsonrpc":"2.0","id":1,', false);
    client.send(OPCODES.continuation, '"method":"ping"}');
    const first = await client.frames();
    expect(first.map(frame => [frame.opcode, frame.payload.toString('utf8')])).toEqual([[OPCODES.pong, 'hb'], [OPCODES.text, '{"jsonrpc":"2.0","id":1,"result":{}}']]);
    expect(first.every(frame => !frame.masked && frame.fin)).toBe(true);
    client.send(OPCODES.text, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    const second = await client.frames();
    expect(second.map(frame => [frame.opcode, frame.payload.readUInt16BE(0)])).toEqual([[OPCODES.close, 1000]]);
    expect(lifecycle(mcp.records().network)).toEqual(['stream-open:', 'stream-close:disconnect-script']);
    client.socket.destroy();

    const other = await rawClient(mcp.wsUrl('success'));
    other.send(OPCODES.close, '\u0003\u00e8');
    expect((await other.frames()).map(frame => frame.opcode)).toEqual([OPCODES.close]);
    expect(lifecycle(mcp.records().network).slice(2)).toEqual(['stream-open:', 'stream-close:client-close-frame']);
    expect(mcp.records().network.filter(record => record.kind === 'lifecycle').map(record => record.session)).toEqual(['ws1', 'ws1', 'ws2', 'ws2']);
    other.socket.destroy();
    expect(await mcp.whenIdle(5_000)).toBe(true);
  });

  it('unknown paths and scripts are refused and recorded; reset closes open sockets and restarts numbering', async () => {
    const mcp = await service();
    for (const path of ['/ws/no-such-script', '/wave0-ws']) {
      const refused = await rawClient(`ws://127.0.0.1:${new URL(mcp.url).port}${path}`);
      expect(refused.handshake.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
      refused.socket.destroy();
    }
    expect(lifecycle(mcp.records().network)).toEqual(['not-found:unknown-script', 'not-found:GET /wave0-ws']);
    await mcp.reset();
    const open = await rawClient(mcp.wsUrl('success'));
    expect(mcp.openCount()).toBe(1);
    expect(await mcp.reset()).toEqual({ closedStreams: 1, liveStdio: [] });
    expect((await open.frames()).map(frame => [frame.opcode, frame.payload.readUInt16BE(0)])).toEqual([[OPCODES.close, 1001]]);
    open.socket.destroy();
    expect(mcp.records().network).toEqual([]);
    const again = await rawClient(mcp.wsUrl('success'));
    again.send(OPCODES.text, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await again.frames();
    expect(mcp.records().network.map(record => record.session)).toEqual(['ws1', 'ws1']);
    again.socket.destroy();
  });
});

describe('WAVE0 MCP service: OAuth authorization server and stand-in browser', () => {
  it('start_mcp_oauth completes through discovery, DCR, the browser redirect and a PKCE-checked token exchange', async () => {
    const mcp = await service();
    const { host, store, opened } = await hostWith(mcp);
    const resourceUrl = String(mcp.placeholders()['mcp.oauth.resourceUrl']);
    expect(new URL(resourceUrl).origin).not.toBe(new URL(mcp.url).origin);
    const outcome = await host.invoke<Record<string, unknown>>('start_mcp_oauth', {
      serverId: 'wave0-oauth', resourceUrl, clientId: null, clientSecret: null, scopes: ['mcp:tools'],
    });
    expect(outcome).toMatchObject({ server_id: 'wave0-oauth', expires_at: null });
    expect(opened).toEqual([outcome.authorization_url]);
    expect(await host.invoke('get_mcp_oauth_status', { serverId: 'wave0-oauth', resourceUrl })).toEqual({ server_id: 'wave0-oauth', authorized: true });
    expect(await host.invoke('get_mcp_oauth_access_token', { serverId: 'wave0-oauth', resourceUrl })).toBe('wave0-access-1');
    expect(await host.invoke('get_mcp_oauth_access_token', { serverId: 'wave0-oauth', resourceUrl: `${mcp.url}/mcp/other-origin` })).toBeNull();
    expect(store.values.size).toBe(1);

    const { oauth, browser } = mcp.records();
    expect(oauth.map(record => [record.endpoint, record.status, record.outcome])).toEqual([
      ['not-found', 404, 'not-found'], ['not-found', 404, 'not-found'], ['metadata', 200, 'metadata'],
      ['register', 201, 'registered'], ['authorize', 302, 'code'], ['token', 200, 'token'],
    ]);
    expect(oauth.slice(0, 3).map(record => record.path)).toEqual([
      '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/dcr/mcp/.well-known/oauth-authorization-server',
    ]);
    expect(JSON.parse(oauth[3]?.response ?? '{}')).toMatchObject({ client_id: 'wave0-dcr-1', redirect_uris: [outcome.redirect_uri] });
    expect(browser.map(record => [record.outcome, record.status])).toEqual([['fetched', 302], ['fetched', 200]]);
    expect(browser[1]?.url.startsWith(`${String(outcome.redirect_uri)}?code=wave0-code-1&state=`)).toBe(true);
  });

  it('the no-registration profile rejects before any browser opens; a pre-set client_id is not auto-approved', async () => {
    const mcp = await service();
    const { host, opened } = await hostWith(mcp);
    await expect(host.invoke('start_mcp_oauth', {
      serverId: 'wave0-oauth', resourceUrl: mcp.placeholders()['mcp.oauth.noRegistrationResourceUrl'], clientId: null, clientSecret: null, scopes: null,
    })).rejects.toThrow(/no registration_endpoint/);
    expect(opened).toEqual([]);
    const metadata = mcp.records().oauth.find(record => record.endpoint === 'metadata');
    expect(JSON.parse(metadata?.response ?? '{}')).not.toHaveProperty('registration_endpoint');

    const authorize = await fetch(`${mcp.oauthUrl}/dcr/oauth/authorize?response_type=code&client_id=wave0-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fauth%2Fcallback&state=s&code_challenge=c&code_challenge_method=S256`, { redirect: 'manual' });
    expect(authorize.status).toBe(400);
    expect(authorize.headers.get('location')).toBeNull();
  });

  it('token endpoint enforces the code, client, redirect_uri and PKCE verifier; codes are single use', async () => {
    const mcp = await service();
    const as = `${mcp.oauthUrl}/dcr/oauth`;
    const redirect = 'http://127.0.0.1:9/auth/callback';
    const registered = await (await fetch(`${as}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json() as { client_id: string };
    const verifier = 'wave0-verifier-0123456789-0123456789-0123456789';
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    const authorize = await fetch(`${as}/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, state: 'st', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const token = (fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${as}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString(),
    });
    const base = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: registered.client_id };
    expect(await (await token({ ...base, code_verifier: 'wrong' })).json()).toMatchObject({ error: 'invalid_grant' });
    const authorize2 = await fetch(`${as}/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, state: 'st', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    const code2 = new URL(authorize2.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const basic = { authorization: `Basic ${Buffer.from(`${registered.client_id}:`).toString('base64')}` };
    const ok = await token({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, code_verifier: verifier }, basic);
    expect(ok.headers.get('content-type')).toBe('application/json');
    expect(await ok.json()).toEqual({ access_token: 'wave0-access-1', token_type: 'Bearer', refresh_token: 'wave0-refresh-1' });
    expect(await (await token({ ...base, code: code2, code_verifier: verifier })).json()).toMatchObject({ error: 'invalid_grant' });
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: 'wave0-refresh-1', client_id: registered.client_id });
    expect(await refreshed.json()).toMatchObject({ access_token: 'wave0-access-2' });
    expect(mcp.records().oauth.map(record => record.outcome)).toEqual(['registered', 'code', 'invalid_grant', 'code', 'token', 'invalid_grant', 'refreshed']);
  });

  it('the stand-in browser only visits http loopback URLs and exits 0', async () => {
    expect(await browse('https://example.com/authorize')).toEqual([expect.objectContaining({ outcome: 'refused', status: null })]);
    expect(await browse('http://user:pw@127.0.0.1:9/x')).toEqual([expect.objectContaining({ outcome: 'refused' })]);
    const mcp = await service();
    expect(statSync(mcp.browserLaunch().command).mode & 0o111).not.toBe(0);
    expect(await runBrowser(mcp, 'http://example.invalid/authorize')).toBe(0);
    expect(mcp.records().browser).toEqual([expect.objectContaining({ url: 'http://example.invalid/authorize', outcome: 'refused' })]);
  });

  it('fixed port, logDir and node give run-independent oauth and wsUrl placeholders on port + 1', async () => {
    const logDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-g3-oauth-')));
    dirs.push(logDir);
    // port + 1 may be held by another socket (on Linux it is even, i.e. in the connect() pool): probe a new port instead of skipping.
    let port = 0;
    let second: McpService | null = null;
    for (let attempt = 0; second === null && attempt < 5; attempt += 1) {
      const first = await service({ logDir, selfContained: true });
      port = Number(new URL(first.url).port);
      await first.stop();
      second = await service({ logDir, port, selfContained: true }).catch((e: unknown) => {
        if ((e as { code?: unknown }).code === 'EADDRINUSE') return null;
        throw e;
      });
    }
    if (second === null) throw new Error(`port + 1 was taken on 5 probed ports (last ${port + 1})`);
    const placeholders = second.placeholders();
    expect(placeholders['mcp.oauth.url']).toBe(`http://127.0.0.1:${port + 1}`);
    expect(placeholders['mcp.oauth.resourceUrl']).toBe(`http://127.0.0.1:${port + 1}/dcr/mcp`);
    expect(placeholders['mcp.oauth.noRegistrationResourceUrl']).toBe(`http://127.0.0.1:${port + 1}/no-registration/mcp`);
    expect(placeholders['mcp.success.wsUrl']).toBe(`ws://127.0.0.1:${port}/ws/success`);
    expect(second.browserLaunch()).toEqual({ pathDir: join(logDir, 'bin'), command: join(logDir, 'bin', 'xdg-open'), logFile: join(logDir, 'browser-records.jsonl') });
    await second.stop();
    const third = await service({ logDir, port, selfContained: true });
    expect(third.placeholders()).toEqual(placeholders);
    expect(third.bindings()).toMatchObject({ oauth: { resourceUrl: placeholders['mcp.oauth.resourceUrl'] }, success: { wsUrl: placeholders['mcp.success.wsUrl'] } });
  });
});
