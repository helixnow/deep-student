import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import mcp from '../index.ts';
import type { ToolContext } from '../api.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

const WINDOW: WindowRef = { window: 'settings', webview: 'settings' };

async function setup(): Promise<TestHost> {
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
      llm: {},
      log: { logger: () => undefined },
      webSearch: {
        doSearch: async () => ({
          name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [],
        }),
      },
    },
  });
  hosts.push(host);
  return host;
}

function toolContext(): ToolContext {
  return {
    supports_tools: true,
    mcp_client: null,
    stream_event: null,
    stage: null,
    memory_enabled: null,
    window: WINDOW,
  };
}

function bridgeRequests(host: TestHost): Array<Record<string, unknown>> {
  return host.eventsNamed('mcp-bridge-request') as Array<Record<string, unknown>>;
}

function listenerCount(host: TestHost, event: string): number {
  const events = host.ctx.backendEvents as unknown as {
    _listeners: Map<string, Set<unknown>>;
  };
  return events._listeners.get(event)?.size ?? 0;
}

describe('MCP frontend bridge (dstu-mcp/src/tools/mod.rs call_frontend_mcp_tool)', () => {
  it('emits the Rust payload and applies response, usage and trace semantics', async () => {
    const host = await setup();
    const call = host.ctx.mcp.registry.callTool(
      'fetch:url',
      { _serverId: 'server-a', _timeoutMs: 5_000, url: 'https://example.com/' },
      toolContext(),
    );

    const requests = bridgeRequests(host);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(host.events.find(entry => entry.event === 'mcp-bridge-request')?.target)
      .toEqual({ kind: 'Window', label: 'settings' });
    expect(request.tool).toBe('fetch:url');
    expect(request.serverId).toBe('server-a');
    expect(request.args).toEqual({ url: 'https://example.com/' });
    expect(request.timeoutMs).toBe(5_000);
    expect(String(request.correlationId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const event = `mcp-bridge-response:${String(request.correlationId)}`;
    host.emitFrontend(event, JSON.stringify({
      ok: true,
      data: { content: [{ type: 'text', text: 'bridged' }] },
      usage: { input_tokens: 3 },
    }), WINDOW, { kind: 'Any' });

    const invocation = await call;
    expect(invocation[0]).toBe(true);
    expect(invocation[1]).toEqual({ content: [{ type: 'text', text: 'bridged' }] });
    expect(invocation[2]).toBeNull();
    const usage = invocation[3] as Record<string, unknown>;
    expect(usage).toMatchObject({
      input_tokens: 3,
      bridge: 'frontend',
      tool_name: 'fetch:url',
      source: 'mcp-frontend',
    });
    expect(typeof usage.trace_id).toBe('string');
    expect(invocation[4]).toBeNull();
    expect(invocation[5]).toBeNull();
    expect(listenerCount(host, event)).toBe(0);
  });

  it('delivers a directed response only to the target window', async () => {
    const host = await setup();
    const call = host.ctx.mcp.registry.callTool(
      'fetch:url', { url: 'https://example.com/' }, toolContext(),
    );
    const request = bridgeRequests(host)[0]!;
    const event = `mcp-bridge-response:${String(request.correlationId)}`;

    host.emitFrontend(
      event, { ok: true, data: { content: [{ type: 'text', text: 'wrong' }] } },
      { window: 'other', webview: 'other' }, { kind: 'Window', label: 'other' },
    );
    host.emitFrontend(
      event, { ok: true, data: { content: [{ type: 'text', text: 'right' }] } },
      WINDOW, { kind: 'Window', label: 'settings' },
    );

    const invocation = await call;
    expect(invocation[0]).toBe(true);
    expect(invocation[1]).toEqual({ content: [{ type: 'text', text: 'right' }] });
    expect(listenerCount(host, event)).toBe(0);
  });

  it('defaults the timeout to 180s and keeps a missing serverId null', async () => {
    const host = await setup();
    const call = host.ctx.mcp.registry.callTool(
      'mcp_fetch:url', { url: 'https://example.com/' }, toolContext(),
    );
    const request = bridgeRequests(host)[0]!;
    expect(request.tool).toBe('fetch:url');
    expect(request.serverId).toBeNull();
    expect(request.timeoutMs).toBe(180_000);
    expect(request.args).toEqual({ url: 'https://example.com/' });

    host.emitFrontend(
      `mcp-bridge-response:${String(request.correlationId)}`,
      { ok: true, data: null },
      WINDOW,
    );
    const invocation = await call;
    expect(invocation[0]).toBe(true);
    expect(invocation[1]).toBeNull();
    expect(invocation[2]).toBeNull();
  });

  it('returns bridge errors and rejects responses without a boolean ok field', async () => {
    const host = await setup();
    const failed = host.ctx.mcp.registry.callTool(
      'fetch:url', { url: 'https://example.com/' }, toolContext(),
    );
    const failedRequest = bridgeRequests(host)[0]!;
    host.emitFrontend(
      `mcp-bridge-response:${String(failedRequest.correlationId)}`,
      { ok: false, error: 'upstream failed' },
      WINDOW,
    );
    const failedInvocation = await failed;
    expect(failedInvocation[0]).toBe(false);
    expect(failedInvocation[2]).toBe('upstream failed');
    expect(failedInvocation[3]).toMatchObject({ bridge: 'frontend', tool_name: 'fetch:url' });

    host.events.length = 0;
    const invalid = host.ctx.mcp.registry.callTool(
      'fetch:url', { url: 'https://example.com/' }, toolContext(),
    );
    const invalidRequest = bridgeRequests(host)[0]!;
    host.emitFrontend(
      `mcp-bridge-response:${String(invalidRequest.correlationId)}`,
      { data: { content: [] } },
      WINDOW,
    );
    const invalidInvocation = await invalid;
    expect(invalidInvocation[0]).toBe(false);
    expect(invalidInvocation[2]).toBe('MCP 响应格式无效：缺少 ok 字段');
  });

  it('times out with the Rust message and disposes the window listener', async () => {
    const host = await setup();
    const started = Date.now();
    const result = await host.ctx.mcp.registry.callTool(
      'fetch:url', { _timeoutMs: 1 }, toolContext(),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(result[0]).toBe(false);
    expect(result[2]).toBe('MCP 调用超时');
    const request = bridgeRequests(host)[0]!;
    expect(request.timeoutMs).toBe(1_000);
    expect(listenerCount(host, `mcp-bridge-response:${String(request.correlationId)}`)).toBe(0);
  });

  it('aborts frontend MCP bridge call immediately when signal aborts instead of waiting 180s', async () => {
    const host = await setup();
    const controller = new AbortController();
    const started = Date.now();
    const pending = host.ctx.mcp.registry.callTool(
      'fetch:url',
      { url: 'https://example.com/' },
      { ...toolContext(), signal: controller.signal },
    );
    const request = bridgeRequests(host)[0]!;
    controller.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result[0]).toBe(false);
    expect(result[2]).toBe('MCP 调用已取消');
    expect(listenerCount(host, `mcp-bridge-response:${String(request.correlationId)}`)).toBe(0);
  });
});
