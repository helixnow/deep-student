import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { defaultToolConfig, doSearch, type SearchInput } from '../api.ts';
import mcpPlugin from '../index.ts';

const hosts: TestHost[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function setup() {
  const logs: { target: string; level: string; message: string }[] = [];
  const host = await createTestHost({
    plugins: [mcpPlugin],
    provide: {
      settings: { get: () => null, save: () => undefined },
      secrets: { openStore: () => ({
        saveSecret: async () => undefined, getSecret: async () => null, deleteSecret: async () => undefined,
      }) },
      llm: {},
      webSearch: { doSearch: (input: SearchInput, signal?: AbortSignal) => doSearch(defaultToolConfig(), input, () => undefined, signal) },
      log: { logger: (target: string) => ({
        warn: (message: string) => { logs.push({ target, level: 'warn', message }); },
        info: (message: string) => { logs.push({ target, level: 'info', message }); },
        error: (message: string) => { logs.push({ target, level: 'error', message }); },
      }) },
    },
  });
  hosts.push(host);
  return { host, logs };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function rpcResult(method: string): object {
  switch (method) {
    case 'initialize': return { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'headers', version: '1' } };
    case 'tools/list': return { tools: [] };
    case 'prompts/list': return { prompts: [] };
    case 'resources/list': return { resources: [] };
    default: return {};
  }
}

const env = {
  'bad key': 'bad-name',
  'x-invalid': 'bad\nvalue',
  ' X-Trim ': '\u0085 accepted \u0085',
  'X-Outer-Newline': '\ntrim-first\r\n',
  'X-Unicode': '\ufeff中文',
  'Authorization': 'Bearer custom',
  'Accept': 'application/custom',
};

function expectHeaders(headers: IncomingHttpHeaders, accept: string) {
  expect(headers['bad key']).toBeUndefined();
  expect(headers['x-invalid']).toBeUndefined();
  expect(headers['x-trim']).toBe('accepted');
  expect(headers['x-outer-newline']).toBe('trim-first');
  // HeaderValue::from_str uses UTF-8; node:http exposes received header octets as latin1.
  expect(Buffer.from(String(headers['x-unicode']), 'latin1').toString('utf8')).toBe('\ufeff中文');
  expect(headers.authorization).toBe('Bearer explicit-key');
  expect(headers.accept).toBe(accept);
}

function expectWarnings(logs: { target: string; level: string; message: string }[]) {
  const warnings = logs.filter(log => log.level === 'warn');
  expect(warnings).toHaveLength(2);
  // Rust iterates a HashMap; warn order across independent invalid entries is unspecified.
  expect(warnings).toEqual(expect.arrayContaining([
    { target: 'dstu_mcp::mcp::test_helpers', level: 'warn', message: '忽略无法解析的头部键: bad key' },
    { target: 'dstu_mcp::mcp::test_helpers', level: 'warn', message: '忽略无法解析的头部值 x-invalid = bad\nvalue' },
  ]));
}

describe('X6-LP-0172: test_helpers.rs map_env_to_headers through production commands and real HTTP/SSE', () => {
  it('test_mcp_http skips invalid headers with Rust warnings and still completes the probe', async () => {
    const { host, logs } = await setup();
    const requests: IncomingHttpHeaders[] = [];
    const base = await listen(createServer((req, res) => {
      requests.push(req.headers);
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        const message = JSON.parse(body);
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: rpcResult(message.method) }));
      });
    }));
    const result = await host.invoke('test_mcp_http', { endpoint: `${base}/mcp`, apiKey: '\u0085 explicit-key \u0085', env });
    expect(result).toMatchObject({ success: true, transport: 'http', server: { name: 'headers' } });
    expect(requests.length).toBeGreaterThan(0);
    for (const headers of requests) expectHeaders(headers, 'application/json, text/event-stream');
    expectWarnings(logs);
  });

  it('test_mcp_sse forwards mapped env headers to GET and POST, logging invalid entries only once', async () => {
    const { host, logs } = await setup();
    const requests: { method: string; headers: IncomingHttpHeaders }[] = [];
    let sendEvent!: (payload: string) => void;
    const base = await listen(createServer((req, res) => {
      requests.push({ method: req.method ?? '', headers: req.headers });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sendEvent = payload => { res.write(`event: message\ndata: ${payload}\n\n`); };
        res.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        const message = JSON.parse(body);
        res.writeHead(202).end();
        if (message.id !== undefined) sendEvent(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: rpcResult(message.method) }));
      });
    }));
    const result = await host.invoke('test_mcp_sse', { endpoint: `${base}/sse`, apiKey: 'explicit-key', env });
    expect(result).toMatchObject({ success: true, transport: 'sse', server: { name: 'headers' } });
    expect(requests.some(request => request.method === 'GET')).toBe(true);
    expect(requests.some(request => request.method === 'POST')).toBe(true);
    for (const request of requests) {
      expectHeaders(request.headers, request.method === 'GET' ? 'text/event-stream' : 'application/custom');
    }
    expectWarnings(logs);
  });
});
