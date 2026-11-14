import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import secretsPlugin from '../../../platform/secrets/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
import { defaultToolConfig, doSearch, type SearchInput } from '../api.ts';
import mcpPlugin from '../index.ts';
import { mcpStatus } from '../src/config.ts';

describe('D3 get_mcp_status cache TTL (cmd/mcp.rs:39 str::parse::<u64>)', () => {
  it('preserves u64 in the real settings-backed production core until kernel wire conversion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-status-u64-'));
    const storage = createStorageService({ baseDir: root, dataLocalDir: join(root, 'local') });
    let host: TestHost | undefined;
    try {
      const report = await storage.migrations.runAll();
      if (!report.success) throw new Error(report.error ?? 'settings migration failed');
      host = await createTestHost({
        plugins: [pathsPlugin, secretsPlugin, settingsPlugin, mcpPlugin],
        app: { dataDir: root },
        provide: {
          storage, llm: {},
          webSearch: { doSearch: (input: SearchInput, signal?: AbortSignal) => doSearch(defaultToolConfig(), input, () => undefined, signal) },
          log: { logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        },
      });
      for (const [raw, expected] of [
        ['9007199254740993', 9007199254740993n],
        ['18446744073709551615', 18446744073709551615n],
        ['+00012', 12n],
        ['0', 0n],
      ] as const) {
        host.ctx.settings.save('mcp.tools.cache_ttl_ms', raw);
        // Same core as the registered command; all values come from the real F4/F3 store.
        const internal = mcpStatus(host.ctx.settings);
        expect(internal.cache_state.ttl_ms, raw).toBe(expected);
        expect(typeof internal.cache_state.ttl_ms).toBe('bigint');
        // F1's D3 boundary intentionally matches serde_json output -> frontend JSON.parse.
        expect(await host.invoke('get_mcp_status')).toMatchObject({ cache_state: { ttl_ms: Number(expected) } });
        expect(internal.cache_state.ttl_ms).toBe(expected);
      }
      for (const invalid of ['18446744073709551616', '-1', '+', '', '1.0', '1e3', ' 12', '12\n', '12\r\n']) {
        host.ctx.settings.save('mcp.tools.cache_ttl_ms', invalid);
        expect(mcpStatus(host.ctx.settings).cache_state.ttl_ms, JSON.stringify(invalid)).toBe(300000n);
        expect(await host.invoke('get_mcp_status')).toMatchObject({ cache_state: { ttl_ms: 300000 } });
      }
      // cmd/mcp.rs selected tools uses Rust str::trim, unlike JavaScript String.trim.
      host.ctx.settings.save('session.selected_mcp_tools', '\u0085');
      expect(await host.invoke('get_mcp_status')).toMatchObject({ enabled: false, enabled_reason: '会话未选择MCP工具' });
      host.ctx.settings.save('session.selected_mcp_tools', '\ufeff');
      expect(await host.invoke('get_mcp_status')).toMatchObject({ enabled: true, enabled_reason: null });
    } finally {
      await host?.dispose();
      storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
