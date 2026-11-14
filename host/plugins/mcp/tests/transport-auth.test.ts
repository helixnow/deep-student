import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAuthorizationHeader } from '../src/auth-token.ts';
import {
  McpEventEmitter, McpRequestManager, McpStreamManager, handleMcpMessage,
} from '../src/client-dispatch.ts';
import { endpointFetchPolicy } from '../src/endpoint.ts';
import { createCallbackListenerForTest } from '../src/oauth-manager.ts';
import {
  createSseProbeTransport, httpProbeConfig, sseProbeConfig, testHttp, testSse, testStdio,
} from '../src/probe.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

const runtime = currentStdioRuntime();

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

describe('crates/dstu-mcp/src/mcp/http_transport.rs::tests', () => {
  it('test_http_config', () => {
    const config = httpProbeConfig('https://example.com/mcp', 'test_key', null, 30_000);
    expect(config.endpoint).toBe('https://example.com/mcp');
    expect(config.apiKey).toBe('test_key');
    expect(config.timeoutMs).toBe(30_000);
  });

  it('http_auth_wiring_api_key_beats_oauth_flag', async () => {
    const config = {
      url: 'https://example.test/mcp',
      apiKey: 'http-key',
      oauthConfigured: true,
      authProvider: 'global-mcp',
    };
    const auth = await resolveAuthorizationHeader(
      config.authProvider, config.apiKey, config.oauthConfigured,
      async () => { throw new Error('oauth token lookup must not run'); },
    );
    expect(auth).toBe('Bearer http-key');
  });

  it('http_auth_wiring_oauth_without_token_is_reauth', async () => {
    const config = {
      url: 'https://example.test/mcp',
      apiKey: null,
      oauthConfigured: true,
      authProvider: 'http-missing-oauth-c7',
    };
    await expect(resolveAuthorizationHeader(
      config.authProvider, config.apiKey, config.oauthConfigured,
      async () => null,
    )).rejects.toThrow('OAuth re-authorization required');
  });

  it('streams text/event-stream HTTP responses through the shared SSE buffer', async () => {
    const server: Server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const message = JSON.parse(body) as { id?: string | number; method?: string };
        if (message.id === undefined || message.method === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result = message.method === 'initialize'
          ? {
            protocolVersion: '2025-06-18', capabilities: {},
            serverInfo: { name: 'http-本地', version: '1.2.3' },
          }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
            : message.method === 'prompts/list' ? { prompts: [] }
              : message.method === 'resources/list' ? { resources: [] } : {};
        const payload = Buffer.from(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\r\n\r\n`,
          'utf8',
        );
        const cut = payload.indexOf(Buffer.from('本')) + 1;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' });
        response.write(payload.subarray(0, cut));
        setTimeout(() => { response.end(payload.subarray(cut)); }, 5);
      });
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const result = await testHttp(`http://127.0.0.1:${address.port}/mcp`, null, null);
      expect(result).toMatchObject({
        success: true,
        transport: 'http',
        server: { name: 'http-本地', version: '1.2.3', protocol_version: '2025-06-18' },
        tools_count: 1,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    }
  });
});

describe('crates/dstu-mcp/src/mcp/sse_transport.rs::tests', () => {
  it('sse_receive_task_stops_after_transport_drop', async () => {
    let sockets = 0;
    const server: Server = createServer((_request, response) => {
      sockets += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"sessionId":"s1"}\n\n');
      // Keep the stream open to simulate a server that never ends the response.
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const transport = createSseProbeTransport(`http://127.0.0.1:${address.port}/sse`, null);
    expect(await waitFor(() => transport.isConnected?.() === true, 2_000)).toBe(true);
    expect(sockets).toBeGreaterThanOrEqual(1);

    await transport.close();
    expect(await waitFor(() => transport.isConnected?.() === false, 2_000)).toBe(true);
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  });

  it('test_sse_config', () => {
    const config = sseProbeConfig('https://modelscope.cn/api/v1/mcp/sse', 'test_key', 30_000);
    expect(config.endpoint).toBe('https://modelscope.cn/api/v1/mcp/sse');
    expect(config.apiKey).toBe('test_key');
    expect(config.timeoutMs).toBe(30_000);
  });

  it('sse_auth_wiring_api_key_beats_oauth_flag', async () => {
    const config = {
      endpoint: 'https://example.test/sse',
      apiKey: 'sse-key',
      oauthConfigured: true,
      authProvider: 'global-mcp',
    };
    const auth = await resolveAuthorizationHeader(
      config.authProvider, config.apiKey, config.oauthConfigured,
      async () => { throw new Error('oauth token lookup must not run'); },
    );
    expect(auth).toBe('Bearer sse-key');
  });

  it('sse_auth_wiring_oauth_without_token_is_reauth', async () => {
    const config = {
      endpoint: 'https://example.test/sse',
      apiKey: null,
      oauthConfigured: true,
      authProvider: 'sse-missing-oauth-c7',
    };
    await expect(resolveAuthorizationHeader(
      config.authProvider, config.apiKey, config.oauthConfigured,
      async () => null,
    )).rejects.toThrow('OAuth re-authorization required');
  });

  it('empty endpoint fails within the connect budget instead of waiting for postUrl', async () => {
    const started = Date.now();
    const result = await testSse('', null, null);
    expect(result).toMatchObject({ success: false, transport: 'sse' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('connection refusal fails as soon as the SSE stream cannot be opened', async () => {
    const started = Date.now();
    const result = await testSse('http://127.0.0.1:1/sse', null, null);
    expect(result).toMatchObject({ success: false, transport: 'sse' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stream ending before the endpoint event fails instead of polling for 60 seconds', async () => {
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end();
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const started = Date.now();
    try {
      const result = await testSse(`http://127.0.0.1:${address.port}/sse`, null, null);
      expect(result).toMatchObject({ success: false, transport: 'sse' });
      expect(JSON.stringify(result)).toContain('SSE endpoint event not received');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    }
  });

  it('keeps waiting for a slow endpoint event and POSTs to the advertised URL', async () => {
    let postPath: string | null = null;
    let postBody = '';
    const server: Server = createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        setTimeout(() => { response.write('event: endpoint\ndata: /messages\n\n'); }, 300);
        return;
      }
      postPath = request.url ?? null;
      request.on('data', chunk => { postBody += String(chunk); });
      request.on('end', () => { response.writeHead(200).end('ok'); });
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const transport = createSseProbeTransport(`http://127.0.0.1:${address.port}/sse`, null);
      try {
        await transport.send('{"jsonrpc":"2.0","id":"1","method":"initialize"}');
      } finally {
        await transport.close();
      }
      expect(postPath).toBe('/messages');
      expect(postBody).toContain('"initialize"');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    }
  });
});

describe('crates/dstu-mcp/src/mcp/mod.rs::tests', () => {
  it('loopback_builder_disables_proxy', () => {
    const loopback = endpointFetchPolicy('http://127.0.0.1:1/mcp');
    expect(loopback.noProxy).toBe(true);
    expect(loopback.url).toBe('http://127.0.0.1:1/mcp');
    const remote = endpointFetchPolicy('https://example.com/mcp');
    expect(remote.noProxy).toBe(false);
    expect(remote.url).toBe('https://example.com/mcp');
  });
});

describe('crates/dstu-mcp/src/mcp/oauth_callback.rs::tests', () => {
  it('rejects_state_mismatch', async () => {
    const listener = await createCallbackListenerForTest('expected-state');
    try {
      const bad = await fetch(`${listener.redirectUri}?code=abc&state=wrong-state`);
      expect(bad.status).toBe(400);
      const good = await fetch(`${listener.redirectUri}?code=good&state=expected-state`);
      expect(good.status).toBe(200);
      const result = await listener.wait(2_000);
      expect(result).toEqual({ kind: 'code', code: 'good', state: 'expected-state' });
    } finally {
      listener.close();
    }
  });
});

describe('crates/dstu-mcp/src/mcp/client.rs::tests', () => {
  it('test_client_initialization', async () => {
    const requestManager = new McpRequestManager();
    const pending = requestManager.registerRequest('test-id');
    await handleMcpMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'test-server', version: '1.0.0' },
        },
        id: 'test-id',
      }),
      requestManager,
      () => undefined,
      new McpEventEmitter(),
      new McpStreamManager(),
    );
    const response = await pending;
    expect(response).not.toBeNull();
    expect(response?.result).toMatchObject({
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'test-server', version: '1.0.0' },
    });
  });
});

describe('src/cmd/mcp.rs::stdio_start_validation_tests', () => {
  it('stdio_probe_parses_spec_camel_case_tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-probe-test-'));
    const script = join(dir, 'mini_server.cjs');
    await writeFile(script, String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
rl.on('line', line => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  const message = JSON.parse(trimmed);
  const method = message.method;
  const id = message.id;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'mini', version: '0.1' },
    });
  } else if (method === 'tools/list') {
    reply(id, { tools: [{
      name: 'echo_upper',
      description: 'upper',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }] });
  } else if (method === 'prompts/list') {
    reply(id, { prompts: [] });
  } else if (method === 'resources/list') {
    reply(id, { resources: [] });
  } else if (id !== undefined && id !== null) {
    reply(id, {});
  }
});
`);
    try {
      const result = await testStdio(
        runtime.command, [script], runtime.env, dir, 'jsonl', () => undefined,
      );
      expect(result).toMatchObject({
        success: true,
        transport: 'stdio',
        tools_count: 1,
      });
      expect(result).toHaveProperty('tools_preview');
      expect((result as { tools_preview: { name: string }[] }).tools_preview[0]?.name)
        .toBe('echo_upper');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
