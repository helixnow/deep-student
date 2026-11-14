import { describe, expect, it } from 'vitest';
import {
  ENV_PLACEHOLDER, McpProposeExecutor, buildServerEntry, findDuplicate, parseProposeInput,
  removeProposedEntry, type ProposeInput,
} from '../src/tools/mcp-propose-executor.ts';

function stdioInput(patch: Partial<ProposeInput> = {}): ProposeInput {
  return {
    name: 'brave',
    transport: 'stdio',
    purpose: 'search',
    command: 'npx',
    args: ['-y', '@pkg'],
    envRequired: [],
    ...patch,
  };
}

function parseError(args: unknown): string {
  try { parseProposeInput(args); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('arguments should be rejected');
}

describe('mcp_propose_executor.rs', () => {
  it('rejects_unknown_fields', () => {
    const error = parseError({
      name: 'brave', transport: 'stdio', command: 'npx', purpose: 'search', extra: true,
    });
    expect(error).toContain('Unknown field');
  });

  it('rejects_env_field_with_values', () => {
    const error = parseError({
      name: 'brave', transport: 'stdio', command: 'npx', purpose: 'search',
      env: { BRAVE_API_KEY: 'secret' },
    });
    expect(error).toContain('env');
  });

  it('rejects_env_required_with_value_shape', () => {
    const error = parseError({
      name: 'brave', transport: 'stdio', command: 'npx', purpose: 'search',
      env_required: ['BRAVE_API_KEY=abc'],
    });
    expect(error).toContain('env assignment');
  });

  it('rejects_non_https_url', () => {
    const error = parseError({
      name: 'remote', transport: 'sse', url: 'http://example.com/mcp', purpose: 'remote mcp',
    });
    expect(error).toContain('https');
  });

  it('allows_http_url_for_loopback_hosts', () => {
    for (const url of [
      'http://localhost:3000/mcp',
      'http://127.0.0.1:8787/callback',
      'http://[::1]:8080/sse',
      'http://api.localhost:9000/mcp',
    ]) {
      expect(() => parseProposeInput({
        name: 'local-bridge', transport: 'sse', url, purpose: 'local bridge',
      }), url).not.toThrow();
    }
    for (const url of ['http://192.168.1.10:3000/mcp', 'http://10.0.0.5/mcp']) {
      const error = parseError({
        name: 'remote', transport: 'sse', url, purpose: 'remote mcp',
      });
      expect(error, url).toContain('https');
    }
  });

  it('detects_duplicate_name', () => {
    const existing = [{
      id: 'brave', name: 'brave', transportType: 'stdio', command: 'npx', args: ['-y', 'other'],
    }];
    expect(findDuplicate(existing, stdioInput())).toBeDefined();
  });

  it('detects_duplicate_stable_id_after_display_name_was_changed', () => {
    const existing = [{
      id: 'brave', name: 'Brave Search (renamed)', transportType: 'stdio',
      command: 'npx', args: ['-y', 'other'],
    }];
    const error = findDuplicate(existing, stdioInput({
      name: 'BRAVE', command: 'different-command', args: [],
    }));
    expect(error).toContain('identity');
    expect(error).toContain('brave');
  });

  it('detects_duplicate_command_args', () => {
    const existing = [{
      id: 'pkg', name: 'pkg', transportType: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
    }];
    expect(findDuplicate(existing, stdioInput({
      name: 'brave-search', args: ['-y', '@modelcontextprotocol/server-brave-search'],
    }))).toBeDefined();
  });

  it('builds_placeholder_env_and_disabled', () => {
    const [entry, enabled] = buildServerEntry(stdioInput({
      envRequired: ['BRAVE_API_KEY'],
    }));
    expect(enabled).toBe(false);
    expect(entry.enabled).toBe(false);
    expect((entry.env as Record<string, unknown>).BRAVE_API_KEY).toBe(ENV_PLACEHOLDER);
  });

  it('builds_enabled_stdio_without_secrets', () => {
    const [entry, enabled] = buildServerEntry(stdioInput({
      name: 'fs',
      purpose: 'filesystem',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    }));
    expect(enabled).toBe(true);
    expect(entry.enabled).toBe(true);
  });

  it('targeted_rollback_preserves_concurrent_list_changes', () => {
    const latest: unknown[] = [
      { id: 'existing', name: 'renamed concurrently', enabled: false },
      { id: 'proposal', name: 'proposal' },
      { id: 'concurrent-add', name: 'added during connection test' },
    ];
    expect(removeProposedEntry(latest, 'proposal')).toBe(true);
    expect(latest).toEqual([
      { id: 'existing', name: 'renamed concurrently', enabled: false },
      { id: 'concurrent-add', name: 'added during connection test' },
    ]);
  });

  it('targeted_rollback_fails_closed_on_duplicate_stable_ids', () => {
    const latest: unknown[] = [
      { id: 'proposal', name: 'first' },
      { id: 'proposal', name: 'second' },
      { id: 'unrelated' },
    ];
    const before = structuredClone(latest);
    expect(() => removeProposedEntry(latest, 'proposal')).toThrow('multiple entries');
    expect(latest).toEqual(before);
  });

  it('handles_expected_tool_names', () => {
    const executor = new McpProposeExecutor();
    expect(executor.canHandle('mcp_server_propose')).toBe(true);
    expect(executor.canHandle('builtin-mcp_server_propose')).toBe(true);
    expect(executor.canHandle('mcp_server_propose_extra')).toBe(false);
  });

  it('sensitivity_is_high', () => {
    expect(new McpProposeExecutor().sensitivityLevel('builtin-mcp_server_propose')).toBe('high');
  });

  it('proposal writes a redacted summary and rolls back a failed connection test', async () => {
    let list: unknown[] = [{ id: 'existing', name: 'existing' }];
    const settings = new Map<string, string>();
    let emitted = 0;
    const executor = new McpProposeExecutor();
    await expect(executor.executeProposal(
      stdioInput({ args: ['-y', '@pkg'], purpose: 'search' }),
      { sessionId: 'sess-1' },
      {
        readList: async () => list,
        writeList: async (next) => { list = [...next]; },
        saveSetting: async (key, value) => { settings.set(key, value); },
        deleteSetting: async (key) => { settings.delete(key); },
        runConnectionTest: async () => ({ success: false, error: 'Bearer abc123 failed' }),
        emitListChanged: () => { emitted += 1; },
      },
    )).rejects.toThrow('MCP connection test failed');
    expect(list.map(entry => (entry as { id: string }).id)).toEqual(['existing']);
    expect(emitted).toBe(0);
    expect([...settings.keys()]).toEqual([]);
  });
});
