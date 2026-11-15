import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMobileHttp } from '../../../platform/http/mobile.ts';
import { startMcpService } from '../equivalence/mcp-service.ts';
import mobileMcp from '../mobile.ts';

it('probes a real configured HTTP, SSE and WebSocket MCP server and calls a tool from the Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dstu-mobile-mcp-'));
  const server = await startMcpService({ logDir: root });
  const values = new Map<string, string>();
  const host = await createTestHost({
    app: { dataDir: root },
    plugins: [mobileMcp],
    provide: {
      http: createMobileHttp(),
      settings: { get: (key: string) => values.get(key) ?? null },
      log: { logger: () => ({ info() {}, warn() {}, error() {} }) },
      webSearch: {},
    },
  });
  try {
    const endpoints = [
      ['test_mcp_http', { endpoint: server.httpUrl('success'), apiKey: '' }],
      ['test_mcp_sse', { endpoint: server.sseUrl('success'), apiKey: '' }],
      ['test_mcp_websocket', { url: server.wsUrl('success') }],
    ] as const;
    for (const [command, args] of endpoints) {
      expect(await host.invoke(command, args)).toMatchObject({
        success: true, tools_preview: expect.arrayContaining([expect.objectContaining({ name: 'echo_args' })]),
      });
    }

    values.set('mcp.mode', 'backend');
    values.set('mcp.tools.list', JSON.stringify([{
      transportType: 'streamable_http', url: server.httpUrl('success'),
    }]));
    expect(await host.invoke('reload_mcp_client')).toMatchObject({ success: true });
    const service = host.ctx.get('mcp');
    const client = await service?.getGlobalClient();
    if (!client) throw new Error('Expected a connected MCP client');
    const { content, isError } = await client.callTool('echo_args', { message: '学习' });
    expect(isError).not.toBe(true);
    const wire = content[1];
    if (wire?.type !== 'text') throw new Error('Expected the reference server to echo the wire request');
    expect(JSON.parse(wire.text)).toMatchObject({
      method: 'tools/call', params: { name: 'echo_args', arguments: { message: '学习' } },
    });
  } finally {
    await host.dispose();
    await server.stop();
  }
});
