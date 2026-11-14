import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpConfig } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import { createWebSearchToolRegistry, defaultToolConfig, doSearch, type ToolContext } from '../api.ts';
import { defaultMcpConfig } from '../src/config.ts';
import { connectMcpClient } from '../src/client.ts';
import { encodeToolNameForApi } from '../src/canonical-tools.ts';
import { HostMcpService } from '../src/service.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

const runtime = currentStdioRuntime();

const SERVER = String.raw`
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
      protocolVersion: process.env.TEST_PROTOCOL || message.params.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mini', version: '0.1' },
    });
  } else if (method === 'tools/list') {
    reply(id, { tools: [{
      name: 'echo', description: 'Echo text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }] });
  } else if (method === 'tools/call') {
    const name = message.params.name;
    if (name === 'fail_text' || name === 'fail_empty') {
      const content = [{ type: 'image', data: 'AA==', mimeType: 'image/png' }];
      if (name === 'fail_text') content.unshift({ type: 'text', text: 'first failure' });
      if (name === 'fail_text') content.push({ type: 'text', text: 'second failure' });
      reply(id, { content, isError: true });
      return;
    }
    if (name === 'server_error') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'rejected' } }) + '\n');
      return;
    }
    if (name === 'missing_result') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id }) + '\n');
      return;
    }
    if (name === 'result_and_error') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'result wins' }], isError: false },
        error: { code: -32000, message: 'ignored because result exists' },
      }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/tools/list_changed',
    }) + '\n');
    reply(id, { content: [{ type: 'text', text: 'ok' }], isError: false });
  } else if (id !== undefined && id !== null) {
    reply(id, {});
  }
});
`;

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it('local web_search registry returns Rust error.message and no failed-search citations (tools/mod.rs:1083-1102)', async () => {
  const registry = createWebSearchToolRegistry({
    doSearch: (input, signal) => doSearch(defaultToolConfig(), input, () => undefined, signal),
  });
  const result = await registry.callTool('web_search', {
    query: 'registry mapping', force_engine: 'unrecognized-engine',
  }, toolContext());
  expect(result[0]).toBe(false);
  expect(result[2]).toBe('config error: unknown engine: unrecognized-engine');
  expect(result[3]).toMatchObject({ elapsed_ms: 0 });
  expect(result[4]).toBeNull();
  expect(result[5]).toBeNull();
});

async function serverScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-client-test-'));
  tempDirs.push(dir);
  const script = join(dir, 'server.cjs');
  await writeFile(script, SERVER);
  return script;
}

it('X6-LP-0166: real client warns and rejects isError tool results, preserving Rust result/error ordering', async () => {
  const script = await serverScript();
  const logs: { level: string; message: string }[] = [];
  const client = await connectMcpClient(configFor(script), (level, message) => { logs.push({ level, message }); });
  try {
    await expect(client.callTool('fail_text', {})).rejects.toThrow('Tool execution error: first failure; second failure');
    await expect(client.callTool('fail_empty', {})).rejects.toThrow('Tool execution error: Tool execution failed');
    await expect(client.callTool('server_error', {})).rejects.toThrow('Server error: rejected');
    await expect(client.callTool('missing_result', {})).rejects.toThrow('Protocol error: Tool call failed');
    expect(await client.callTool('result_and_error', {})).toEqual({
      content: [{ type: 'text', text: 'result wins' }], isError: false,
    });
    expect(logs.filter(log => log.level === 'warn')).toEqual([
      { level: 'warn', message: "Tool 'fail_text' execution failed: first failure; second failure" },
      { level: 'warn', message: "Tool 'fail_empty' execution failed: " },
    ]);
    expect(client.isConnected()).toBe(true);
  } finally { await client.disconnect(); }
});

function configFor(script: string, env: Record<string, string> = {}): McpConfig {
  const config = defaultMcpConfig();
  config.transport = {
    type: 'stdio', command: runtime.command, args: [script], framing: 'jsonl', env: { ...runtime.env, ...env },
  };
  config.performance.timeout_ms = 5_000;
  return config;
}

function toolContext(): ToolContext {
  return {
    supports_tools: true, mcp_client: null, stream_event: null,
    stage: null, memory_enabled: null,
  };
}

