import { describe, expect, it } from 'vitest';
import type { SecureStore } from '../../../platform/secrets/api.ts';
import { authenticateApiKey, type OAuth2Token } from '../src/auth-token.ts';
import {
  McpOAuthManager, type OAuthEndpoints, type OAuthRuntime, type PersistedOAuthSession,
} from '../src/oauth-manager.ts';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

class MemorySecureStore {
  readonly secureDir = '/memory/.secure';
  readonly enabled = true;
  private readonly values = new Map<string, string>();

  async saveSecret(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
  read(key: string): string | null { return this.values.get(key) ?? null; }
}

interface FakeHttpState {
  refreshCount: number;
  dcrCount: number;
  requirePkce: boolean;
  refreshDelayMs: number;
  omitRefreshInResponse: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeHttp(state: FakeHttpState): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.includes('register')) {
      state.dcrCount += 1;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (!Array.isArray(parsed.redirect_uris)) {
        return jsonResponse({ error: 'invalid_client_metadata' }, 400);
      }
      return jsonResponse({
        client_id: 'dcr-client-xyz',
        client_id_issued_at: 1,
        token_endpoint_auth_method: 'none',
      });
    }
    const form = new URLSearchParams(body);
    const grant = form.get('grant_type') ?? '';
    if (grant === 'authorization_code') {
      if (state.requirePkce && (form.get('code_verifier') ?? '') === '') {
        return jsonResponse({ error: 'invalid_request', error_description: 'code_verifier required' }, 400);
      }
      return jsonResponse({
        access_token: 'access-from-code',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: 'mcp',
      });
    }
    if (grant === 'refresh_token') {
      if (state.refreshDelayMs > 0) {
        await new Promise(resolve => { setTimeout(resolve, state.refreshDelayMs); });
      }
      state.refreshCount += 1;
      const body: Record<string, unknown> = {
        access_token: `access-refreshed-${state.refreshCount}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      };
      if (!state.omitRefreshInResponse) body.refresh_token = 'refresh-1';
      return jsonResponse(body);
    }
    throw new Error(`unsupported grant_type: ${grant}`);
  };
}

function runtime(fetchImpl: typeof fetch, store: MemorySecureStore): OAuthRuntime {
  return {
    fetch: fetchImpl,
    openUrl: async () => undefined,
    secureStore: store as unknown as SecureStore,
    now: () => new Date(),
  };
}

async function registerTestClient(manager: McpOAuthManager, serverId: string): Promise<void> {
  const endpoints: OAuthEndpoints = {
    authorization: 'https://as.test/authorize',
    token: 'https://as.test/token',
    revocation: null,
    userinfo: null,
    registration: null,
  };
  await manager.registerOAuthClient(
    serverId, 'test-client', null, endpoints, 'http://127.0.0.1:9/auth/callback',
  );
}

function sessionWithToken(token: OAuth2Token, resourceOrigin = 'https://resource.test'): PersistedOAuthSession {
  return {
    token,
    client_id: 'test-client',
    client_secret: null,
    auth_url: 'https://as.test/authorize',
    token_url: 'https://as.test/token',
    redirect_uri: 'http://127.0.0.1:9/auth/callback',
    scopes: ['mcp'],
    resource_origin: resourceOrigin,
  };
}

function oauthToken(overrides: Partial<OAuth2Token> = {}): OAuth2Token {
  return {
    accessToken: 'access-from-code',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + HOUR_MS),
    refreshToken: 'refresh-1',
    scopes: ['mcp'],
    ...overrides,
  };
}

describe('crates/dstu-mcp/src/mcp/auth.rs::tests', () => {
  it('test_api_key_auth', () => {
    const token = authenticateApiKey('test_key');
    expect(token).toEqual({ kind: 'api_key', key: 'test_key' });
    expect(() => authenticateApiKey(null)).toThrow(/start_oauth/);
  });

  it('persisted_expires_at_uses_chrono_autosi_rfc3339', async () => {
    const store = new MemorySecureStore();
    const manager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    }), store));
    await manager.persistSession('chrono', sessionWithToken(oauthToken({
      expiresAt: new Date('2026-07-11T00:00:00.000Z'),
    })));
    expect(store.read('internal.oauth.mcp.chrono'))
      .toContain('"expires_at":"2026-07-11T00:00:00Z"');
    await manager.persistSession('chrono-frac', sessionWithToken(oauthToken({
      expiresAt: new Date('2026-07-11T00:00:00.123Z'),
    })));
    expect(store.read('internal.oauth.mcp.chrono-frac'))
      .toContain('"expires_at":"2026-07-11T00:00:00.123Z"');
  });

  it('bearer_token_is_bound_to_resource_origin', async () => {
    const store = new MemorySecureStore();
    const manager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    }), store));
    await manager.persistSession('bound', sessionWithToken(oauthToken({ accessToken: 'secret-token' })));
    await manager.restoreSession('bound');

    expect(await manager.getBearerTokenForResource('bound', 'https://resource.test/mcp'))
      .toBe('secret-token');
    expect(await manager.hasOAuthSessionForResource('bound', 'https://resource.test/other')).toBe(true);
    expect(await manager.hasOAuthSessionForResource('bound', 'https://attacker.test/mcp')).toBe(false);
    await expect(manager.getBearerTokenForResource('bound', 'https://attacker.test/mcp'))
      .rejects.toThrow();

    await manager.persistSession('bound', sessionWithToken(oauthToken({ accessToken: 'secret-token' }), ''));
    await manager.restoreSession('bound');
    expect(await manager.hasOAuthSessionForResource('bound', 'https://resource.test/mcp')).toBe(false);
  });

  it('rejects_exchange_on_state_mismatch', async () => {
    const fake = fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    });
    const manager = new McpOAuthManager(runtime(fake, new MemorySecureStore()));
    await registerTestClient(manager, 'srv');

    const { state } = await manager.generateAuthorizationUrl('srv', ['mcp']);
    await expect(manager.exchangeCode('srv', 'code-1', 'wrong-state-not-equal-to-csrf'))
      .rejects.toThrow(/PKCE verifier not found|Invalid CSRF/);

    // The failed exchange must not consume the valid verifier.
    const token = await manager.exchangeCode('srv', 'code-1', state);
    expect(token.accessToken).toBe('access-from-code');
  });

  it('rejects_exchange_when_pkce_verifier_missing', async () => {
    const fake = fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    });
    const manager = new McpOAuthManager(runtime(fake, new MemorySecureStore()));
    await registerTestClient(manager, 'srv');

    await expect(manager.exchangeCode('srv', 'code-1', 'orphan-csrf-never-stored'))
      .rejects.toThrow(/PKCE verifier not found|Invalid CSRF/);
  });

  it('hermetic_exchange_code_via_fake_http', async () => {
    const fake = fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    });
    const manager = new McpOAuthManager(runtime(fake, new MemorySecureStore()));
    await registerTestClient(manager, 'srv');
    const { state } = await manager.generateAuthorizationUrl('srv', ['mcp']);
    const token = await manager.exchangeCode('srv', 'test-auth-code', state);
    expect(token.accessToken).toBe('access-from-code');
    expect(token.refreshToken).toBe('refresh-1');
  });

  it('hermetic_persist_and_restore_session', async () => {
    const store = new MemorySecureStore();
    const manager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    }), store));
    await manager.persistSession('persist-srv', sessionWithToken(oauthToken()));

    const restoredManager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    }), store));
    const restored = await restoredManager.restoreSession('persist-srv');
    expect(restored?.accessToken).toBe('access-from-code');
  });

  it('hermetic_auto_refresh_via_fake_http', async () => {
    const state: FakeHttpState = {
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    };
    const manager = new McpOAuthManager(runtime(fakeHttp(state), new MemorySecureStore()));
    await registerTestClient(manager, 'refresh-srv');
    await manager.persistSession('refresh-srv', sessionWithToken(oauthToken({
      accessToken: 'old',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    })));

    const token = await manager.getValidToken('refresh-srv');
    expect(token.accessToken.startsWith('access-refreshed-')).toBe(true);
    expect(state.refreshCount).toBeGreaterThanOrEqual(1);
  });

  it('oauth_full_flow_state_mismatch_persist_and_refresh', async () => {
    const state: FakeHttpState = {
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    };
    const store = new MemorySecureStore();
    const manager = new McpOAuthManager(runtime(fakeHttp(state), store));
    const serverId = 'test-server';
    await registerTestClient(manager, serverId);

    // (a) state mismatch
    await manager.generateAuthorizationUrl(serverId, ['mcp']);
    await expect(manager.exchangeCode(serverId, 'x', 'bad-state'))
      .rejects.toThrow(/PKCE verifier not found|Invalid CSRF/);

    // legal exchange
    const { state: pendingState } = await manager.generateAuthorizationUrl(serverId, ['mcp']);
    const exchanged = await manager.exchangeCode(serverId, 'test-auth-code', pendingState);
    expect(exchanged.accessToken).toBe('access-from-code');
    expect(exchanged.refreshToken).toBe('refresh-1');

    await manager.persistSession(serverId, sessionWithToken(exchanged));

    // (b) restore from a new instance
    const restoredManager = new McpOAuthManager(runtime(fakeHttp(state), store));
    const restored = await restoredManager.restoreSession(serverId);
    expect(restored?.accessToken).toBe('access-from-code');

    // (c) expired session refreshes
    await restoredManager.persistSession(serverId, sessionWithToken(oauthToken({
      accessToken: 'old',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    })));
    await restoredManager.restoreSession(serverId);
    const refreshed = await restoredManager.getValidToken(serverId);
    expect(refreshed.accessToken.startsWith('access-refreshed-')).toBe(true);
    expect(state.refreshCount).toBeGreaterThanOrEqual(1);
  });

  it('authorization_url_includes_pkce_s256_challenge', async () => {
    const manager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    }), new MemorySecureStore()));
    await registerTestClient(manager, 'pkce-url');
    const { url, state } = await manager.generateAuthorizationUrl('pkce-url', ['mcp']);
    expect(state).not.toBe('');
    expect(url).toContain('code_challenge=');
    expect(url.toLowerCase()).toContain('s256');
    expect(url).toContain('state=');
  });

  it('hermetic_dcr_via_fake_http', async () => {
    const state: FakeHttpState = {
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    };
    const manager = new McpOAuthManager(runtime(fakeHttp(state), new MemorySecureStore()));
    const registered = await manager.dynamicClientRegister(
      'https://as.test/oauth/register', 'http://127.0.0.1:9/auth/callback', 'Deep Student MCP',
    );
    expect(registered.clientId).toBe('dcr-client-xyz');
    expect(registered.clientSecret).toBeNull();
    expect(state.dcrCount).toBe(1);

    await expect(manager.dynamicClientRegister('not a url', 'http://127.0.0.1/cb', 'x'))
      .rejects.toThrow(/Invalid registration endpoint/);
  });

  it('expired_without_refresh_token_requires_reauth', async () => {
    const state: FakeHttpState = {
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    };
    const manager = new McpOAuthManager(runtime(fakeHttp(state), new MemorySecureStore()));
    await registerTestClient(manager, 'no-rt');
    await manager.persistSession('no-rt', sessionWithToken(oauthToken({
      accessToken: 'stale',
      expiresAt: new Date(Date.now() - MINUTE_MS),
      refreshToken: null,
    })));

    await expect(manager.getValidToken('no-rt')).rejects.toThrow(/Re-authorize|No valid token/);
    expect(state.refreshCount).toBe(0);
  });

  it('near_expiry_without_refresh_token_degrades_to_current', async () => {
    const state: FakeHttpState = {
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: false,
    };
    const manager = new McpOAuthManager(runtime(fakeHttp(state), new MemorySecureStore()));
    await registerTestClient(manager, 'grace');
    await manager.persistSession('grace', sessionWithToken(oauthToken({
      accessToken: 'still-good',
      expiresAt: new Date(Date.now() + 2 * MINUTE_MS),
      refreshToken: null,
    })));

    const token = await manager.getValidToken('grace');
    expect(token.accessToken).toBe('still-good');
    expect(state.refreshCount).toBe(0);
  });

  it('refresh_preserves_old_refresh_token_when_as_omits_it', async () => {
    const manager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0,
      omitRefreshInResponse: true,
    }), new MemorySecureStore()));
    await registerTestClient(manager, 'omit-rt');
    const refreshed = await manager.refreshToken('omit-rt', 'refresh-keep-me');
    expect(refreshed.accessToken.startsWith('access-refreshed-')).toBe(true);
    expect(refreshed.refreshToken).toBe('refresh-keep-me');
  });

  it('concurrent_refresh_no_deadlock', async () => {
    const state: FakeHttpState = {
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 40,
      omitRefreshInResponse: false,
    };
    const manager = new McpOAuthManager(runtime(fakeHttp(state), new MemorySecureStore()));
    await registerTestClient(manager, 'concurrent');
    await manager.persistSession('concurrent', sessionWithToken(oauthToken({
      accessToken: 'old',
      expiresAt: new Date(Date.now() - MINUTE_MS),
    })));

    const results = await Promise.all(
      Array.from({ length: 8 }, () => manager.getValidToken('concurrent')),
    );
    expect(results).toHaveLength(8);
    expect(results.every(token => token.accessToken.length > 0)).toBe(true);
    expect(state.refreshCount).toBeGreaterThanOrEqual(1);
  });
});

describe('X6-unchecked-decode oauth-manager: serde_json::Value field access (auth.rs:395-405, 911-1026)', () => {
  const store = () => new MemorySecureStore();
  it('discovery body `null` falls through to fallback endpoints like Value::get → None', async () => {
    const fetchImpl = (async () => new Response('null', { status: 200 })) as typeof fetch;
    const manager = new McpOAuthManager(runtime(fetchImpl, store()));
    const endpoints = await manager.discoverOAuthEndpoints('https://as.test');
    expect(endpoints.authorization).toBe('https://as.test/oauth/authorize');
    expect(endpoints.registration).toBe('https://as.test/oauth/register');
  });

  it('a present non-string authorization_endpoint enters metadata parsing and reports Missing', async () => {
    const fetchImpl = (async () => jsonResponse({ authorization_endpoint: 1 })) as typeof fetch;
    const manager = new McpOAuthManager(runtime(fetchImpl, store()));
    await expect(manager.discoverOAuthEndpoints('https://as.test')).rejects.toThrow('Missing authorization_endpoint');
  });

  it('an unparsable endpoint reports Invalid <key> like Url::parse', async () => {
    const fetchImpl = (async () => jsonResponse({ authorization_endpoint: 'not a url', token_endpoint: 'https://as.test/t' })) as typeof fetch;
    const manager = new McpOAuthManager(runtime(fetchImpl, store()));
    await expect(manager.discoverOAuthEndpoints('https://as.test')).rejects.toThrow(/Invalid authorization_endpoint: /);
  });

  it('DCR body `null` reports missing client_id; an empty string client_id is accepted', async () => {
    const nullManager = new McpOAuthManager(runtime((async () => new Response('null', { status: 201 })) as typeof fetch, store()));
    await expect(nullManager.dynamicClientRegister('https://as.test/register', 'http://127.0.0.1:9/cb', 'app'))
      .rejects.toThrow('DCR response missing client_id');
    const emptyManager = new McpOAuthManager(runtime((async () => jsonResponse({ client_id: '' }, 201)) as typeof fetch, store()));
    expect(await emptyManager.dynamicClientRegister('https://as.test/register', 'http://127.0.0.1:9/cb', 'app'))
      .toEqual({ clientId: '', clientSecret: null });
  });

  it('a persisted session that is JSON `null` restores nothing (serde_json::from_str(..).ok() → None)', async () => {
    const secure = store();
    await secure.saveSecret('internal.oauth.mcp.nulls', 'null');
    const manager = new McpOAuthManager(runtime(fakeHttp({
      refreshCount: 0, dcrCount: 0, requirePkce: true, refreshDelayMs: 0, omitRefreshInResponse: false,
    }), secure));
    expect(await manager.restoreSession('nulls')).toBeNull();
  });
});
