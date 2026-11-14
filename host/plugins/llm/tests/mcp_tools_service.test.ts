import { describe, expect, it, vi } from 'vitest';
import { createMcpToolsService, type McpFrontendBridge } from '../src/mcp_tools_service.ts';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';

describe('MCP advertisement runtime', () => {
  it('accepts backend broadcast and window-targeted replies after clear/preheat on the real Host', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {
      get: (key: string) => key === 'mcp.tools.advertise_all_tools' ? 'true' : null,
    }, secrets: {} } });
    try {
      const window = { window: 'main', webview: 'main' };
      const service = host.ctx.llmMcpTools;
      const first = service.preheat(window);
      const request = host.eventsNamed('mcp-bridge-tools-request').at(-1) as { correlationId: string };
      host.ctx.backendEvents.emit(`mcp-bridge-tools-response:${request.correlationId}`, { tools: [{ name: 'broadcast' }] });
      expect(await first).toBe(1);
      expect(await service.build(window)).toMatchObject([{ function: { name: 'broadcast' } }]);
      service.clear();
      const second = service.preheat(window);
      const next = host.eventsNamed('mcp-bridge-tools-request').at(-1) as { correlationId: string };
      expect(next.correlationId).not.toBe(request.correlationId);
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'other' }, `mcp-bridge-tools-response:${next.correlationId}`, { tools: [{ name: 'wrong-window' }] });
      host.ctx.backendEvents.emit(`mcp-bridge-tools-response:${request.correlationId}`, { tools: [{ name: 'stale-correlation' }] });
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, `mcp-bridge-tools-response:${next.correlationId}`, { tools: [{ name: 'targeted' }] });
      expect(await second).toBe(1);
      expect(await service.build(window)).toMatchObject([{ function: { name: 'targeted' } }]);
    } finally { await host.dispose(); }
  });
  it('uses real window-targeted listeners and caches only the intended frontend response', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {
      get: (key: string) => key === 'mcp.tools.advertise_all_tools' ? 'true' : null,
    }, secrets: {} } });
    try {
      const service = host.ctx.llmMcpTools;
      expect(await service.build(null)).toEqual([]);
      const pending = service.build({ window: 'main', webview: 'main' });
      const event = host.eventsNamed('mcp-bridge-tools-request').at(-1) as { correlationId: string };
      const response = `mcp-bridge-tools-response:${event.correlationId}`;
      host.ctx.backendEvents.emitTo({ kind: 'Window', label: 'other' }, response, { tools: [{ name: 'wrong' }] });
      host.emitFrontend(response, { tools: [{ name: 'server/tool', input_schema: { type: 'object' } }] });
      expect(await pending).toMatchObject([{ function: { name: expect.stringMatching(/^ds_tool_/) } }]);
      const count = host.eventsNamed('mcp-bridge-tools-request').length;
      expect(await service.preheat({ window: 'main', webview: 'main' })).toBe(1);
      expect(host.eventsNamed('mcp-bridge-tools-request')).toHaveLength(count);
    } finally { await host.dispose(); }
  });
  it('requests once, caches nonempty results, respects selection/blacklist and skips discovery headlessly', async () => {
    const settings = new Map([['mcp.tools.advertise_all_tools', 'true'], ['mcp.tools.namespace_prefix', 'prefix/'],
      ['mcp.tools.blacklist', 'blocked'], ['session.selected_search_engines', ',']]);
    let receive!: (payload: unknown) => void;
    let requested = 0, disposed = 0;
    const bridge: McpFrontendBridge = {
      listenWindow(window, event, callback) { expect(window.window).toBe('main'); expect(event).toMatch(/^mcp-bridge-tools-response:[0-9a-f-]{36}$/); receive = callback; return () => { disposed++; }; },
      emit(event, payload) { requested++; expect(event).toBe('mcp-bridge-tools-request'); expect(payload).toHaveProperty('correlationId');
        receive({ tools: [{ name: 'server/tool', input_schema: { type: 'object' } }, { name: 'blocked' }] }); },
    };
    const service = createMcpToolsService({ get: key => settings.get(key) ?? null }, bridge);
    const window = { window: 'main', webview: 'main' };
    expect(await service.build(null)).toHaveLength(1); expect(requested).toBe(0);
    const tools = await service.build(window);
    expect(tools).toHaveLength(2); expect(tools[1]).toMatchObject({ function: { name: expect.stringMatching(/^ds_tool_/) } });
    expect(await service.preheat(window)).toBe(2); expect(requested).toBe(1); expect(disposed).toBe(1);
    service.clear(); await service.preheat(window); expect(requested).toBe(2);
  });
  it('expires the 15-second bridge wait and disposes the listener, with empty cache retry', async () => {
    vi.useFakeTimers();
    let disposed = 0, emitted = 0;
    const service = createMcpToolsService({ get: () => null }, {
      listenWindow: () => () => { disposed++; }, emit: () => { emitted++; },
    });
    try {
      const first = service.preheat({ window: 'main', webview: 'main' });
      await vi.advanceTimersByTimeAsync(15_000); expect(await first).toBe(0); expect(disposed).toBe(1);
      const second = service.preheat({ window: 'main', webview: 'main' });
      expect(emitted).toBe(2); await vi.advanceTimersByTimeAsync(15_000); expect(await second).toBe(0);
      expect(disposed).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});
