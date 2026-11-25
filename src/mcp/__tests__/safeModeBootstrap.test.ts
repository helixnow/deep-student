import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));

import { addTypedEventListener } from '@/events';
import { McpService, bootstrapMcpFromSettings, isMcpPausedForSafeMode } from '../mcpService';

const SAMPLE_MCP_SERVERS = JSON.stringify([
  {
    id: 'custom-remote-mcp',
    name: 'Custom Remote MCP',
    transportType: 'sse',
    url: 'https://example.invalid/mcp/sse',
    enabled: true,
  },
]);

describe('SPOF-5A MCP bootstrap Safe Mode pause', () => {
  const originalHref = window.location.href;

  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    localStorage.setItem('mcp.tools.list', SAMPLE_MCP_SERVERS);
    McpService.dispose();
    McpService.setMcpPausedForSafeMode(false);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    McpService.dispose();
    McpService.setMcpPausedForSafeMode(false);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (globalThis as { __DS_WEBUI__?: boolean }).__DS_WEBUI__;
    window.history.replaceState(null, '', originalHref);
  });

  it('skips auto-connecting external custom MCP servers when Host manifest v2 reports safeMode=true', async () => {
    (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:ui|manifest' && args?.version === 2) {
        return { version: 2, safeMode: true, plugins: [], degraded: [] };
      }
      return null;
    });

    const connectAllSpy = vi.spyOn(McpService, 'connectAll').mockResolvedValue(undefined);
    const readyEvents: Array<Record<string, unknown>> = [];
    const disposeReady = addTypedEventListener<Record<string, unknown>>('mcp-bootstrap-ready', (detail) => {
      readyEvents.push(detail);
    });

    try {
      await bootstrapMcpFromSettings({ force: true, preheat: true });
    } finally {
      disposeReady();
    }

    expect(invokeMock).toHaveBeenCalledWith('plugin:ui|manifest', { version: 2 });
    expect(connectAllSpy).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('preheat_mcp_tools');
    expect(isMcpPausedForSafeMode()).toBe(true);

    const status = await McpService.status();
    expect(status.mcpPausedForSafeMode).toBe(true);
    expect(status.connected).toBe(false);
    // Server configuration is still registered so manual inspection/testing in Settings works.
    expect(status.servers).toEqual([
      expect.objectContaining({ id: 'custom-remote-mcp', connected: false }),
    ]);
    expect(readyEvents.at(-1)).toMatchObject({
      connected: false,
      mcpPausedForSafeMode: true,
    });
  });

  it('skips auto-connecting external MCP servers when ?safeMode=1 URL flag is active', async () => {
    window.history.replaceState(null, '', '/?safeMode=1');
    const connectAllSpy = vi.spyOn(McpService, 'connectAll').mockResolvedValue(undefined);

    await bootstrapMcpFromSettings({ force: true });

    expect(connectAllSpy).not.toHaveBeenCalled();
    expect(isMcpPausedForSafeMode()).toBe(true);
    const status = await McpService.status();
    expect(status.mcpPausedForSafeMode).toBe(true);
  });

  it('runs normal auto-connect when Safe Mode is inactive (safeMode=false)', async () => {
    (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:ui|manifest' && args?.version === 2) {
        return { version: 2, safeMode: false, plugins: [], degraded: [] };
      }
      if (command === 'preheat_mcp_tools') return undefined;
      return null;
    });

    const connectAllSpy = vi.spyOn(McpService, 'connectAll').mockResolvedValue(undefined);

    await bootstrapMcpFromSettings({ force: true, preheat: true });

    expect(connectAllSpy).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('preheat_mcp_tools');
    expect(isMcpPausedForSafeMode()).toBe(false);

    const status = await McpService.status();
    expect(status.mcpPausedForSafeMode).toBe(false);
  });
});
