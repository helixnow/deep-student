import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type PendingInvoke, type TestHost } from '../../../kernel/testing.ts';
import type { WindowRef } from '../../../kernel/api.ts';
// boundary-allow cross-plugin-impl: V02-05 装载真实 L02 llm 插件，经它发布的 llmMcpTools 观察两条命令
import { createTestHost as createLlmTestHost } from '../../llm/tests/host.ts';
// boundary-allow cross-plugin-impl: V02-05 装载真实 L02 llm 插件，经它发布的 llmMcpTools 观察两条命令
import llm from '../../llm/index.ts';
import mcp from '../index.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

const SETTINGS_WINDOW: WindowRef = { window: 'settings', webview: 'settings' };
const quietLogger = () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} });

async function setupWithRealLlm(): Promise<TestHost> {
  const values = new Map<string, string>();
  const host = await createLlmTestHost({
    plugins: [llm, mcp],
    source: SETTINGS_WINDOW,
    provide: {
      settings: {
        get: (key: string) => values.get(key) ?? null,
        save: (key: string, value: string) => { values.set(key, value); },
        getSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => false,
      },
      secrets: {
        isEncryptedFormat: () => false,
        openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }),
        openStore: () => ({ saveSecret: async () => undefined, getSecret: async () => null, deleteSecret: async () => undefined }),
      },
      log: { logger: quietLogger },
      webSearch: {},
    },
  });
  hosts.push(host);
  return host;
}

/** Waits for request number `index` (0-based) of llm's frontend tool discovery, failing early if the invoke settles first. */
async function toolsRequest(host: TestHost, pending: PendingInvoke, index: number): Promise<string> {
  const settledFirst = pending.result.then(
    value => { throw new Error(`invoke settled before asking the window for tools: ${JSON.stringify(value)}`); },
    (error: unknown) => { throw new Error(`invoke failed before asking the window for tools: ${JSON.stringify(error)}`); },
  );
  await Promise.race([
    vi.waitFor(() => { expect(host.eventsNamed('mcp-bridge-tools-request').length).toBeGreaterThan(index); }),
    settledFirst,
  ]);
  return (host.eventsNamed('mcp-bridge-tools-request')[index] as { correlationId: string }).correlationId;
}

/** `src/mcp/mcpService.ts:1793-1798`: the page answers with `{ correlationId, tools }`; here only to the calling window. */
function answerTools(host: TestHost, correlationId: string, tools: { name: string; description: string; input_schema: unknown }[]): void {
  host.emitFrontend(`mcp-bridge-tools-response:${correlationId}`, { correlationId, tools },
    SETTINGS_WINDOW, { kind: 'Window', label: SETTINGS_WINDOW.window });
}

const ECHO = { name: 'echo', description: '', input_schema: {} };
const ADD = { name: 'add', description: 'Add two numbers', input_schema: { type: 'object' } };

describe('V02-05: reload_mcp_client / preheat_mcp_tools with the real llm plugin (no stand-in)', () => {
  it('V02-05: preheat_mcp_tools asks the calling window through llmMcpTools and returns { ok: true, count } like cmd/mcp.rs:822-829', async () => {
    const host = await setupWithRealLlm();
    const pending = host.startInvoke('preheat_mcp_tools', {});
    answerTools(host, await toolsRequest(host, pending, 0), [ECHO, ADD]);
    expect(await pending.result).toEqual({ ok: true, count: 2 });
  });

  it('V02-05: reload_mcp_client clears the real tool cache and returns the cmd/mcp.rs:785-789 payload', async () => {
    const host = await setupWithRealLlm();
    const first = host.startInvoke('preheat_mcp_tools', {});
    answerTools(host, await toolsRequest(host, first, 0), [ECHO]);
    expect(await first.result).toEqual({ ok: true, count: 1 });
    expect(await host.invoke('preheat_mcp_tools', {})).toEqual({ ok: true, count: 1 });
    expect(host.eventsNamed('mcp-bridge-tools-request')).toHaveLength(1);

    expect(await host.invoke('reload_mcp_client', {})).toEqual({
      success: true, message: 'Backend MCP disabled; frontend SDK in use',
    });
    const refill = host.startInvoke('preheat_mcp_tools', {});
    answerTools(host, await toolsRequest(host, refill, 1), [ECHO, ADD]);
    expect(await refill.result).toEqual({ ok: true, count: 2 });
  });
});

