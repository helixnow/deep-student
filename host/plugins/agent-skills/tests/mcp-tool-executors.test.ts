import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { mcpEntryRevision } from '../api.ts';
import {
  createMcpConnectionTester, McpManageToolExecutor, McpProposeToolExecutor, runConnectionTest, type McpConnectionTester,
} from '../src/tools/mcp-tool-executors.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import plugin from '../index.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { vi.useRealTimers(); await cleanup?.(); cleanup = null; });

async function fixture(tester: McpConnectionTester | null = null) {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  const emitted: unknown[] = [], warnings: string[] = [];
  const deps = { settings: () => settings, events: () => ({ emit: (event: string, payload: unknown) => emitted.push([event, payload]) }) as never,
    tester: () => tester, warn: (message: string) => warnings.push(message) };
  const events: unknown[][] = [], saved: ToolResultInfo[] = [];
  const ctx = { session_id: 'sess_1', block_id: 'blk',
    emitToolCallStart: (...args: unknown[]) => events.push(['start', ...args]),
    emitToolCallEnd: (payload: unknown) => events.push(['end', payload]),
    emitToolCallError: (error: string) => events.push(['error', error]),
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); } } as unknown as ExecutionContext;
  const propose = new McpProposeToolExecutor(deps), manage = new McpManageToolExecutor(deps);
  const call = (executor: McpProposeToolExecutor | McpManageToolExecutor, name: string, args: unknown) =>
    executor.execute({ id: `call_${name}`, name, arguments: args }, ctx);
  const list = async () => JSON.parse((await settings.getSecret('mcp.tools.list')) ?? '[]') as Record<string, unknown>[];
  return { settings, propose, manage, call, list, emitted, events, saved, warnings };
}

const okTester = (seen: unknown[] = []): McpConnectionTester => ({
  testStdio: async (command, args, env) => { seen.push(['stdio', command, args, env]); return { success: true, tools: [{}, {}] }; },
  testWebSocket: async url => { seen.push(['ws', url]); return { success: true, tools: [] }; },
  testSse: async url => { seen.push(['sse', url]); return { success: true }; },
  testHttp: async url => { seen.push(['http', url]); return { success: true }; },
  testStreamableHttp: async url => { seen.push(['streamable', url]); return { success: true }; },
});

