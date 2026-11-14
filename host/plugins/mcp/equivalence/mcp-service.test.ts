import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { defaultToolConfig, doSearch, type SearchInput } from '../api.ts';
import mcpPlugin from '../index.ts';
import { defaultMcpConfig } from '../src/config.ts';
import { createTransportForConfig, JsonRpcProbe } from '../src/probe.ts';
import { startMcpService, type McpService } from './mcp-service.ts';
import { FAIL_TEXTS, GARBAGE_TEXT, SCRIPT_IDS, TOOLS, type FixtureRecord, type MessageRecord, type ScriptId } from './protocol.ts';
import { currentStdioRuntime, resolveStdioRuntime } from './runtime.ts';

const services: McpService[] = [];
const hosts: TestHost[] = [];
const logDirs: string[] = [];
let readerEnds = 0;
const errorLogs: string[] = [];
afterEach(async () => {
  // Children left by B after a failed probe are ended, and both plugin readers have logged their
  // termination (stdio-proxy.ts:217/251), before the host is disposed.
  let started = 0;
  for (const service of services) {
    for (const pid of service.liveStdio()) process.kill(pid, 'SIGTERM');
    await service.whenIdle(10_000);
    started += service.records().stdio.filter(record => record.kind === 'lifecycle' && record.event === 'start').length;
  }
  await vi.waitFor(() => { expect(readerEnds).toBeGreaterThanOrEqual(2 * started); }, { timeout: 10_000 });
  readerEnds = 0;
  errorLogs.length = 0;
  for (const host of hosts.splice(0)) await host.dispose();
  for (const service of services.splice(0)) await service.stop();
  for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function service(): Promise<McpService> {
  const created = await startMcpService();
  services.push(created);
  return created;
}

async function hostWith(toolsList: unknown[]): Promise<TestHost> {
  const host = await createTestHost();
  hosts.push(host);
  const values = new Map<string, string>([['mcp.tools.list', JSON.stringify(toolsList)]]);
  host.ctx.provide('settings', {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    getSecret: async (key: string) => values.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { values.set(key, value); },
  });
  // Dormant dependencies fail if used; allowlist, spawn, probe and transports are production code.
  host.ctx.provide('secrets', {});
  host.ctx.provide('llm', {});
  host.ctx.provide('webSearch', {
    doSearch: (query: SearchInput, signal?: AbortSignal) => doSearch(defaultToolConfig(), query, () => undefined, signal),
  });
  const info = (message: string): void => { if (/^MCP std(out|err) reader terminated$/.test(message)) readerEnds += 1; };
  host.ctx.provide('log', { logger: () => ({ warn: () => undefined, error: (message: string) => { errorLogs.push(message); }, info }) });
  await host.install(mcpPlugin);
  return host;
}

const messages = (records: FixtureRecord[]): MessageRecord[] => records.filter((record): record is MessageRecord => record.kind === 'message');
const methods = (records: FixtureRecord[]): (string | null)[] => messages(records).map(record => record.method);
const lifecycle = (records: FixtureRecord[]) => records.filter(record => record.kind === 'lifecycle').map(record => record.kind === 'lifecycle' ? `${record.event}:${record.reason ?? ''}` : '');

async function probeStdioOn(mcp: McpService, script: ScriptId): Promise<{ host: TestHost; result: Record<string, unknown> }> {
  const host = await hostWith([mcp.toolsListEntry(script)]);
  const launch = mcp.stdioLaunch(script);
  const result = await host.invoke<Record<string, unknown>>('test_mcp_connection', {
    command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, framing: launch.framing,
  });
  return { host, result };
}

async function probeStdio(mcp: McpService, script: ScriptId): Promise<Record<string, unknown>> {
  return (await probeStdioOn(mcp, script)).result;
}

const progress = (host: TestHost): unknown[] => host.eventsNamed('mcp-test-progress').map(event => (event as { step: string }).step);

describe('WAVE0 MCP service: stdio through the real test_mcp_connection / mcp_stdio_* commands', () => {
  it('success probe lists the fixture tools and records the full exchange and child lifecycle', async () => {
    const mcp = await service();
    const { host, result } = await probeStdioOn(mcp, 'success');
    expect(result).toMatchObject({
      success: true, transport: 'stdio',
      server: { name: 'mcp-test-server', version: '1.0.0', protocol_version: '2025-06-18' },
      tools_count: TOOLS.length, prompts_count: 0, resources_count: 0,
    });
    // test_helpers.rs:46/298-342/182: every stage in order, then `done` after a successful gather.
    expect(progress(host)).toEqual(['spawn_process', 'connecting', 'initializing', 'listing_tools', 'listing_prompts', 'listing_resources', 'disconnecting', 'done']);
    expect((result.tools_preview as { name: string }[]).map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name));
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const { stdio, network } = mcp.records();
    expect(network).toEqual([]);
    expect(methods(stdio)).toEqual(['initialize', 'initialized', 'tools/list', 'prompts/list', 'resources/list']);
    expect(messages(stdio)[1]?.raw).toBe('{"jsonrpc":"2.0","method":"initialized"}');
    expect(lifecycle(stdio)).toEqual(['start:', 'exit:stdin-end']);
  });

  it('tools/call keeps raw arguments, ToolNotFound error data, isError texts and cancellation over one session', async () => {
    const mcp = await service();
    const host = await hostWith([mcp.toolsListEntry('success')]);
    const launch = mcp.stdioLaunch('success');
    const id = await host.invoke<string>('mcp_stdio_start', {
      command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, framing: launch.framing,
    });
    const prefix = `mcp-stdio-${id}`;
    const replies = (): Record<string, unknown>[] => host.eventsNamed(`${prefix}-message`)
      .map(event => JSON.parse((event as { message: string }).message) as Record<string, unknown>);
    const send = async (payload: string, waitForId: number | null): Promise<void> => {
      await host.invoke('mcp_stdio_send', { sessionId: id, payload });
      if (waitForId !== null) await vi.waitFor(() => { expect(replies().some(reply => reply.id === waitForId)).toBe(true); }, { timeout: 10_000 });
    };
    const echo = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo_args","arguments":{"big":12345678901234567890,"neg":-0,"s":"\\u4e2d","nested":{"empty":[],"nil":null}}}}';
    await send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}', 1);
    await send(echo, 2);
    await send('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"missing_tool","arguments":{"a":1}}}', 3);
    let next = 4;
    for (const kind of Object.keys(FAIL_TEXTS)) {
      await send(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { name: 'fail_tool', arguments: { kind } } }), next);
      next += 1;
    }
    await send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'hold', arguments: {} } }), null);
    await send('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":99,"reason":"user"}}', null);
    await vi.waitFor(() => { expect(messages(mcp.records().stdio).map(record => record.outcome)).toContain('cancelled-notice'); }, { timeout: 10_000 });

    const byId = new Map(replies().map(reply => [reply.id, reply]));
    expect((byId.get(2) as { result: { content: { text: string }[] } }).result.content[1]?.text).toBe(echo);
    expect(byId.get(3)).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Tool not found: missing_tool', data: { tool: 'missing_tool', script: 'success' } } });
    expect([4, 5, 6, 7].map(n => byId.get(n))).toEqual(Object.values(FAIL_TEXTS).map((text, index) => (
      { jsonrpc: '2.0', id: index + 4, result: { content: [{ type: 'text', text }], isError: true } })));
    expect(byId.has(99)).toBe(false);
    const stdio = messages(mcp.records().stdio);
    expect(stdio.find(record => record.id === 2)?.raw).toBe(echo);
    expect(stdio.slice(-2).map(record => [record.method, record.id, record.outcome])).toEqual([
      ['tools/call', 99, 'held'], ['notifications/cancelled', null, 'cancelled-notice']]);

    await host.invoke('mcp_stdio_close', { sessionId: id });
    expect(await mcp.whenIdle(15_000)).toBe(true);
    expect(lifecycle(mcp.records().stdio)).toEqual(['start:', 'exit:stdin-end']);
  });

  it('disconnect-on-call exits the child after tools/call without a reply and the session closes', async () => {
    const mcp = await service();
    const host = await hostWith([mcp.toolsListEntry('disconnect-on-call')]);
    const launch = mcp.stdioLaunch('disconnect-on-call');
    const id = await host.invoke<string>('mcp_stdio_start', {
      command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, framing: launch.framing,
    });
    await host.invoke('mcp_stdio_send', { sessionId: id, payload: '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"echo_args","arguments":{}}}' });
    await vi.waitFor(() => { expect(host.eventsNamed(`mcp-stdio-${id}-closed`)).toHaveLength(1); }, { timeout: 10_000 });
    expect(host.eventsNamed(`mcp-stdio-${id}-message`)).toEqual([]);
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const { stdio } = mcp.records();
    expect(messages(stdio).map(record => [record.method, record.outcome, record.replies])).toEqual([['tools/call', 'disconnect', [null]]]);
    expect(lifecycle(stdio)).toEqual(['start:', 'exit:disconnect-script']);
  });

  it.each([
    ['initialize-error', ['initialize'], 'fixture initialize failure',
      '初始化失败: Protocol error: Initialize failed: code=-32603 message=fixture initialize failure', 'initializing'],
    ['tools-list-error', ['initialize', 'initialized', 'tools/list'], 'fixture tools/list failure',
      'tools/list 调用失败: Protocol error: Failed to list tools', 'listing_tools'],
  ] as const)('%s: test_stdio returns the Rust stage error, disconnects and the child exits on stdin EOF', async (script, expected, text, error, lastStep) => {
    const mcp = await service();
    const { host, result } = await probeStdioOn(mcp, script);
    // test_helpers.rs:305-319: stage prefix + McpError Display, no `无法启动进程` wrapper.
    expect(result).toEqual({ success: false, transport: 'stdio', error });
    const steps = ['spawn_process', 'connecting', 'initializing', 'listing_tools'];
    expect(progress(host)).toEqual(steps.slice(0, steps.indexOf(lastStep) + 1));
    // `let _ = client.disconnect()` ran before the command returned: the child already saw stdin EOF.
    expect(await mcp.whenIdle(15_000)).toBe(true);
    expect(mcp.liveStdio()).toEqual([]);
    expect(lifecycle(mcp.records().stdio)).toEqual(['start:', 'exit:stdin-end']);
    expect(methods(mcp.records().stdio)).toEqual(expected);
    const stdio = messages(mcp.records().stdio);
    expect(JSON.parse(stdio.at(-1)?.replies[0] ?? 'null')).toMatchObject({ error: { code: -32603, message: text, data: { script } } });
    if (script === 'initialize-error') {
      expect(errorLogs).toContain('[McpClient] initialize rejected by server: code=-32603 message=fixture initialize failure');
    }
  });

  it.each([
    ['disconnect-on-list', 'exit:disconnect-script'],
    ['protocol-garbage', 'exit:disconnect-script'],
  ] as const)('%s: test_stdio settles the pending tools/list after the Rust 30s send_request timeout', async (script, exit) => {
    const mcp = await service();
    const started = performance.now();
    const { host, result } = await probeStdioOn(mcp, script);
    const elapsed = performance.now() - started;
    // client.rs:1708-1732: the receive loop already stopped on Channel closed; the waiter settles
    // only through the fixed 30s timeout, then test_helpers.rs:317-318 disconnects and prefixes.
    expect(result).toEqual({ success: false, transport: 'stdio', error: 'tools/list 调用失败: Timeout error: Request timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(29_900);
    expect(elapsed).toBeLessThan(40_000);
    expect(progress(host)).toEqual(['spawn_process', 'connecting', 'initializing', 'listing_tools']);
    expect(errorLogs.some(message => /^MCP send_request timeout: method=tools\/list, id=2, transport=stdio$/.test(message))).toBe(true);
    expect(await mcp.whenIdle(15_000)).toBe(true);
    expect(mcp.liveStdio()).toEqual([]);
    expect(lifecycle(mcp.records().stdio)).toEqual(['start:', exit]);
    expect(methods(mcp.records().stdio)).toEqual(['initialize', 'initialized', 'tools/list']);
  }, 60_000);

  it.each([
    ['disconnect-on-list', []],
    ['protocol-garbage', [{ message: GARBAGE_TEXT }]],
  ] as const)('%s: session sees the scripted tools/list outcome and then the child closes', async (script, listEvents) => {
    const mcp = await service();
    const host = await hostWith([mcp.toolsListEntry(script)]);
    const launch = mcp.stdioLaunch(script);
    const id = await host.invoke<string>('mcp_stdio_start', {
      command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, framing: launch.framing,
    });
    const prefix = `mcp-stdio-${id}`;
    await host.invoke('mcp_stdio_send', { sessionId: id, payload: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
    await vi.waitFor(() => { expect(host.eventsNamed(`${prefix}-message`)).toHaveLength(1); }, { timeout: 10_000 });
    await host.invoke('mcp_stdio_send', { sessionId: id, payload: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' });
    await vi.waitFor(() => { expect(host.eventsNamed(`${prefix}-closed`)).toHaveLength(1); }, { timeout: 10_000 });
    expect(host.eventsNamed(`${prefix}-message`).slice(1)).toEqual(listEvents);
    expect(await mcp.whenIdle(15_000)).toBe(true);
    expect(lifecycle(mcp.records().stdio)).toEqual(['start:', 'exit:disconnect-script']);
  });

  it('protocol-invalid-tools replies with a non-array tools field (client handling is the A/B question)', async () => {
    const mcp = await service();
    await probeStdio(mcp, 'protocol-invalid-tools');
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const list = messages(mcp.records().stdio).find(record => record.method === 'tools/list');
    expect(JSON.parse(list?.replies[0] ?? 'null')).toMatchObject({ result: { tools: 'not-an-array' } });
  });
});

describe('WAVE0 MCP service: streamable HTTP and SSE through test_mcp_http / test_mcp_sse', () => {
  it('HTTP success assigns http-1 on initialize and later requests carry it', async () => {
    const mcp = await service();
    const host = await hostWith([]);
    const result = await host.invoke<Record<string, unknown>>('test_mcp_http', { endpoint: mcp.httpUrl('success'), apiKey: 'k-fixture' });
    expect(result).toMatchObject({ success: true, transport: 'http', tools_count: TOOLS.length, server: { name: 'mcp-test-server' } });
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const http = messages(mcp.records().network);
    expect(http.map(record => record.method)).toEqual(['initialize', 'initialized', 'tools/list', 'prompts/list', 'resources/list']);
    expect(http[1]?.raw).toBe('{"jsonrpc":"2.0","method":"initialized"}');
    expect(http[0]?.session).toBeNull();
    expect(http.slice(1).every(record => record.session === 'http-1')).toBe(true);
    expect(http[0]?.headers?.authorization).toBe('Bearer k-fixture');
  });

  it.each([
    ['tools-list-error', 'fixture tools/list failure', 'tools/list 调用失败: Protocol error: Failed to list tools'],
    ['initialize-error', 'fixture initialize failure', '初始化失败: Protocol error: Initialize failed: code=-32603 message=fixture initialize failure'],
    ['disconnect-on-list', null, null],
    ['protocol-garbage', null, null],
  ] as const)('HTTP %s fails the probe with the Rust stage prefix (no HTTP 初始化失败 wrapper)', async (script, text, error) => {
    const mcp = await service();
    const host = await hostWith([]);
    const result = await host.invoke<Record<string, unknown>>('test_mcp_http', { endpoint: mcp.httpUrl(script), apiKey: '' });
    expect(result).toMatchObject({ success: false, transport: 'http' });
    if (error !== null) expect(result.error).toBe(error);
    else expect(String(result.error)).toMatch(/^tools\/list 调用失败: /);
    const last = messages(mcp.records().network).at(-1);
    expect(last?.method).toBe(script === 'initialize-error' ? 'initialize' : 'tools/list');
    if (text !== null) expect(JSON.parse(last?.replies[0] ?? 'null')).toMatchObject({ error: { code: -32603, message: text } });
    if (script === 'protocol-garbage') expect(last?.replies).toEqual([GARBAGE_TEXT, null]);
  });

  it('SSE success uses the endpoint event session and records stream open/close', async () => {
    const mcp = await service();
    const host = await hostWith([]);
    const result = await host.invoke<Record<string, unknown>>('test_mcp_sse', { endpoint: mcp.sseUrl('success'), apiKey: '' });
    expect(result).toMatchObject({ success: true, transport: 'sse', tools_count: TOOLS.length });
    expect(await mcp.whenIdle(15_000)).toBe(true);
    const { network } = mcp.records();
    expect(lifecycle(network)).toEqual(['stream-open:', 'stream-close:client-closed']);
    expect(messages(network).every(record => record.session === 's1')).toBe(true);
    expect(methods(network)).toEqual(['initialize', 'initialized', 'tools/list', 'prompts/list', 'resources/list']);
  });
});

describe('WP-184: initialized through production connect and real HTTP send completion', () => {
  it.each(['stdio', 'http'] as const)('%s registered mcp service connects before tools/list with the Rust initialized bytes', async transport => {
    const mcp = await service();
    const host = await hostWith([]);
    const config = defaultMcpConfig();
    const launch = mcp.stdioLaunch('success');
    config.transport = transport === 'stdio'
      ? { type: 'stdio', command: launch.command, args: launch.args, env: launch.env, working_dir: launch.cwd, framing: launch.framing }
      : { type: 'http', url: mcp.httpUrl('success'), headers: {} };
    await host.ctx.mcp.initializeGlobalClient(config);
    const client = await host.ctx.mcp.getGlobalClient();
    expect(client).not.toBeNull();
    try {
      expect(await client?.listTools()).toEqual(TOOLS);
      const records = messages(transport === 'stdio' ? mcp.records().stdio : mcp.records().network);
      expect(records.map(record => record.method)).toEqual(['initialize', 'initialized', 'tools/list']);
      expect(records[1]?.raw).toBe('{"jsonrpc":"2.0","method":"initialized"}');
      expect(JSON.parse(records[0]?.raw ?? 'null').params.clientInfo).toEqual({ name: 'deep-student', version: '1.0.0' });
      expect(client?.isConnected()).toBe(true);
    } finally { await client?.disconnect(); }
    expect(await mcp.whenIdle(15_000)).toBe(true);
  });

  it.each(['success', 'http-error', 'disconnect'] as const)('%s: store → ServerInfoReceived → await real notification send → settle', async outcome => {
    const raw: string[] = [];
    const order: string[] = [];
    let receiveNotification!: (response: ServerResponse) => void;
    const received = new Promise<ServerResponse>(resolve => { receiveNotification = resolve; });
    let holdNotification = true;
    const info = { name: 'notification-server', version: '1', protocol_version: '2025-06-18', capabilities: {} };
    // This is only the remote peer: all client transport, RPC dispatch and state are production.
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      raw.push(body);
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'notify-session' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: info.protocol_version, capabilities: info.capabilities,
          serverInfo: { name: info.name, version: info.version },
        } }));
      } else {
        if (holdNotification) {
          order.push('notification-received');
          receiveNotification(response);
        } else if (outcome === 'http-error') response.writeHead(503).end('notification refused');
        else response.destroy();
      }
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rpc = new JsonRpcProbe(await createTransportForConfig({ type: 'http', url, headers: {} }));
    rpc.onEvent(event => {
      order.push(event.type);
      if (event.type === 'ServerInfoReceived') {
        expect(rpc.server).toEqual(info);
        expect(event.server).toBe(rpc.server);
      }
    });
    rpc.connect();
    let settled = false;
    const initialization = rpc.initialize().then(
      value => { settled = true; order.push('resolved'); return { value }; },
      error => { settled = true; order.push('rejected'); return { error: (error as Error).message }; },
    );
    try {
      const response = await received;
      expect(raw.map(body => JSON.parse(body).method)).toEqual(['initialize', 'initialized']);
      expect(raw[1]).toBe('{"jsonrpc":"2.0","method":"initialized"}');
      expect(order).toEqual(['Connected', 'ServerInfoReceived', 'notification-received']);
      expect(settled).toBe(false);
      if (outcome === 'success') response.writeHead(202).end();
      else if (outcome === 'http-error') response.writeHead(503).end('notification refused');
      else response.destroy();
      // Preserve existing transport error text; this work only changes client.rs:1272's method.
      expect(await initialization).toEqual(outcome === 'success' ? { value: info }
        : { error: outcome === 'http-error' ? 'HTTP 503: notification refused' : 'fetch failed' });
      expect(rpc.server).toEqual(info);
      expect(order).toEqual(['Connected', 'ServerInfoReceived', 'notification-received', outcome === 'success' ? 'resolved' : 'rejected']);
      if (outcome !== 'success') {
        holdNotification = false;
        const host = await hostWith([]);
        const error = outcome === 'http-error' ? 'HTTP 503: notification refused' : 'fetch failed';
        expect(await host.invoke('test_mcp_http', { endpoint: url, apiKey: '' })).toEqual({
          success: false, transport: 'http', error: `初始化失败: ${error}`,
        });
        const config = defaultMcpConfig();
        config.transport = { type: 'http', url, headers: {} };
        await expect(host.ctx.mcp.initializeGlobalClient(config)).rejects.toThrow(error);
        expect(await host.ctx.mcp.getGlobalClient()).toBeNull();
        expect(errorLogs).toEqual([`Failed to initialize MCP client: ${error}`]);
        expect(raw.map(body => JSON.parse(body).method)).toEqual([
          'initialize', 'initialized', 'initialize', 'initialized', 'initialize', 'initialized',
        ]);
        expect([raw[1], raw[3], raw[5]]).toEqual(Array(3).fill('{"jsonrpc":"2.0","method":"initialized"}'));
      }
    } finally {
      server.closeAllConnections();
      await rpc.close();
      await initialization;
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    }
    expect(order.at(-1)).toBe('Disconnected');
  });
});

