import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { defaultToolConfig, doSearch, type SearchInput } from '../api.ts';
import mcpPlugin from '../index.ts';
import { McpOAuthManager } from '../src/oauth-manager.ts';

type RecordFixture = Record<string, unknown> & { token: Record<string, unknown> };
function session(): RecordFixture {
  return {
    token: {
      access_token: 'persisted-access-token', token_type: 'Bearer',
      expires_at: '2035-01-01T00:00:00Z', refresh_token: 'refresh', scopes: ['mcp'],
    },
    client_id: 'client', client_secret: 'secret', auth_url: 'https://as.test/authorize',
    token_url: 'https://as.test/token', redirect_uri: 'http://127.0.0.1:9/auth/callback',
    scopes: ['mcp'], resource_origin: 'https://resource.test',
  };
}

describe('X6-UD-0042 persisted OAuth map fields (auth.rs:65-71,93-104,219)', () => {
  it('rejects wrong map field types instead of inventing defaults; keeps real Option/default/unknown-field behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oauth-session-decode-'));
    const host = await createTestHost({ app: { dataDir: root } });
    const storage = createStorageService({ baseDir: root, dataLocalDir: join(root, 'local') });
    const log = { target: 'oauth-session-decode', info() {}, warn() {}, error() {}, debug() {}, trace() {} };
    const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') };
    try {
      const report = await storage.migrations.runAll();
      if (!report.success) throw new Error(report.error ?? 'settings migration failed');
      const paths = createPaths({ dataDir: root, platform: host.app.platform, env });
      // Real encrypted-file SecureStore, with the supported no-system-keystore configuration.
      const secrets = createSecretsService({ os: paths.os, log, keystore: null, env });
      const store = secrets.openStore(root);
      const settings = createSettingsService({ db: () => storage.database('mistakes'),
        secureStore: () => store, secrets });
      host.ctx.provide('settings', settings);
      host.ctx.provide('storage', storage);
      host.ctx.provide('secrets', secrets);
      host.ctx.provide('llm', {});
      host.ctx.provide('webSearch', {
        doSearch: (input: SearchInput, signal?: AbortSignal) => doSearch(defaultToolConfig(), input, () => undefined, signal),
      });
      host.ctx.provide('log', { logger: () => log });
      await host.install(mcpPlugin);
      const manager = new McpOAuthManager({ fetch, secureStore: store, now: () => new Date(),
        openUrl: async () => { throw new Error('restore must not open the system browser'); } });
      const resourceUrl = 'https://resource.test/mcp';
      const key = (id: string) => `internal.oauth.mcp.${id}`;

      const invalid: Array<[string, (record: RecordFixture) => void]> = [
        ['missing-token-type', record => { delete record.token.token_type; }],
        ['null-token-type', record => { record.token.token_type = null; }],
        ['missing-token-scopes', record => { delete record.token.scopes; }],
        ['null-token-scopes', record => { record.token.scopes = null; }],
        ['mixed-token-scopes', record => { record.token.scopes = ['mcp', 7]; }],
        ['missing-session-scopes', record => { delete record.scopes; }],
        ['string-session-scopes', record => { record.scopes = 'mcp'; }],
        ['mixed-session-scopes', record => { record.scopes = ['mcp', false]; }],
        ['wrong-client-secret', record => { record.client_secret = 7; }],
        ['wrong-refresh-token', record => { record.token.refresh_token = ['refresh']; }],
        ['wrong-expires-type', record => { record.token.expires_at = 7; }],
        ['null-resource-origin', record => { record.resource_origin = null; }],
        ['wrong-resource-origin', record => { record.resource_origin = 7; }],
      ];
      for (const [serverId, mutate] of invalid) {
        const record = session();
        mutate(record);
        await store.saveSecret(key(serverId), JSON.stringify(record));
        expect(await manager.restoreSession(serverId), serverId).toBeNull();
        expect(await host.invoke('get_mcp_oauth_status', { serverId, resourceUrl }), serverId)
          .toEqual({ server_id: serverId, authorized: false });
        expect(await host.invoke('get_mcp_oauth_access_token', { serverId, resourceUrl }), serverId).toBeNull();
      }

      await store.saveSecret(key('valid'), JSON.stringify(session()));
      expect(await manager.restoreSession('valid')).toMatchObject({
        accessToken: 'persisted-access-token', tokenType: 'Bearer', scopes: ['mcp'], refreshToken: 'refresh',
      });
      expect(await host.invoke('get_mcp_oauth_access_token', { serverId: 'valid', resourceUrl })).toBe('persisted-access-token');

      const optional = session();
      delete optional.client_secret;
      delete optional.token.refresh_token;
      delete optional.token.expires_at;
      optional.token.scopes = [];
      optional.scopes = [];
      optional.token.token_type = ''; // serde String does not require a nonempty value.
      await store.saveSecret(key('option-missing'), JSON.stringify(optional));
      expect(await manager.restoreSession('option-missing')).toMatchObject({ tokenType: '', expiresAt: null, refreshToken: null, scopes: [] });
      expect(await host.invoke('get_mcp_oauth_status', { serverId: 'option-missing', resourceUrl }))
        .toEqual({ server_id: 'option-missing', authorized: true });

      const optionalNull = session();
      optionalNull.client_secret = null;
      optionalNull.token.refresh_token = null;
      optionalNull.token.expires_at = null;
      await store.saveSecret(key('option-null'), JSON.stringify(optionalNull));
      expect(await manager.restoreSession('option-null')).toMatchObject({ expiresAt: null, refreshToken: null });
      expect(await host.invoke('get_mcp_oauth_access_token', { serverId: 'option-null', resourceUrl })).toBe('persisted-access-token');

      const legacy = session();
      delete legacy.resource_origin;
      await store.saveSecret(key('legacy'), JSON.stringify(legacy));
      expect(await manager.restoreSession('legacy')).not.toBeNull(); // #[serde(default)] resource_origin=""
      expect(await host.invoke('get_mcp_oauth_status', { serverId: 'legacy', resourceUrl }))
        .toEqual({ server_id: 'legacy', authorized: false });

      // Unknown fields are ignored, including an arbitrary_precision numeric token.
      const future = `${JSON.stringify(session()).slice(0, -1)},"future_number":1e400}`;
      await store.saveSecret(key('future'), future);
      expect(await manager.restoreSession('future')).not.toBeNull();
      expect(await host.invoke('get_mcp_oauth_status', { serverId: 'future', resourceUrl }))
        .toEqual({ server_id: 'future', authorized: true });
    } finally {
      await host.dispose();
      storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
