import { describe, expect, it, vi } from 'vitest';
import {
  PRESET_MCP_SERVERS,
  presetToMcpConfig,
  type PresetMcpServer,
} from '@/mcp/presetMcpServers';

/**
 * 一键安装写配置契约：与 McpToolsSection PresetServerSelector.onAddPreset 一致
 *（presetToMcpConfig → onAddServer），此处 mock 持久化 invoke。
 */
describe('MCP preset one-click install config (mock invoke)', () => {
  it('writes complete permissions/risk metadata for all 8 presets', () => {
    expect(PRESET_MCP_SERVERS).toHaveLength(8);
    for (const preset of PRESET_MCP_SERVERS) {
      expect(preset.permissions.dataScopeKey).toMatch(/^settings:mcp_presets\.permissions\./);
      expect(typeof preset.permissions.networkEgress).toBe('boolean');
      expect(['low', 'medium', 'high']).toContain(preset.risk);
      expect(preset.authKind).toBeTruthy();
      expect(preset.verifiedSource).toMatch(/^https:\/\//);
    }
  });

  it('onAddPreset → persist payload matches presetToMcpConfig (apiKey path)', async () => {
    const saveMcpConfig = vi.fn(async (payload: unknown) => payload);
    const github = PRESET_MCP_SERVERS.find((p) => p.id === 'github') as PresetMcpServer;

    // 模拟 UI：onAddPreset(preset, options) → presetToMcpConfig → 写配置
    const options = { apiKey: 'ghp_test_token', enableOauth: true as boolean };
    const config = presetToMcpConfig(github, options);
    await saveMcpConfig({
      command: 'upsert_mcp_server',
      server: config,
    });

    expect(saveMcpConfig).toHaveBeenCalledOnce();
    const arg = saveMcpConfig.mock.calls[0][0] as {
      command: string;
      server: ReturnType<typeof presetToMcpConfig>;
    };
    expect(arg.command).toBe('upsert_mcp_server');
    expect(arg.server.apiKey).toBe('ghp_test_token');
    expect(arg.server.oauth).toBeUndefined(); // apiKey 优先
    expect(arg.server.url).toBe(github.url);
    expect(arg.server.transportType).toBe('streamable_http');
    expect(arg.server.presetId).toBe('github');
    expect(arg.server.risk).toBe('high');
    expect(arg.server.authKind).toBe('api_key_or_oauth');
    expect(arg.server.id).toMatch(/^preset_github_/);
  });

  it('onAddPreset → persist payload for OAuth-capable preset without apiKey', async () => {
    const saveMcpConfig = vi.fn(async (payload: unknown) => payload);
    const cf = PRESET_MCP_SERVERS.find((p) => p.id === 'cloudflare_docs') as PresetMcpServer;
    const config = presetToMcpConfig(cf, { enableOauth: true });
    await saveMcpConfig({ command: 'upsert_mcp_server', server: config });

    const arg = saveMcpConfig.mock.calls[0][0] as {
      server: ReturnType<typeof presetToMcpConfig>;
    };
    expect(arg.server.apiKey).toBeUndefined();
    expect(arg.server.oauth).toEqual({
      client_id: '',
      auth_url: '',
      token_url: '',
      redirect_uri: 'http://127.0.0.1/auth/callback',
      scopes: [],
    });
    expect(arg.server.transportType).toBe(cf.transportType);
    expect(arg.server.url).toBe(cf.url);
  });

  it('presetToMcpConfig for every shelf item yields network transport + url', () => {
    for (const preset of PRESET_MCP_SERVERS) {
      const cfg = presetToMcpConfig(preset);
      expect(['sse', 'streamable_http']).toContain(cfg.transportType);
      expect(cfg.url).toBe(preset.url);
      expect(cfg.presetId).toBe(preset.id);
      expect(cfg.risk).toBe(preset.risk);
    }
  });
});
