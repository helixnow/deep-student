import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { JsonValue } from '../api.ts';
import { authenticateApiKey, createLongLivedToken } from '../src/auth-token.ts';
import { loadMcpConfig } from '../src/config.ts';
import { StdioSessionManager } from '../src/stdio-proxy.ts';
import { JsonRpcProbe, createTransportForConfig } from '../src/probe.ts';
import {
  ProtocolNegotiator, checkCompatibility, type ProtocolVersion,
} from '../src/protocol-version.ts';
import { currentStdioRuntime } from '../equivalence/runtime.ts';

describe('tests/mcpbench_integration.rs', () => {
  it('test_protocol_version_negotiation', async () => {
    const negotiator = new ProtocolNegotiator();
    const cases: { serverInfo: JsonValue; expected: ProtocolVersion }[] = [
      {
        serverInfo: { supportedVersions: ['2025-06-18', '2025-03-26', '2024-11-05'] },
        expected: '2025-06-18',
      },
      { serverInfo: { supportedVersions: ['2024-11-05'] }, expected: '2024-11-05' },
      { serverInfo: { protocol_version: '2025-03-26' }, expected: '2025-03-26' },
    ];
    for (const { serverInfo, expected } of cases) {
      expect(await negotiator.negotiate(serverInfo)).toBe(expected);
    }
  });

  it('test_config_import_export', () => {
    const values = new Map<string, string>([['mcp.tools.list', JSON.stringify([{
      transportType: 'stdio',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      env: { NODE_ENV: 'production' },
      framing: 'jsonl',
    }])]]);
    const settings = { get: (key: string) => values.get(key) ?? null } as unknown as SettingsStore;
    const config = loadMcpConfig(settings);
    expect(config.transport.type).toBe('stdio');
    if (config.transport.type !== 'stdio') throw new Error('expected stdio transport');
    expect(config.transport.command).toBe('npx');
    expect(config.transport.args).toContain('-y');
    expect(config.transport.args).toContain('firecrawl-mcp');
    expect(config.transport.env).toEqual({ NODE_ENV: 'production' });
    expect(config.transport.framing).toBe('jsonl');
  });

  it('test_oauth_authentication', () => {
    const token = authenticateApiKey('test_api_key');
    expect(token).toEqual({ kind: 'api_key', key: 'test_api_key' });
    const longLived = createLongLivedToken('modelscope');
    expect(longLived.startsWith('mcp_modelscope_')).toBe(true);
    expect(longLived.length).toBeGreaterThan(20);
  });

  it('test_transport_selection', () => {
    const negotiator = new ProtocolNegotiator();
    expect(negotiator.selectTransport('2025-06-18', ['stdio', 'websocket', 'sse', 'streamable_http']))
      .toBe('streamable_http');
    expect(negotiator.selectTransport('2024-11-05', ['stdio', 'websocket', 'sse', 'streamable_http']))
      .toBe('websocket');
    expect(negotiator.selectTransport('2025-06-18', ['stdio', 'sse'])).toBe('stdio');
  });

  it('test_concurrent_connections', async () => {
    const sessions = new StdioSessionManager(() => undefined);
    try {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push(await sessions.start('echo', ['test'], {}, 'jsonl', null));
      }
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
    } finally {
      await sessions.dispose();
    }
  });

  it('test_compatibility_matrix', () => {
    const matrix: [ProtocolVersion, ProtocolVersion, string][] = [
      ['2025-06-18', '2025-06-18', 'FullyCompatible'],
      ['2025-06-18', '2024-11-05', 'BackwardCompatible'],
      ['2024-11-05', '2025-06-18', 'LimitedCompatibility'],
    ];
    for (const [client, server, expected] of matrix) {
      expect(checkCompatibility(client, server).kind).toBe(expected);
    }
  });

  it('test_modelscope_hosted_connection', async () => {
    const apiKey = process.env.MODELSCOPE_API_KEY;
    if (apiKey === undefined || apiKey === '') return;
    const serverId = process.env.TEST_SERVER_ID ?? 'test-server';
    const region = process.env.MODELSCOPE_REGION ?? 'cn-hangzhou';
    const transport = await createTransportForConfig({
      type: 'streamable_http',
      url: `https://mcp.modelscope.cn/api/v1/servers/${serverId}/stream`,
      api_key: apiKey,
      oauth: null,
      headers: { 'X-Region': region },
    });
    const probe = new JsonRpcProbe(transport, { timeoutMs: 10_000 });
    probe.start();
    try {
      const server = await probe.initialize();
      expect(server.name).not.toBe('');
    } finally {
      await probe.close();
    }
  });

  it('test_mcpbench_websearch_dataset', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url));
    // Under Electron process.execPath is the GUI binary and the spawner clears the env.
    const runtime = currentStdioRuntime();
    const transport = await createTransportForConfig({
      type: 'stdio',
      command: runtime.command,
      args: [fixture],
      env: runtime.env,
      working_dir: null,
      framing: 'jsonl',
    });
    const probe = new JsonRpcProbe(transport, { timeoutMs: 10_000 });
    probe.start();
    try {
      const server = await probe.initialize();
      expect(server.name).toBe('mcp-test-server');
      const tools = await probe.listToolSpecs();
      expect(tools.map(tool => tool.name)).toContain('web_search');
      const qaPairs: [string, string][] = [
        ['What is the capital of France?', 'Paris'],
        ['Who wrote Romeo and Juliet?', 'William Shakespeare'],
        ['What is the speed of light?', '299,792,458 meters per second'],
      ];
      for (const [question, expected] of qaPairs) {
        const result = await probe.callTool('web_search', { query: question });
        const text = result.content
          .map(content => content.type === 'text' ? content.text : '')
          .join('\n');
        expect(text.toLowerCase()).toContain(expected.toLowerCase());
      }
    } finally {
      await probe.close();
    }
  });
});