describe('mcp client production wiring', () => {
  it('connects, lists tools with inputSchema, calls a tool and disconnects', async () => {
    const script = await serverScript();
    const logs: string[] = [];
    let toolsChanged = 0;
    const client = await connectMcpClient(configFor(script), (level, message) => {
      logs.push(`${level}: ${message}`);
    }, () => { toolsChanged += 1; });
    expect(client.isConnected()).toBe(true);
    expect(await client.listTools()).toEqual([{
      name: 'echo', description: 'Echo text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }]);
    expect(await client.callTool('echo', { text: 'x' })).toMatchObject({
      content: [{ type: 'text', text: 'ok' }], isError: false,
    });
    expect(toolsChanged).toBe(1);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(logs.some(line => line.includes('MCP client connected to server: mini v0.1'))).toBe(true);
  });

  it('warns when the server returns an unsupported protocol version', async () => {
    const script = await serverScript();
    const logs: string[] = [];
    const client = await connectMcpClient(
      configFor(script, { TEST_PROTOCOL: '2099-01-01' }),
      (level, message) => { logs.push(`${level}: ${message}`); },
    );
    await client.disconnect();
    expect(logs.some(line => line.includes('warn:') && line.includes('unsupported protocol version'))).toBe(true);
  });

  it('invokes the local web_search tool through the registry', async () => {
    const calls: unknown[] = [];
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const service = new HostMcpService({
      log: () => undefined,
      namespacePrefix: () => null,
      emitEvent: (event, payload) => { emitted.push({ event, payload }); },
      webSearch: {
        doSearch: async input => {
          calls.push(input);
          return {
            name: 'web_search', ok: true,
            result: { raw: {}, provider: 'bing_rss' },
            citations: [{ documentId: 'https://example.com', fileName: 'Example', chunkText: 'x', score: 1, chunkIndex: 0 }],
            usage: { elapsed_ms: 3, provider: 'bing_rss' },
            inject_text: 'found',
          };
        },
      },
    });
    const invocation = await service.registry.callTool('web_search', {
      query: 'rust', top_k: 2, site: 'example.com',
    }, toolContext());
    expect(invocation[0]).toBe(true);
    expect(invocation[4]).toHaveLength(1);
    expect(invocation[5]).toBe('found');
    expect(calls[0]).toMatchObject({
      query: 'rust', top_k: 2, site: 'example.com', engine: null, time_range: null,
    });
    const withStream = await service.registry.callTool('web_search', {
      query: 'rust', top_k: 2, site: 'example.com',
    }, { ...toolContext(), window: { window: 'main', webview: 'main' }, stream_event: 'chat_v2_event_1', stage: 'tool' });
    expect(withStream[0]).toBe(true);
    expect(emitted).toEqual([{
      event: 'chat_v2_event_1_web_search',
      payload: {
        sources: [{
          document_id: 'https://example.com', file_name: 'Example', chunk_text: 'x',
          score: 1, chunk_index: 0, source_type: 'search', origin: 'web_search', stage: 'tool',
        }],
        stage: 'tool',
        tool_name: 'web_search',
      },
    }]);
    const empty = await service.registry.callTool('web_search', { query: '  ' }, toolContext());
    expect(empty).toEqual([false, null, 'query is empty', { elapsed_ms: 0 }, null, null]);
    await service.dispose();
  });

  it('provides the mcp service and resolves canonical names through the registry', async () => {
    const script = await serverScript();
    const service = new HostMcpService({
      log: () => undefined,
      namespacePrefix: () => 'mcp.tools.',
    });
    await service.initializeGlobalClient(configFor(script));
    expect(await service.getGlobalClient()).not.toBeNull();
    expect(service.registry.stripMcpNamespace('mcp.tools.echo')).toBe('echo');
    const encoded = encodeToolNameForApi('mcp.tools.echo');
    expect(encoded).not.toBeNull();
    const invocation = await service.registry.callTool(encoded!, { text: 'x' }, toolContext());
    expect(invocation[0]).toBe(true);
    expect(invocation[2]).toBeNull();
    expect(invocation[5]).toBeNull();
    await service.dispose();
    expect(await service.getGlobalClient()).toBeNull();
  });
});
