import { afterEach, describe, expect, it } from 'vitest';

import { McpService } from '../../../src/mcp/mcpService';

describe('McpService preferred server routing', () => {
  afterEach(() => {
    (McpService as any).servers.clear();
    (McpService as any).toolCacheByServer.clear();
  });

  it('prefers the specified server when tool names collide', () => {
    const fakeRuntimeA = { cfg: { id: 'server-a', namespace: '' } };
    const fakeRuntimeB = { cfg: { id: 'server-b', namespace: '' } };

    (McpService as any).servers.set('server-a', fakeRuntimeA);
    (McpService as any).servers.set('server-b', fakeRuntimeB);
    (McpService as any).toolCacheByServer.set('server-a', { at: Date.now(), tools: [{ name: 'fetch' }] });
    (McpService as any).toolCacheByServer.set('server-b', { at: Date.now(), tools: [{ name: 'fetch' }] });

    const resolved = (McpService as any).pickServerByTool('fetch', 'server-b');
    expect(resolved).toBe(fakeRuntimeB);
  });
});
