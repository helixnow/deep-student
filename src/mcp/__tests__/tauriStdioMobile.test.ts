import { afterEach, describe, expect, it, vi } from 'vitest';

describe('stdio mobile gate + network MCP path', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('rejects stdio on mobile UA even when Tauri internals exist', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36',
    });
    const { isTauriStdioSupported } = await import('../tauriStdioTransport');
    expect(isTauriStdioSupported()).toBe(false);
  });

  it('allows stdio on desktop Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    const { isTauriStdioSupported } = await import('../tauriStdioTransport');
    expect(isTauriStdioSupported()).toBe(true);
  });

  it('preset shelf is network-only (no stdio) so mobile can still install remote MCP', async () => {
    const { PRESET_MCP_SERVERS } = await import('../presetMcpServers');
    expect(PRESET_MCP_SERVERS).toHaveLength(8);
    for (const preset of PRESET_MCP_SERVERS) {
      expect(['sse', 'streamable_http']).toContain(preset.transportType);
      expect(preset.url.startsWith('https://')).toBe(true);
    }
  });
});
