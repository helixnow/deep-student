import { describe, expect, it } from 'vitest';
import { ENV_PLACEHOLDER } from '../src/tools/mcp-propose-executor.ts';
import {
  MCP_SERVER_REMOVE, MCP_SERVER_SET_ENABLED, MCP_SERVER_UPDATE, McpManageExecutor,
  REMOVE_ALLOWED_KEYS, SET_ENABLED_ALLOWED_KEYS, applyUpdate, entrySummary, findNameConflict,
  findServerIndex, missingEnvVars, parseUpdateInput, provenanceCleanupKeys, rejectUnknownFields,
} from '../src/tools/mcp-manage-executor.ts';

function stdioEntry(): Record<string, unknown> {
  return {
    id: 'brave',
    name: 'brave',
    transportType: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: 'user-filled-secret' },
  };
}

function remoteEntry(): Record<string, unknown> {
  return {
    id: 'remote',
    name: 'remote',
    transportType: 'sse',
    enabled: true,
    url: 'https://example.com/sse',
    fetch: { type: 'sse', url: 'https://example.com/sse' },
  };
}

function parseError(args: unknown): string {
  try {
    parseUpdateInput(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('arguments should be rejected');
}

describe('mcp_manage_executor.rs', () => {
  it('can_handle_covers_all_three_tools_with_prefixes', () => {
    const executor = new McpManageExecutor();
    for (const name of [
      MCP_SERVER_UPDATE,
      `builtin-${MCP_SERVER_UPDATE}`,
      MCP_SERVER_SET_ENABLED,
      `builtin-${MCP_SERVER_SET_ENABLED}`,
      MCP_SERVER_REMOVE,
      `builtin-${MCP_SERVER_REMOVE}`,
    ]) {
      expect(executor.canHandle(name), name).toBe(true);
    }
    expect(executor.canHandle('mcp_server_propose')).toBe(false);
    expect(executor.canHandle('mcp_server_update_extra')).toBe(false);
  });

  it('sensitivity_mapping_matches_governance_contract', () => {
    const executor = new McpManageExecutor();
    expect(executor.sensitivityLevel('builtin-mcp_server_update')).toBe('high');
    expect(executor.sensitivityLevel('builtin-mcp_server_remove')).toBe('high');
    expect(executor.sensitivityLevel('builtin-mcp_server_set_enabled')).toBe('medium');
  });

  it('update_rejects_env_field_with_values', () => {
    const error = parseError({
      server_id: 'brave',
      env: { BRAVE_API_KEY: 'secret' },
    });
    expect(error).toContain('env');
    expect(error).toContain('env_required');
  });

  it('update_rejects_env_required_with_value_shape', () => {
    const error = parseError({
      server_id: 'brave',
      env_required: ['BRAVE_API_KEY=abc'],
    });
    expect(error).toContain('env assignment');
  });

  it('update_rejects_unknown_fields_and_empty_patch', () => {
    expect(parseError({ server_id: 'brave', extra: true })).toContain('Unknown field');
    expect(parseError({ server_id: 'brave' })).toContain('At least one field');
  });

  it('update_rejects_non_https_url', () => {
    expect(parseError({ server_id: 'remote', url: 'http://example.com/mcp' }))
      .toContain('https');
  });

  it('apply_update_keeps_filled_env_values_and_adds_placeholders', () => {
    const input = parseUpdateInput({
      server_id: 'brave',
      env_required: ['BRAVE_API_KEY', 'NEW_VAR'],
    });
    const outcome = applyUpdate(stdioEntry(), input);
    const entry = outcome.entry;
    expect((entry.env as Record<string, unknown>).BRAVE_API_KEY).toBe('user-filled-secret');
    expect((entry.env as Record<string, unknown>).NEW_VAR).toBe(ENV_PLACEHOLDER);
    expect(outcome.needsSecrets).toBe(true);
    expect(outcome.enabled).toBe(false);
    expect(outcome.envRequired).toEqual(['NEW_VAR']);
  });

  it('apply_update_env_required_can_drop_variables', () => {
    const input = parseUpdateInput({ server_id: 'brave', env_required: [] });
    const outcome = applyUpdate(stdioEntry(), input);
    expect(outcome.entry.env).toEqual({});
    expect(outcome.needsSecrets).toBe(false);
    expect(outcome.enabled).toBe(true);
  });

  it('apply_update_transport_switch_to_remote_requires_url_and_clears_stdio_keys', () => {
    const missingUrl = parseUpdateInput({ server_id: 'brave', transport: 'sse' });
    expect(() => applyUpdate(stdioEntry(), missingUrl)).toThrow('url');

    const withUrl = parseUpdateInput({
      server_id: 'brave',
      transport: 'sse',
      url: 'https://example.com/sse',
    });
    const outcome = applyUpdate(stdioEntry(), withUrl);
    expect(outcome.entry.command).toBeUndefined();
    expect(outcome.entry.env).toBeUndefined();
    expect(outcome.entry.transportType).toBe('sse');
    expect((outcome.entry.fetch as Record<string, unknown>).url).toBe('https://example.com/sse');
  });

  it('apply_update_remote_rejects_stdio_only_fields', () => {
    const input = parseUpdateInput({ server_id: 'remote', command: 'npx' });
    expect(() => applyUpdate(remoteEntry(), input)).toThrow('stdio');
  });

  it('apply_update_rename_keeps_id_stable', () => {
    const input = parseUpdateInput({ server_id: 'brave', name: 'brave-search' });
    const outcome = applyUpdate(stdioEntry(), input);
    expect(outcome.entry.id).toBe('brave');
    expect(outcome.entry.name).toBe('brave-search');
    expect(outcome.changedFields).toContain('name');
  });

  it('find_server_index_prefers_exact_id_then_name', () => {
    const list = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'beta' },
    ];
    expect(findServerIndex(list, 'b')).toBe(1);
    expect(findServerIndex(list, 'ALPHA')).toBe(0);
    expect(findServerIndex(list, 'gamma')).toBeUndefined();
  });

  it('find_server_index_rejects_ambiguous_legacy_identity_or_name', () => {
    const duplicateIds = [
      { id: 'same', name: 'one' },
      { id: 'same', name: 'two' },
    ];
    expect(() => findServerIndex(duplicateIds, 'same')).toThrow();

    const duplicateNames = [
      { id: 'a', name: 'Same' },
      { id: 'b', name: 'same' },
    ];
    expect(() => findServerIndex(duplicateNames, 'SAME')).toThrow();
  });

  it('find_name_conflict_ignores_self', () => {
    const list = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'beta' },
    ];
    expect(findNameConflict(list, 0, 'Alpha')).toBeUndefined();
    expect(findNameConflict(list, 1, 'alpha')).toBeDefined();
  });

  it('missing_env_vars_flags_placeholder_and_empty', () => {
    const entry = {
      env: {
        FILLED: 'value',
        PLACEHOLDER: ENV_PLACEHOLDER,
        EMPTY: '',
      },
    };
    expect(missingEnvVars(entry).sort()).toEqual(['EMPTY', 'PLACEHOLDER']);
  });

  it('renamed_server_cleanup_keeps_stable_id_provenance_key', () => {
    const keys = provenanceCleanupKeys('old-stable-id', 'new-display-name');
    expect(keys).toContain('mcp.propose.provenance.old-stable-id');
    expect(keys).toContain('mcp.propose.provenance.new-display-name');
    expect(keys).toContain('mcp.manage.provenance.old-stable-id');
  });

  it('entry_summary_redacts_remote_url_and_env_values', () => {
    const summary = entrySummary(stdioEntry());
    const text = JSON.stringify(summary);
    expect(text).not.toContain('user-filled-secret');
    expect(text).toContain('BRAVE_API_KEY');

    const remote = entrySummary(remoteEntry());
    expect(remote.url).toBe('<remote-endpoint>');
  });

  it('set_enabled_and_remove_reject_unknown_fields', () => {
    expect(() => rejectUnknownFields(
      { server_id: 'a', enabled: true, reason: 'x' }, SET_ENABLED_ALLOWED_KEYS,
    )).not.toThrow();
    expect(() => rejectUnknownFields(
      { server_id: 'a', env: {} }, SET_ENABLED_ALLOWED_KEYS,
    )).toThrow();
    expect(() => rejectUnknownFields(
      { server_id: 'a', expected_transport: 'stdio', extra: 1 }, REMOVE_ALLOWED_KEYS,
    )).toThrow();
  });
});
