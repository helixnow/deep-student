import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import mcp from '../index.ts';
import { defaultMcpConfig, shouldAdvertiseTool } from '../src/config.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function setup(initial: [string, string][] = []) {
  const values = new Map(initial);
  const writes: [string, string][] = [];
  const host = await createTestHost({ plugins: [mcp], provide: {
    settings: {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { writes.push([key, value]); values.set(key, value); },
    },
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
  return { host, values, writes };
}
describe('MCP config commands', () => {
  it('loads default config and respects blacklist before whitelist', async () => {
    const { host } = await setup();
    expect(await host.invoke('get_mcp_config')).toEqual(defaultMcpConfig());
    const config = defaultMcpConfig();
    expect(shouldAdvertiseTool(config, 'x')).toBe(true);
    config.tools.blacklist = ['x'];
    expect(shouldAdvertiseTool(config, 'x')).toBe(false);
    config.tools.advertise_all_tools = false;
    config.tools.whitelist = ['x', 'y'];
    expect(shouldAdvertiseTool(config, 'x')).toBe(false);
    expect(shouldAdvertiseTool(config, 'y')).toBe(true);
    expect(shouldAdvertiseTool(config, 'z')).toBe(false);
  });
  it('matches removed import/export Validation errors', async () => {
    const { host } = await setup();
    await expect(host.invoke('import_mcp_config', { path: 'ignored' })).rejects.toEqual({ error_type: 'Validation', message: 'Import functionality has been removed', details: null });
    await expect(host.invoke('export_mcp_config', { config: defaultMcpConfig(), format: 'ignored' })).rejects.toEqual({ error_type: 'Validation', message: 'Export functionality has been removed', details: null });
  });
  it('keeps backend-disabled status including message-level enabling and distinct resolution default', async () => {
    const { host, values } = await setup();
    expect(await host.invoke('get_mcp_tools')).toEqual([]);
    expect(await host.invoke('get_mcp_status')).toEqual({
      available: false, enabled: false, connected: false, enabled_reason: null, server_info: null, tools_count: 0,
      last_error: 'backend_mcp_disabled', namespace_prefix: '', conflict_resolution: 'use_namespace',
      cache_state: { ttl_ms: 300000, last_built_at: null },
    });
    values.set('session.selected_mcp_tools', '[]');
    expect(await host.invoke('get_mcp_status')).toMatchObject({ enabled: true, enabled_reason: null });
    values.set('session.selected_mcp_tools', ' \n');
    values.set('mcp.tools.cache_ttl_ms', ' 12');
    expect(await host.invoke('get_mcp_status')).toMatchObject({ enabled: false, enabled_reason: '会话未选择MCP工具', cache_state: { ttl_ms: 300000 } });
  });
  it('uses only first tools-list entry, preserves present-null aliases, and does not fall back for malformed list', async () => {
    const { host, values } = await setup([
      ['mcp.transport.type', 'websocket'], ['mcp.transport.url', 'ws://legacy'],
      ['mcp.tools.list', JSON.stringify([{ enabled: false, transportType: 'stdio', command: 'node', args: [' a ', '', 1], env: { A: 'v', B: 1 }, cwd: null, workingDir: '/ignored', framing: 'CONTENT-LENGTH' }])],
    ]);
    expect(await host.invoke('get_mcp_config')).toMatchObject({ enabled: false, transport: { type: 'stdio', command: 'node', args: ['a'], env: { A: 'v' }, framing: 'content_length' } });
    expect((await host.invoke('get_mcp_config') as { transport: object }).transport).not.toHaveProperty('working_dir');
    values.set('mcp.tools.list', 'broken');
    expect((await host.invoke('get_mcp_config') as { transport: object }).transport).toEqual(defaultMcpConfig().transport);
    values.delete('mcp.tools.list');
    expect(await host.invoke('get_mcp_config')).toMatchObject({ transport: { type: 'websocket', url: 'ws://legacy', env: {} } });
  });
  it('saves only Rust-recognized fields, filters array strings without trimming and has no transaction', async () => {
    const { host, writes } = await setup();
    expect(await host.invoke('save_mcp_config', { config: { enabled: true, transport: { type: 'stdio', command: 'node', args: [' a ', 2, '', 'b'], cwd: 'ignored' }, tools: { cache_ttl_ms: 12, advertise_all_tools: false, whitelist: [' x ', false], blacklist: [] }, performance: { timeout_ms: -1, cache_max_size: 0 } } })).toBe(true);
    expect(writes).toEqual([
      ['mcp.transport.type', 'stdio'], ['mcp.transport.command', 'node'], ['mcp.transport.args', ' a ,,b'],
      ['mcp.tools.cache_ttl_ms', '12'], ['mcp.tools.advertise_all_tools', 'false'], ['mcp.tools.whitelist', ' x '],
      ['mcp.tools.blacklist', ''], ['mcp.performance.cache_max_size', '0'],
    ]);
  });
});