interface McpToolsPort {
  clearCalls: number;
  preheatWindows: WindowRef[];
  clear(): void;
  preheat(window: WindowRef): Promise<number>;
}

function mcpToolsPort(count = 0): McpToolsPort {
  const port: McpToolsPort = {
    clearCalls: 0,
    preheatWindows: [],
    clear() { port.clearCalls += 1; },
    async preheat(window) { port.preheatWindows.push(window); return count; },
  };
  return port;
}

/** `llmMcpTools: null` leaves the service out, as when dstu.llm is not running. */
async function setup(options: { llmMcpTools?: unknown; source?: WindowRef } = {}): Promise<TestHost> {
  const tools = options.llmMcpTools === undefined ? mcpToolsPort() : options.llmMcpTools;
  const host = await createTestHost({
    plugins: [mcp],
    provide: {
      settings: { get: () => null, save: () => undefined },
      secrets: {
        openStore: () => ({
          saveSecret: async () => undefined,
          getSecret: async () => null,
          deleteSecret: async () => undefined,
        }),
      },
      ...(tools === null ? {} : { llmMcpTools: tools }),
      log: { logger: () => undefined },
      webSearch: {
        doSearch: async () => ({
          name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [],
        }),
      },
    },
    ...(options.source === undefined ? {} : { source: options.source }),
  });
  hosts.push(host);
  return host;
}

describe('cmd/mcp.rs reload_mcp_client and preheat_mcp_tools', () => {
  it('reload_mcp_client clears the LLMManager MCP tool cache before returning the Rust payload', async () => {
    const tools = mcpToolsPort();
    const host = await setup({ llmMcpTools: tools });
    expect(await host.invoke('reload_mcp_client')).toEqual({
      success: true, message: 'Backend MCP disabled; frontend SDK in use',
    });
    expect(tools.clearCalls).toBe(1);
  });

  it('preheat_mcp_tools refills the cache for the calling window and returns its count', async () => {
    const tools = mcpToolsPort(4);
    const source: WindowRef = { window: 'settings', webview: 'settings' };
    const host = await setup({ llmMcpTools: tools, source });
    expect(await host.invoke('preheat_mcp_tools')).toEqual({ ok: true, count: 4 });
    expect(tools.preheatWindows).toEqual([source]);
  });

  it('fails closed instead of reporting success when the llmMcpTools service is missing', async () => {
    const host = await setup({ llmMcpTools: null });
    await expect(host.invoke('reload_mcp_client')).rejects.toEqual({
      error_type: 'Unknown',
      message: 'llmMcpTools 服务不可用（dstu.llm 未就绪），无法执行 MCP 工具缓存清理/预热',
      details: null,
    });
    await expect(host.invoke('preheat_mcp_tools')).rejects.toEqual({
      error_type: 'Unknown',
      message: 'llmMcpTools 服务不可用（dstu.llm 未就绪），无法执行 MCP 工具缓存清理/预热',
      details: null,
    });
  });

  it('propagates a real cache failure as an internal IPC error', async () => {
    const host = await setup({
      llmMcpTools: {
        clear: () => { throw new Error('cache store unavailable'); },
        preheat: async () => { throw new Error('bridge timeout'); },
      },
    });
    await expect(host.invoke('reload_mcp_client')).rejects.toEqual({
      error_type: 'Unknown', message: 'cache store unavailable', details: null,
    });
    await expect(host.invoke('preheat_mcp_tools')).rejects.toEqual({
      error_type: 'Unknown', message: 'bridge timeout', details: null,
    });
  });
});
