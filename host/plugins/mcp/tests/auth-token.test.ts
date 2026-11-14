import { describe, expect, it } from 'vitest';
import {
  createLongLivedToken, isOAuthTokenExpired, normalizeResourceOrigin, oauthTokenNeedsRefresh,
  resolveAuthorizationHeader, type OAuth2Token,
} from '../src/auth-token.ts';

describe('crates/dstu-mcp/src/mcp/auth.rs::tests', () => {
  it('resource_origin_normalization_is_secure_and_stable', () => {
    expect(normalizeResourceOrigin('https://Example.COM:443/mcp?q=1')).toBe('https://example.com');
    expect(() => normalizeResourceOrigin('http://example.com/mcp')).toThrow();
    expect(normalizeResourceOrigin('http://127.0.0.1:8080/mcp')).toBe('http://127.0.0.1:8080');
  });

  it('test_oauth_token_expiration', () => {
    const now = new Date('2026-07-11T00:00:00.000Z');
    const token: OAuth2Token = {
      accessToken: 'test',
      tokenType: 'Bearer',
      expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
      refreshToken: null,
      scopes: [],
    };
    expect(isOAuthTokenExpired(token, now)).toBe(true);
    expect(oauthTokenNeedsRefresh(token, now)).toBe(true);
  });

  it('test_long_lived_token_generation', () => {
    const token = createLongLivedToken('test');
    expect(token.startsWith('mcp_test_')).toBe(true);
    expect(token.length).toBeGreaterThan(10);
  });

  it('resolve_authorization_prefers_api_key_over_oauth', async () => {
    const header = await resolveAuthorizationHeader(
      'any-server', 'sk-api-key', true, async () => 'oauth-token',
    );
    expect(header).toBe('Bearer sk-api-key');
  });

  it('resolve_authorization_oauth_missing_token_requires_reauth', async () => {
    await expect(resolveAuthorizationHeader(
      'definitely-missing-oauth-server-c7', null, true,
      async () => { throw new Error('no session'); },
    )).rejects.toThrow('OAuth re-authorization required');
  });

  it('resolve_authorization_injects_oauth_bearer', async () => {
    const header = await resolveAuthorizationHeader(
      'c7-bearer', null, true, async () => 'access-seeded-c7',
    );
    expect(header).toBe('Bearer access-seeded-c7');
  });

  it('resolve_authorization_oauth_without_server_id_errors', async () => {
    await expect(resolveAuthorizationHeader(null, null, true, async () => 'x'))
      .rejects.toThrow('server_id missing');
  });

  it('resolve_authorization_none_when_unconfigured', async () => {
    expect(await resolveAuthorizationHeader('x', null, false, async () => 'x')).toBeNull();
  });
});

describe('MCP auth token helpers beyond the Rust unit tests', () => {
  it('treats non-expiring tokens as current and trims API keys', async () => {
    const token: OAuth2Token = {
      accessToken: 'x', tokenType: 'Bearer', expiresAt: null, refreshToken: null, scopes: [],
    };
    expect(isOAuthTokenExpired(token)).toBe(false);
    expect(oauthTokenNeedsRefresh(token)).toBe(false);
    expect(await resolveAuthorizationHeader(null, '  key  ', false, async () => 'x'))
      .toBe('Bearer key');
    expect(() => normalizeResourceOrigin('http://example.com/mcp')).toThrow();
  });
});
