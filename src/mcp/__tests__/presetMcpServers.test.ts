import { describe, expect, it } from 'vitest';
import {
  PRESET_MCP_SERVERS,
  CATEGORY_LABELS,
  RISK_LABELS,
  getFreeMcpServers,
  isOAuthCapablePreset,
  presetToMcpConfig,
  type PresetMcpServer,
} from '../presetMcpServers';

const REQUIRED_IDS = [
  'context7',
  'exa',
  'wikipedia',
  'firecrawl',
  'cloudflare_docs',
  'tavily',
  'huggingface',
  'github',
] as const;

describe('preset MCP shelf contract', () => {
  it('exposes exactly 8 verified remote presets including required ids', () => {
    expect(PRESET_MCP_SERVERS).toHaveLength(8);
    const ids = PRESET_MCP_SERVERS.map((p) => p.id);
    for (const id of REQUIRED_IDS) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(8);
  });

  it('requires permissions + risk + verifiedSource on every preset', () => {
    for (const preset of PRESET_MCP_SERVERS) {
      expect(preset.url).toMatch(/^https:\/\//);
      expect(['sse', 'streamable_http']).toContain(preset.transportType);
      expect(preset.permissions).toBeTruthy();
      expect(preset.permissions.dataScopeKey).toMatch(/^settings:mcp_presets\.permissions\./);
      expect(typeof preset.permissions.networkEgress).toBe('boolean');
      expect(preset.permissions.networkEgress).toBe(true);
      expect(['low', 'medium', 'high']).toContain(preset.risk);
      expect(preset.verifiedSource).toMatch(/^https:\/\//);
      expect(CATEGORY_LABELS[preset.category]).toBeTruthy();
      expect(RISK_LABELS[preset.risk]).toBeTruthy();
      expect(preset.descriptionKey).toMatch(/^settings:mcp_presets\./);
      expect(['none', 'api_key', 'oauth_ready', 'api_key_or_oauth']).toContain(preset.authKind);
    }
  });

  it('presetToMcpConfig maps transport/url/namespace/risk for each of 8 presets', () => {
    for (const preset of PRESET_MCP_SERVERS) {
      const cfg = presetToMcpConfig(preset, preset.requiresApiKey ? { apiKey: 'k' } : undefined);
      expect(cfg.transportType).toBe(preset.transportType);
      expect(cfg.url).toBe(preset.url);
      expect(cfg.namespace).toBe(`${preset.id}:`);
      expect(cfg.risk).toBe(preset.risk);
      expect(cfg.authKind).toBe(preset.authKind);
      expect(cfg.presetId).toBe(preset.id);
      expect(cfg.name).toBe(preset.name);
    }
  });

  it('marks GitHub as requiring API Key and OAuth-capable', () => {
    const github = PRESET_MCP_SERVERS.find((p) => p.id === 'github')!;
    expect(github.requiresApiKey).toBe(true);
    expect(isOAuthCapablePreset(github)).toBe(true);
    expect(github.risk).toBe('high');
  });

  it('does not force API Key for Context7 / Exa / Wikipedia free tier', () => {
    const free = getFreeMcpServers();
    const freeIds = free.map((p) => p.id);
    expect(freeIds).toContain('context7');
    expect(freeIds).toContain('exa');
    expect(freeIds).toContain('wikipedia');
  });

  it('presetToMcpConfig prefers apiKey over oauth (mutual exclusion)', () => {
    const hf = PRESET_MCP_SERVERS.find((p) => p.id === 'huggingface') as PresetMcpServer;
    const withKey = presetToMcpConfig(hf, { apiKey: 'hf_test', enableOauth: true });
    expect(withKey.apiKey).toBe('hf_test');
    expect(withKey.oauth).toBeUndefined();

    const withOauth = presetToMcpConfig(hf, { enableOauth: true });
    expect(withOauth.apiKey).toBeUndefined();
    expect(withOauth.oauth).toBeTruthy();
    expect(withOauth.id).toMatch(/^preset_huggingface_/);
    expect(withOauth.url).toBe(hf.url);
  });

  it('annotates authKind consistently with requiresApiKey / oauth capability', () => {
    for (const preset of PRESET_MCP_SERVERS) {
      if (preset.requiresApiKey) {
        expect(['api_key', 'api_key_or_oauth']).toContain(preset.authKind);
      }
      if (preset.authKind === 'oauth_ready' || preset.authKind === 'api_key_or_oauth') {
        expect(isOAuthCapablePreset(preset)).toBe(true);
      }
    }
  });
});
