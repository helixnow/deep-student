import { expect, it, vi } from 'vitest';
import type { SecureStore } from '../../../platform/secrets/api.ts';
import { McpOAuthManager } from '../src/oauth-manager.ts';

it('keeps the replacement OAuth flow cancellable after the previous flow finishes', async () => {
  const opened: string[] = [];
  const manager = new McpOAuthManager({
    fetch: async () => Response.json({
      authorization_endpoint: 'https://fixture.test/authorize',
      token_endpoint: 'https://fixture.test/token',
    }),
    openUrl: async url => { opened.push(url); },
    secureStore: {
      getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => {},
    } as unknown as SecureStore,
    now: () => new Date(),
  });
  const params = {
    serverId: 'same-server', resourceUrl: 'https://fixture.test/mcp', clientId: 'fixture',
    clientSecret: null, scopes: [], openBrowser: true,
  };
  const outcomes: string[] = [];
  const first = manager.startOAuth(params).catch((error: Error) => error.message);
  let second: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    second = manager.startOAuth(params).catch((error: Error) => { outcomes.push(error.message); });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(await first).toBe('OAuth authorization cancelled');
    await manager.cancelOAuth(params.serverId);
    await vi.waitFor(() => expect(outcomes).toEqual(['OAuth authorization cancelled']), { timeout: 300 });
  } finally {
    manager.dispose();
    await first;
    await second;
  }
});