describe('mcp_propose_executor.rs / mcp_manage_executor.rs chat executors', () => {
  it('propose writes a disabled pending_secrets entry, provenance and the settings-changed event', async () => {
    const f = await fixture();
    expect([f.propose.canHandle('builtin-mcp_server_propose'), f.propose.canHandle('mcp_mcp_server_propose'), f.propose.sensitivityLevel()])
      .toEqual([true, false, 'high']);
    const result = await f.call(f.propose, 'builtin-mcp_server_propose', { name: 'brave', transport: 'STDIO', command: 'npx',
      args: ['-y', '@pkg'], env_required: ['BRAVE_API_KEY'], purpose: 'search' });
    expect(result).toMatchObject({ success: true, toolCallId: 'call_builtin-mcp_server_propose', blockId: 'blk' });
    expect(Object.keys(result.output as object)).toEqual(['status', 'message', 'server', 'env_required', 'settings_key']);
    expect(result.output).toMatchObject({ status: 'pending_secrets', env_required: ['BRAVE_API_KEY'], settings_key: 'mcp.tools.list',
      message: 'Configuration written (disabled). Open Settings > MCP Tools, fill env variables [BRAVE_API_KEY], then enable the server.',
      server: { id: 'brave', name: 'brave', transport: 'stdio', enabled: false, command: 'npx', args: ['-y', '@pkg'] } });
    expect(await f.list()).toEqual([{ id: 'brave', name: 'brave', transportType: 'stdio', enabled: false, command: 'npx',
      args: ['-y', '@pkg'], env: { BRAVE_API_KEY: '<REQUIRED>' } }]);
    expect(JSON.parse(f.settings.get('mcp.propose.provenance.brave')!)).toMatchObject({ server_id: 'brave', purpose: 'search',
      session_id: 'sess_1', transport: 'stdio', enabled_on_install: false });
    expect(f.emitted).toEqual([['chat_v2://settings_changed', { action: 'mcp_server_propose', key: 'mcp.tools.list' }]]);
    expect(f.events.map(event => event[0])).toEqual(['start', 'end']);
    expect(f.saved).toEqual([result]);

    const duplicate = await f.call(f.propose, 'mcp_server_propose', { name: 'BRAVE', transport: 'sse', url: 'https://x.dev/sse', purpose: 'p' });
    expect(duplicate).toMatchObject({ success: false, error: "MCP server identity 'brave' is already configured", output: null });
    expect(f.events.at(-1)).toEqual(['error', "MCP server identity 'brave' is already configured"]);
  });

  it('without MCP probes a live-test proposal takes the no-mcp-feature branch and rolls back only its own entry', async () => {
    const f = await fixture();
    const result = await f.call(f.propose, 'mcp_server_propose', { name: 'fs', transport: 'stdio', command: 'node', purpose: 'files' });
    expect(result.error).toBe('MCP connection test failed: MCP 功能未启用（当前构建未包含 mcp feature）. '
      + 'Configuration has been rolled back without changing concurrent MCP entries.');
    expect(await f.list()).toEqual([]);
    expect(f.settings.get('mcp.propose.provenance.fs')).toBeNull();
  });

  it('a successful probe installs the server; placeholders never reach the child env', async () => {
    const seen: unknown[] = [];
    const f = await fixture(okTester(seen));
    const result = await f.call(f.propose, 'mcp_server_propose', { name: 'fs', transport: 'stdio', command: 'node', args: ['srv.js'], purpose: 'files' });
    expect(result.output).toMatchObject({ status: 'installed_and_tested', test: { success: true, transport: 'stdio', tools_count: 2 },
      message: "MCP server 'fs' added and connection test succeeded (2 tools discovered)." });
    expect(await runConnectionTest(okTester(seen), 'stdio', { command: 'npx', args: ['a', 1], env: { A: '<REQUIRED>', B: 'v' } }))
      .toEqual({ success: true, tools: [{}, {}] });
    expect(seen.at(-1)).toEqual(['stdio', 'npx', ['a'], { B: 'v' }]);
  });

  it('the tester forwards to the mcp probes with the Rust executor arguments (no cwd/framing/api key/headers)', async () => {
    const calls: unknown[][] = [];
    const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { success: true }; };
    const log = vi.fn();
    const tester = createMcpConnectionTester({ testStdio: record('stdio'), testSse: record('sse'), testHttp: record('http'),
      testWebSocket: record('ws'), testStreamableHttpRmcp: record('streamable') } as never, log);
    await tester.testStdio('node', ['srv.js'], { B: 'v' });
    await tester.testSse('https://sse');
    await tester.testHttp('https://http');
    await tester.testWebSocket('wss://ws');
    await tester.testStreamableHttp('https://stream');
    expect(calls).toEqual([
      ['stdio', 'node', ['srv.js'], { B: 'v' }, null, null, expect.any(Function), log],
      ['sse', 'https://sse', null, null, log], ['http', 'https://http', null, null, log],
      ['ws', 'wss://ws'], ['streamable', 'https://stream', null],
    ]);
  });

  it('the installed plugin probes live: a failing stdio server rolls back with the probe error', async () => {
    const host = await createTestHost({ plugins: [pathsPlugin, plugin],
      provide: { settings: memorySettings(), storage: unavailableStorage() } });
    try {
      const propose = host.ctx.agentTools.toolExecutors().find(executor => executor.name() === 'McpProposeExecutor')!;
      const ctx = { session_id: 'sess_live', block_id: 'blk', emitToolCallStart() {}, emitToolCallEnd() {},
        emitToolCallError() {}, saveToolBlock() {} } as unknown as ExecutionContext;
      const result = await propose.execute!({ id: 'call_live', name: 'builtin-mcp_server_propose', arguments: {
        name: 'missing', transport: 'stdio', command: '/nonexistent/dstu-mcp-server', purpose: 'probe' } }, ctx) as ToolResultInfo;
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^MCP connection test failed: /);
      expect(result.error).not.toContain('MCP 功能未启用');
      expect(result.error).toContain('Configuration has been rolled back');
    } finally { await host.dispose(); }
  });

  it('times a hung probe out after the Rust per-transport budget', async () => {
    vi.useFakeTimers();
    const hung = { ...okTester(), testSse: () => new Promise<unknown>(() => {}), testStdio: () => new Promise<unknown>(() => {}) };
    const sse = runConnectionTest(hung, 'sse', { url: 'https://x' });
    const stdio = runConnectionTest(hung, 'stdio', { command: 'x' });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(stdio).resolves.toEqual({ success: false, error: 'connection test timed out after 15s' });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(sse).resolves.toEqual({ success: false, error: 'connection test timed out after 30s' });
  });

  it('manage set_enabled / remove run through the shared list with Rust sensitivity and errors', async () => {
    const f = await fixture();
    const entry = { id: 'brave', name: 'Brave', transportType: 'stdio', enabled: true, command: 'npx', args: [], env: { K: '<REQUIRED>' } };
    await f.settings.saveSecret('mcp.tools.list', JSON.stringify([entry]));
    expect(['mcp_server_update', 'builtin-mcp_server_set_enabled', 'mcp_server_remove'].map(name => f.manage.sensitivityLevel(name)))
      .toEqual(['high', 'medium', 'high']);
    expect((await f.call(f.manage, 'mcp_server_set_enabled', { server_id: 'brave', enabled: true })).error)
      .toBe("Cannot enable 'brave': env variables [K] are not filled yet. Ask the user to fill them in Settings > MCP Tools first.");
    const disabled = await f.call(f.manage, 'builtin-mcp_server_set_enabled', { server_id: 'brave', enabled: false });
    expect(disabled.output).toMatchObject({ server_id: 'brave', enabled: false, previous_enabled: true });
    const stale = await f.call(f.manage, 'mcp_server_remove', { server_id: 'brave', expected_transport: 'stdio', expected_entry_revision: mcpEntryRevision(entry) });
    expect(stale.error).toBe("MCP server 'brave' changed after removal approval. Re-run self_inspect (section=mcp) and retry with the current entry_revision.");
    const current = (await f.list())[0];
    const removed = await f.call(f.manage, 'mcp_server_remove', { server_id: 'brave', expected_transport: 'stdio', expected_entry_revision: mcpEntryRevision(current) });
    expect(removed.output).toMatchObject({ removed: true, server_id: 'brave', name: 'Brave', transport: 'stdio' });
    expect(await f.list()).toEqual([]);
    expect(f.emitted.map(item => (item as [string, { action: string }])[1].action)).toEqual(['mcp_server_set_enabled', 'mcp_server_remove']);
  });
});
