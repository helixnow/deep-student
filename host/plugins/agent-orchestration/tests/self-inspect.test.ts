import { describe, expect, it } from 'vitest';
import {
  assembleSelfInspectPayload, canHandleSelfInspectTool, parseInspectSection,
  redactSensitiveJson, sanitizeMcpServerEntry, selfInspectSensitivityLevel,
} from '../src/self-inspect.ts';

describe('self_inspect_executor.rs report assembly', () => {
  it('handles_expected_tool_names', () => {
    expect(canHandleSelfInspectTool('self_inspect')).toBe(true);
    expect(canHandleSelfInspectTool('builtin-self_inspect')).toBe(true);
    expect(canHandleSelfInspectTool('self_inspect_extra')).toBe(false);
  });

  it('sensitivity_is_low', () => {
    expect(selfInspectSensitivityLevel()).toBe('Low');
  });

  it('parses_section_with_default_all', () => {
    expect(parseInspectSection({})).toBe('all');
    expect(parseInspectSection({ section: 'search' })).toBe('search');
    expect(() => parseInspectSection({ section: 'secrets' })).toThrow();
  });

  it('redact_sensitive_json_replaces_nested_sensitive_values', () => {
    const input = {
      search: {
        settings: [
          { key: 'web_search.api_key.tavily', configured: true },
          { key: 'web_search.engine', configured: true },
        ],
      },
      nested: {
        apiKey: 'super-secret',
        token: 'abc123',
        password: 'hunter2',
        private_key: '-----BEGIN',
        safe: 'visible',
      },
    };
    const output = redactSensitiveJson(input) as Record<string, unknown>;
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('BEGIN');
    expect(serialized).toContain('visible');
    const nested = output.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('<redacted>');
    expect(nested.token).toBe('<redacted>');
  });

  it('mcp_whitelist_only_exposes_allowed_fields', () => {
    const entry = {
      id: 'brave-search',
      name: 'Brave Search',
      transportType: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: 'secret-value' },
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      apiKey: 'plain-key',
    };
    const sanitized = sanitizeMcpServerEntry(entry)!;
    expect(sanitized.id).toBe('brave-search');
    expect(sanitized.name).toBe('Brave Search');
    expect(sanitized.transport).toBe('stdio');
    expect(sanitized.enabled).toBe(true);
    expect(sanitized.has_stable_id).toBe(true);
    expect((sanitized.entry_revision as string).length).toBe(64);
    expect(sanitized.command).toBeUndefined();
    expect(sanitized.env).toBeUndefined();
    expect(sanitized.url).toBeUndefined();
    expect(sanitized.headers).toBeUndefined();
    expect(sanitized.apiKey).toBeUndefined();

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('plain-key');
    expect(serialized).not.toContain('Bearer');

    const legacy = sanitizeMcpServerEntry({ name: 'Legacy Server', transport: 'stdio' })!;
    expect(legacy.id).toBe('Legacy Server');
    expect(legacy.has_stable_id).toBe(false);
  });

  it('section_filter_limits_payload_keys', () => {
    const rootsOnly = assembleSelfInspectPayload('roots', { roots: { roots: [] } });
    expect(rootsOnly.roots).toBeDefined();
    expect(rootsOnly.skills).toBeUndefined();
    expect(rootsOnly.mcp).toBeUndefined();
    expect(rootsOnly.search).toBeUndefined();

    const searchOnly = assembleSelfInspectPayload('search', {
      search: { runtime_enabled: true, settings: [] },
    });
    expect(searchOnly.search).toBeDefined();
    expect(searchOnly.roots).toBeUndefined();
  });
});
