import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { ErrorDetails, ToolContext } from '../api.ts';
import browser from '../../browser/index.ts';
import mcp from '../index.ts';

const hosts: TestHost[] = [];
const closeServers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const close of closeServers.splice(0)) await close();
});

const context: ToolContext = {
  supports_tools: true, mcp_client: null, stream_event: null, stage: 'test', memory_enabled: null,
};
const window = { window: 'main', webview: 'main' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function setup(respond?: RequestListener) {
  const values = new Map<string, string>([
    ['mcp.tools.namespace_prefix', 'remote_'],
    ['session.selected_search_engines', 'searxng'],
    ['web_search.provider_strategies', JSON.stringify({ default: {
      cache_enabled: false, max_retries: 1, timeout_ms: 30_000,
    } })],
  ]);
  const logs: string[] = [];
  if (respond) {
    const server = createServer(respond);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    closeServers.push(() => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
    values.set('web_search.searxng.endpoint', `http://127.0.0.1:${address.port}`);
  }
  const host = await createTestHost({
    plugins: [browser, mcp],
    provide: {
      settings: {
        get: (key: string) => values.get(key) ?? null,
        getSecret: async (key: string) => values.get(key) ?? null,
      },
      storage: {}, featureFlags: {}, llm: {},
      secrets: { openStore: () => ({ getSecret: async () => null }) },
      log: { logger: () => ({
        info: (message: string) => { logs.push(message); }, warn() {}, error() {},
      }) },
    },
  });
  hosts.push(host);
  return { host, logs };
}

function notFound(name: string): ErrorDetails {
  return {
    code: 'TOOL_NOT_FOUND', message: `工具 '${name}' 不存在`,
    user_message: `请求的工具'${name}'未找到，可能已被移除或重命名`,
    suggestions: [{ action_type: 'settings', label: '查看可用工具', url: '#/settings/tools', data: null }],
    trace_id: null, context: null,
  };
}

describe('ToolRegistry::call_tool_with_details through the production MCP/browser providers', () => {
  it('test_tool_error_details_generation', async () => {
    const { host } = await setup();
    const result = await host.ctx.mcp.registry.callToolWithDetails('nonexistent_tool', {}, context);
    const [ok, , error, , , , details] = result;
    // Every assertion in tools_integration_tests.rs:207-215, plus the complete serialized shape.
    expect(ok).toBe(false);
    expect(error).not.toBeNull();
    expect(details).not.toBeNull();
    expect(details!.code).toBe('TOOL_NOT_FOUND');
    expect(details!.message).toContain('nonexistent_tool');
    expect(details!.suggestions.length).toBeGreaterThan(0);
    expect(details!.suggestions[0]!.action_type).toBe('settings');
    expect(result).toEqual([
      false, null, '未知工具: nonexistent_tool', null, null, null, notFound('nonexistent_tool'),
    ]);
    expect(host.eventsNamed('mcp-bridge-request')).toEqual([]);
  });

  it('checks the window before decoding an external name, and local tools before the bridge', async () => {
    const { host } = await setup();
    const name = 'ds_tool_!';
    expect(await host.ctx.mcp.registry.callToolWithDetails(name, {}, context)).toEqual([
      false, null, `未知工具: ${name}`, null, null, null, notFound(name),
    ]);
    expect(await host.ctx.mcp.registry.callToolWithDetails(name, {}, { ...context, window })).toEqual([
      false, null, `无效的外部工具名: ${name}`, null, null, null, notFound(name),
    ]);
    expect(await host.ctx.mcp.registry.callToolWithDetails('web_search', {}, { ...context, window })).toEqual([
      false, null, 'query is empty', { elapsed_ms: 0 }, null, null,
      { code: 'UNKNOWN', message: 'query is empty', user_message: "工具'web_search'执行失败",
        suggestions: [{ action_type: 'retry', label: '重试', url: null, data: null }],
        trace_id: null, context: null },
    ]);
    expect(host.eventsNamed('mcp-bridge-request')).toEqual([]);
  });

  it('preserves the legacy six-tuple and local usage when success has no error', async () => {
    const { host } = await setup();
    const args = { query: 'empty result', top_k: 0 };
    const legacy = await host.ctx.mcp.registry.callTool('web_search', args, context);
    const detailed = await host.ctx.mcp.registry.callToolWithDetails('web_search', args, context);
    expect(legacy).toEqual([true, { raw: {}, provider: 'none' }, null,
      { elapsed_ms: 0, retries: 0, provider_latency_ms: 0, provider: 'none' }, [], null]);
    expect(detailed).toEqual([...legacy, null]);
  });

  it('returns real HTTP search data, usage, citations, injection and source events', async () => {
    let requests = 0;
    const raw = { results: [{ title: 'Test Result 1', url: 'https://example.com/1', content: 'A result' }] };
    const { host } = await setup((_req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(raw));
    });
    const result = await host.ctx.mcp.registry.callToolWithDetails('web_search',
      { query: 'real HTTP result', force_engine: 'searxng' }, { ...context, window, stream_event: 'details' });
    expect(requests).toBe(1);
    expect(result).toHaveLength(7);
    expect(result[0]).toBe(true);
    expect(result[1]).toEqual({ raw, provider: 'searxng' });
    expect(result[2]).toBeNull();
    expect(result[3]).toEqual({ elapsed_ms: expect.any(Number), provider_latency_ms: expect.any(Number), provider: 'searxng' });
    expect(result[4]).toHaveLength(1);
    expect(result[4]![0]).toMatchObject({ documentId: 'https://example.com/1', fileName: 'Test Result 1', chunkIndex: 0 });
    expect(result[5]).toContain('Test Result 1');
    expect(result[6]).toBeNull();
    expect(host.eventsNamed('details_web_search')).toHaveLength(1);
    expect(host.eventsNamed('mcp-bridge-request')).toEqual([]);
  });

  it.each([
    ['API key missing; timeout; network', 'API_KEY_MISSING'],
    ['invalid api_key; timeout', 'API_KEY_INVALID'],
    ['timeout; network; rate limit', 'NETWORK_TIMEOUT'],
    ['network; rate limit', 'NETWORK_UNREACHABLE'],
    ['rate limit; quota', 'RATE_LIMIT'],
    ['quota; parse', 'QUOTA_EXCEEDED'],
    ['parse; not found', 'PARSE_ERROR'],
    ['not found; disabled', 'TOOL_NOT_FOUND'],
    ['disabled', 'TOOL_DISABLED'],
    ['upstream failure', 'UNKNOWN'],
  ] as const)('classifies real provider failures in Rust order: %s', async (message, code) => {
    const { host } = await setup((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    });
    const result = await host.ctx.mcp.registry.callToolWithDetails('web_search',
      { query: message, force_engine: 'searxng' }, context);
    const error = `provider error: searxng http 400 Bad Request: ${message}`;
    const details = result[6]!;
    expect(result.slice(0, 3)).toEqual([false, null, error]);
    expect(result[3]).toEqual({ elapsed_ms: expect.any(Number) });
    expect(result.slice(4, 6)).toEqual([null, null]);
    expect(details.code).toBe(code);
    const expected = code === 'API_KEY_MISSING'
      ? { message: 'web_search API key is not configured', user_message: 'Configure the web_search API key in Settings before using this feature',
        suggestions: [{ action_type: 'settings', label: 'Open Settings', url: '#/settings', data: { section: 'web_search' } }] }
      : code === 'API_KEY_INVALID'
        ? { message: 'web_search API密钥无效或已过期', user_message: 'web_search的API密钥似乎无效，请检查密钥是否正确',
          suggestions: [{ action_type: 'settings', label: '检查API密钥', url: '#/settings', data: { section: 'web_search' } },
            { action_type: 'retry', label: '重试', url: null, data: null }] }
        : code === 'NETWORK_UNREACHABLE'
          ? { message: `网络连接失败: ${error}`, user_message: '网络连接出现问题，请检查网络连接后重试',
            suggestions: [{ action_type: 'check_network', label: '检查网络', url: null, data: null },
              { action_type: 'retry', label: '重试', url: null, data: null }] }
          : code === 'RATE_LIMIT'
            ? { message: 'web_search 限流', user_message: 'web_search请求过于频繁，请稍后重试',
              suggestions: [{ action_type: 'retry', label: '稍后重试', url: null, data: null }] }
            : { message: error, user_message: "工具'web_search'执行失败",
              suggestions: [{ action_type: 'retry', label: '重试', url: null, data: null }] };
    expect(details).toEqual({ code, ...expected, trace_id: null, context: null });
  });

  it.each([
    ['TOOL NOT FOUND; timeout; rate limit; connection', 'TOOL_NOT_FOUND'],
    ['TIMEOUT; rate limit; network', 'TOOL_TIMEOUT'],
    ['RATE LIMIT; connection', 'RATE_LIMIT'],
    ['CONNECTION failed', 'NETWORK_UNREACHABLE'],
    ['TRANSPORT failed', 'NETWORK_UNREACHABLE'],
    ['NETWORK failed', 'NETWORK_UNREACHABLE'],
    ['Too many requests', 'SERVICE_UNAVAILABLE'],
    ['MCP 调用超时', 'SERVICE_UNAVAILABLE'],
  ] as const)('uses the distinct frontend error order: %s', async (error, code) => {
    const { host, logs } = await setup();
    const pending = host.ctx.mcp.registry.callToolWithDetails('mcp_remote_fetch', {}, { ...context, window });
    const request = host.eventsNamed('mcp-bridge-request')[0] as { correlationId: string; tool: string };
    expect(request.tool).toBe('fetch');
    host.emitFrontend(`mcp-bridge-response:${request.correlationId}`, { ok: false, error, data: { partial: true }, usage: { tokens: 2 } }, window);
    const result = await pending;
    expect(result.slice(0, 3)).toEqual([false, { partial: true }, error]);
    expect(result[3]).toEqual({ tokens: 2, bridge: 'frontend', trace_id: expect.stringMatching(uuid), tool_name: 'fetch', source: 'mcp' });
    expect(result.slice(4, 6)).toEqual([null, null]);
    expect(result[6]!.code).toBe(code);
    expect(result[6]!.trace_id).toBeNull();
    expect(logs).toContain("Local tool 'mcp_remote_fetch' not found, bridging to Frontend MCP (details) with name 'fetch'");
    if (code === 'TOOL_NOT_FOUND') expect(result[6]).toEqual(notFound('fetch'));
    if (code === 'TOOL_TIMEOUT') expect(result[6]).toEqual({
      code, message: "工具 'fetch' 执行超时", user_message: '工具执行时间超过15000毫秒限制',
      suggestions: [{ action_type: 'retry', label: '重试', url: null, data: null }],
      trace_id: null, context: { timeout_ms: 15000 },
    });
    if (code === 'RATE_LIMIT') expect(result[6]).toEqual({
      code, message: 'fetch 限流', user_message: 'fetch请求过于频繁，请稍后重试',
      suggestions: [{ action_type: 'retry', label: '稍后重试', url: null, data: null }],
      trace_id: null, context: null,
    });
    if (code === 'NETWORK_UNREACHABLE') expect(result[6]).toEqual({
      code, message: `网络连接失败: ${error}`, user_message: '网络连接出现问题，请检查网络连接后重试',
      suggestions: [{ action_type: 'check_network', label: '检查网络', url: null, data: null },
        { action_type: 'retry', label: '重试', url: null, data: null }],
      trace_id: null, context: null,
    });
    if (code === 'SERVICE_UNAVAILABLE') expect(result[6]).toEqual({
      code, message: 'fetch 服务当前不可用', user_message: 'fetch服务暂时不可用，可能正在维护中',
      suggestions: [{ action_type: 'retry', label: '稍后重试', url: null, data: null },
        { action_type: 'contact_support', label: '联系支持', url: null, data: { service: 'fetch' } }],
      trace_id: null, context: null,
    });
  });

  it('frontend details follow error presence, not ok; malformed ok wins over error classification', async () => {
    const { host } = await setup();
    for (const [payload, expectedCode] of [
      [{ ok: true, data: 'success' }, null],
      [{ ok: false }, null],
      [{ ok: true, error: 'tool not found' }, 'TOOL_NOT_FOUND'],
      [{ ok: 'false', error: 'tool not found' }, 'SERVICE_UNAVAILABLE'],
    ] as const) {
      const pending = host.ctx.mcp.registry.callToolWithDetails('remote_fetch', {}, { ...context, window });
      const request = host.eventsNamed('mcp-bridge-request').at(-1) as { correlationId: string };
      host.emitFrontend(`mcp-bridge-response:${request.correlationId}`, payload, window);
      const result = await pending;
      expect(result[6]?.code ?? null).toBe(expectedCode);
      if (typeof payload.ok === 'boolean') {
        expect(result[0]).toBe(payload.ok);
        expect(result[1]).toBe('data' in payload ? payload.data : null);
        expect(result[2]).toBe('error' in payload ? payload.error : null);
        expect(result[3]).toEqual({ bridge: 'frontend', trace_id: expect.stringMatching(uuid), tool_name: 'fetch', source: 'mcp' });
        expect(result.slice(4, 6)).toEqual([null, null]);
      }
      else expect(result.slice(0, 6)).toEqual([false, null, 'MCP 响应格式无效：缺少 ok 字段', null, null, null]);
    }
  });

  it('local deadline aborts the real HTTP request and reports ToolTimeout before classifying its message', async () => {
    let received!: () => void;
    let disconnected!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    const requestDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
    const { host } = await setup((_req, res) => {
      res.on('close', disconnected);
      received();
    });
    const pending = host.ctx.mcp.registry.callToolWithDetails('web_search',
      { query: 'registry deadline', force_engine: 'searxng' }, context);
    await requestReceived;
    const result = await pending;
    expect(result.slice(0, 3)).toEqual([false, null, 'tool timeout']);
    expect(result[3]).toEqual({ elapsed_ms: expect.any(Number) });
    expect((result[3] as { elapsed_ms: number }).elapsed_ms).toBeGreaterThanOrEqual(15_000);
    expect(result.slice(4, 6)).toEqual([null, null]);
    expect(result[6]).toEqual({ code: 'TOOL_TIMEOUT', message: "工具 'web_search' 执行超时",
      user_message: '工具执行时间超过15000毫秒限制',
      suggestions: [{ action_type: 'retry', label: '重试', url: null, data: null }],
      trace_id: null, context: { timeout_ms: 15000 } });
    await requestDisconnected;
  }, 30_000);
});
