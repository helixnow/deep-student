import { describe, expect, it, vi } from 'vitest';
import {
  isAuthError,
  mcpAuthFailureNeedsReauth,
  resolveMcpAuthHeaders,
  type McpServerConfig,
} from '../mcpService';

describe('MCP connection auth headers (hermetic)', () => {
  const base = (over: Partial<McpServerConfig> = {}): Pick<
    McpServerConfig,
    'id' | 'apiKey' | 'oauth' | 'headers' | 'url'
  > => ({
    id: 'srv-1',
    url: 'https://mcp.example.test/mcp',
    ...over,
  });

  it('injects Bearer from apiKey and sets X-API-Key', async () => {
    const headers = await resolveMcpAuthHeaders(base({ apiKey: 'sk-test' }), {
      isTauri: true,
      getAccessToken: vi.fn(),
    });
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['X-API-Key']).toBe('sk-test');
  });

  it('prefers apiKey over oauth (does not call getAccessToken)', async () => {
    const getAccessToken = vi.fn(async () => 'oauth-token');
    const headers = await resolveMcpAuthHeaders(
      base({
        apiKey: 'sk-wins',
        oauth: { client_id: '', auth_url: '', token_url: '', redirect_uri: '', scopes: [] },
      }),
      { isTauri: true, getAccessToken },
    );
    expect(headers.Authorization).toBe('Bearer sk-wins');
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('injects OAuth Bearer when oauth configured and no apiKey (mock invoke)', async () => {
    const getAccessToken = vi.fn(async (serverId: string, resourceUrl: string) => {
      expect(serverId).toBe('srv-oauth');
      expect(resourceUrl).toBe('https://mcp.example.test/mcp');
      return 'access-from-oauth';
    });
    const headers = await resolveMcpAuthHeaders(
      base({
        id: 'srv-oauth',
        oauth: { client_id: '', scopes: [] },
      }),
      { isTauri: true, getAccessToken },
    );
    expect(headers.Authorization).toBe('Bearer access-from-oauth');
    expect(getAccessToken).toHaveBeenCalledOnce();
  });

  it('rejects with reauth when oauth token is null', async () => {
    await expect(
      resolveMcpAuthHeaders(
        base({ oauth: { client_id: '' } }),
        { isTauri: true, getAccessToken: async () => null },
      ),
    ).rejects.toThrow(/oauth|re-auth/i);
  });

  it('does not invoke oauth outside Tauri', async () => {
    const getAccessToken = vi.fn(async () => 'x');
    const headers = await resolveMcpAuthHeaders(
      base({ oauth: { client_id: '' } }),
      { isTauri: false, getAccessToken },
    );
    expect(headers.Authorization).toBeUndefined();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('preserves existing Authorization over apiKey injection', async () => {
    const headers = await resolveMcpAuthHeaders(
      base({
        apiKey: 'sk-ignored',
        headers: { Authorization: 'Bearer pre-set' },
      }),
      { isTauri: true, getAccessToken: vi.fn() },
    );
    expect(headers.Authorization).toBe('Bearer pre-set');
  });
});

describe('MCP 401 → reauth path', () => {
  it('marks needsReauth when oauth present and no apiKey on 401', () => {
    expect(
      mcpAuthFailureNeedsReauth(
        { oauth: { client_id: '' }, apiKey: undefined },
        new Error('HTTP 401 Unauthorized'),
      ),
    ).toBe(true);
  });

  it('does not mark needsReauth when apiKey is present', () => {
    expect(
      mcpAuthFailureNeedsReauth(
        { oauth: { client_id: '' }, apiKey: 'sk' },
        new Error('401'),
      ),
    ).toBe(false);
  });

  it('isAuthError covers 401/403/unauthorized negatives', () => {
    expect(isAuthError(new Error('401'))).toBe(true);
    expect(isAuthError(new Error('timeout'))).toBe(false);
  });
});