describe('WAVE0 MCP service: lifecycle, isolation and configuration', () => {
  it('reset ends open streams and held requests, clears records and restarts session numbering', async () => {
    const mcp = await service();
    const stream = await fetch(mcp.sseUrl('success'), { headers: { accept: 'text/event-stream' } });
    const reader = stream.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('event: endpoint\ndata: /sse/success/messages?sessionId=s1\n\n');
    const held = fetch(mcp.httpUrl('success'), { method: 'POST', body: '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hold"}}' });
    await vi.waitFor(() => { expect(mcp.openCount()).toBe(2); });
    expect(await mcp.reset()).toEqual({ closedStreams: 1, liveStdio: [] });
    await expect(held).rejects.toThrow();
    expect(await mcp.whenIdle(5_000)).toBe(true);
    expect(mcp.records()).toEqual({ network: [], stdio: [], oauth: [], browser: [] });
    const again = await fetch(mcp.sseUrl('success'));
    expect(new TextDecoder().decode((await again.body?.getReader().read())?.value)).toContain('sessionId=s1');
    await mcp.reset();
  });

  it('unknown scripts are 404 and recorded; separate services have separate ports and logs; stop closes the port', async () => {
    const first = await service();
    const second = await service();
    expect(first.url).not.toBe(second.url);
    expect(first.stdioLogFile).not.toBe(second.stdioLogFile);
    const missing = await fetch(`${first.url}/mcp/no-such-script`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
    expect(lifecycle(first.records().network)).toEqual(['not-found:unknown-script']);
    expect(second.records().network).toEqual([]);
    await first.stop();
    await expect(fetch(first.httpUrl('success'), { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('selfContained launches a copy under logDir: a fixed logDir and port give the same placeholders on every run', async () => {
    const logDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-g3-')));
    logDirs.push(logDir);
    // Both runs pin both listeners. Left at 0, the OAuth port is ephemeral and equals port + 1 only where
    // ephemeral ports come in sequence (macOS, not Linux); a pinned port + 1 may be taken on a busy host.
    const probe = await startMcpService({ logDir, selfContained: true });
    services.push(probe);
    const ports = { port: Number(new URL(probe.url).port), oauthPort: Number(new URL(probe.oauthUrl).port) };
    await probe.stop();
    const first = await startMcpService({ logDir, ...ports, selfContained: true });
    services.push(first);
    const { result } = await probeStdioOn(first, 'success');
    expect(result).toMatchObject({ success: true, transport: 'stdio', tools_count: TOOLS.length });
    expect(await first.whenIdle(15_000)).toBe(true);
    expect(methods(first.records().stdio)).toEqual(['initialize', 'initialized', 'tools/list', 'prompts/list', 'resources/list']);
    expect(lifecycle(first.records().stdio)).toEqual(['start:', 'exit:stdin-end']);
    const bindings = first.bindings();
    await first.stop();

    const second = await startMcpService({ logDir, ...ports, selfContained: true });
    services.push(second);
    expect(second.bindings()).toEqual(bindings);
    expect(second.records().stdio).toEqual([]);
    expect(second.stdioLaunch('success')).toMatchObject({
      args: [join(logDir, 'fixture', 'stdio-server.ts'), 'success', '--log', join(logDir, 'stdio-records.jsonl')], cwd: logDir,
    });
    expect(JSON.stringify(bindings)).not.toContain(dirname(fileURLToPath(import.meta.url)));
  });

  it('bindings() holds every placeholder under its script id (OAuth server under oauth)', async () => {
    const mcp = await service();
    const bindings = mcp.bindings() as Record<string, Record<string, unknown> | string>;
    expect(Object.keys(bindings).sort()).toEqual(['url', 'oauth', ...SCRIPT_IDS].sort());
    expect(bindings.url).toBe(mcp.url);
    for (const [key, value] of Object.entries(mcp.placeholders())) {
      if (key === 'mcp.url') continue;
      const [, script = '', field = ''] = key.split('.');
      expect((bindings[script] as Record<string, unknown>)[field]).toEqual(value);
    }
  });

  it('stdio child rejects an unknown script with exit 2 and a config-error record', async () => {
    const mcp = await service();
    const launch = mcp.stdioLaunch('success');
    const args = [launch.args[0] ?? '', 'no-such-script', '--log', mcp.stdioLogFile];
    const code = await new Promise<number | null>(resolve => {
      const child = spawn(launch.command, args, { env: { ...launch.env, PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', resolve);
    });
    expect(code).toBe(2);
    expect(lifecycle(mcp.records().stdio)).toEqual(['config-error:unknown-script']);
  });

  it('runtime never hands the bare Electron binary to an env-clearing spawner', () => {
    const runtime = currentStdioRuntime();
    if (typeof process.versions.electron === 'string') {
      expect(runtime.kind === 'node-path' || (runtime.kind === 'electron-as-node' && runtime.env.ELECTRON_RUN_AS_NODE === '1')).toBe(true);
    } else {
      expect(runtime).toMatchObject({ kind: 'node-execpath', env: {} });
    }
    // Electron branches with a Node binary standing in for execPath: PATH first, then ELECTRON_RUN_AS_NODE.
    const node = currentStdioRuntime().command;
    expect(resolveStdioRuntime({ execPath: node, isElectron: true, pathEnv: dirname(node) }).kind).toBe('node-path');
    expect(resolveStdioRuntime({ execPath: node, isElectron: true, pathEnv: '' })).toMatchObject({ kind: 'electron-as-node', env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(() => resolveStdioRuntime({ execPath: node, isElectron: false, pathEnv: '', nodeCommand: '/usr/bin/true' })).toThrow(/nodeCommand cannot run/);
  });

  it('CLI prints its address, serves control routes and exits 0 with all records on stdin EOF', async () => {
    const runtime = currentStdioRuntime();
    const child = spawn(runtime.command, [new URL('./mcp-service.ts', import.meta.url).pathname], {
      env: { ...process.env, ...runtime.env }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ready = JSON.parse(String((await lines.next()).value)) as { url: string; control: string; scripts: Record<string, string> };
    expect(Object.keys(ready.scripts)).toContain('protocol-garbage');
    const launch = await (await fetch(`${ready.control}/launch/success`)).json() as { args: string[] };
    expect(launch.args.slice(1, 3)).toEqual(['success', '--log']);
    await fetch(`${ready.url}/mcp/success`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    const exited = new Promise<number | null>(resolve => { child.on('exit', resolve); });
    child.stdin.end();
    const last = JSON.parse(String((await lines.next()).value)) as { stopped: boolean; records: { network: MessageRecord[] } };
    expect(await exited).toBe(0);
    expect(last.stopped).toBe(true);
    expect(last.records.network.map(record => [record.method, record.outcome])).toEqual([['ping', 'result']]);
  });
});
