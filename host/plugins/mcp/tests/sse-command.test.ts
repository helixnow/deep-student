import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import mcp from '../index.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

async function setup(): Promise<TestHost> {
  const host = await createTestHost({ plugins: [mcp], provide: {
    settings: { get: () => null, save: () => undefined },
    secrets: {
      openStore: () => ({
        saveSecret: async () => undefined,
        getSecret: async () => null,
        deleteSecret: async () => undefined,
      }),
    },
    llm: {},
    log: { logger: () => undefined },
    webSearch: {
      doSearch: async () => ({
        name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [],
      }),
    },
  } });
  hosts.push(host);
  return host;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
}

describe('cmd/mcp.rs::test_mcp_sse production command', () => {
  it('returns the Rust failure value quickly for an empty endpoint', async () => {
    const host = await setup();
    const started = Date.now();
    const result = await host.invoke('test_mcp_sse', { endpoint: '', apiKey: '' });
    expect(result).toMatchObject({ success: false, transport: 'sse' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns the Rust failure value quickly when the endpoint refuses connections', async () => {
    const host = await setup();
    const started = Date.now();
    const result = await host.invoke('test_mcp_sse', { endpoint: 'http://127.0.0.1:1/sse', apiKey: '' });
    expect(result).toMatchObject({ success: false, transport: 'sse' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('completes initialize and listing over a fragmented UTF-8 SSE stream', async () => {
    let stream: ServerResponse | null = null;
    const server: Server = createServer((request, response) => {
      if (request.method === 'GET') {
        stream = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: end');
        setTimeout(() => { response.write('point\ndata: /mess'); }, 10);
        setTimeout(() => { response.write('ages\n\n'); }, 20);
        return;
      }
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        response.writeHead(202).end();
        const message = JSON.parse(body) as { id?: string | number; method?: string };
        if (message.id === undefined || message.method === undefined) return;
        const result = message.method === 'initialize'
          ? {
            protocolVersion: '2025-06-18', capabilities: {},
            serverInfo: { name: '本地-SSE', version: '1.2.3' },
          }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
            : message.method === 'prompts/list' ? { prompts: [] }
              : message.method === 'resources/list' ? { resources: [] } : {};
        const payload = Buffer.from(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        const cut = payload.indexOf(Buffer.from('本')) + 1;
        stream?.write(payload.subarray(0, cut));
        setTimeout(() => { stream?.write(payload.subarray(cut)); }, 10);
      });
    });
    const port = await listen(server);
    try {
      const host = await setup();
      const result = await host.invoke('test_mcp_sse', {
        endpoint: `http://127.0.0.1:${port}/sse`, apiKey: '',
      });
      expect(result).toMatchObject({
        success: true,
        transport: 'sse',
        server: { name: '本地-SSE', version: '1.2.3', protocol_version: '2025-06-18' },
        tools_count: 1,
      });
    } finally { await close(server); }
  });

  it('completes initialize and listing over a real SSE postUrl', async () => {
    let stream: ServerResponse | null = null;
    const server: Server = createServer((request, response) => {
      if (request.method === 'GET') {
        stream = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        response.writeHead(202).end();
        const message = JSON.parse(body) as { id?: string | number; method?: string };
        if (message.id === undefined || message.method === undefined) return;
        const result = message.method === 'initialize'
          ? {
            protocolVersion: '2025-06-18', capabilities: {},
            serverInfo: { name: 'local-sse', version: '1.2.3' },
          }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }
            : message.method === 'prompts/list' ? { prompts: [] }
              : message.method === 'resources/list' ? { resources: [] } : {};
        stream?.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
      });
    });
    const port = await listen(server);
    try {
      const host = await setup();
      const result = await host.invoke('test_mcp_sse', {
        endpoint: `http://127.0.0.1:${port}/sse`, apiKey: '',
      });
      expect(result).toMatchObject({
        success: true,
        transport: 'sse',
        server: { name: 'local-sse', version: '1.2.3', protocol_version: '2025-06-18' },
        tools_count: 1,
        tools_preview: [{ name: 'echo', description: 'Echo' }],
      });
    } finally { await close(server); }
  });
});
