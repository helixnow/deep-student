import { describe, expect, it } from 'vitest';
import type { McpToolSchema } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import {
  decodeToolNameFromApi, encodeToolNameForApi, isExternalMcpToolName,
  isLoadSkillsToolName, isMcpToolAllowedByPolicy, normalizeToolNameForApi,
  prepareExternalToolSchema, buildOpenAiFunctionToolSchema, prepareExternalTool,
} from '../api.ts';

function mcpTool(overrides: Partial<McpToolSchema>): McpToolSchema {
  return { name: 'tool', serverId: null, description: null, inputSchema: null, ...overrides };
}

describe('dstu-core/canonical_tools.rs::tests (F4 exact migration)', () => {
  it('canonical_tool_name_codec_round_trips_invalid_names', () => {
    const encoded = encodeToolNameForApi('mcp.tools.fetch:url')!;
    expect(encoded.startsWith('ds_tool_')).toBe(true);
    expect(decodeToolNameFromApi(encoded)).toBe('mcp.tools.fetch:url');
  });
  it('canonical_tool_name_codec_preserves_valid_names', () => {
    const encoded = encodeToolNameForApi('lookup_weather');
    expect(encoded).toBe('lookup_weather');
    expect(decodeToolNameFromApi(encoded!)).toBe('lookup_weather');
  });
  it('canonical_tool_name_codec_reencodes_reserved_prefix_names', () => {
    const encoded = encodeToolNameForApi('ds_tool_fetch')!;
    expect(encoded).not.toBe('ds_tool_fetch');
    expect(encoded.startsWith('ds_tool_')).toBe(true);
    expect(decodeToolNameFromApi(encoded)).toBe('ds_tool_fetch');
  });
  it('build_openai_function_tool_schema_normalizes_missing_parameters', () => {
    expect(buildOpenAiFunctionToolSchema('lookup_weather', 'Lookup')).toEqual({
      type: 'function', function: { name: 'lookup_weather', description: 'Lookup',
        parameters: { type: 'object', properties: {} } },
    });
  });
  it('build_openai_function_tool_schema_normalizes_non_object_parameters', () => {
    expect(buildOpenAiFunctionToolSchema('lookup_weather', 'Lookup', null)).toEqual({
      type: 'function', function: { name: 'lookup_weather', description: 'Lookup',
        parameters: { type: 'object', properties: {} } },
    });
  });
  it('prepare_external_tool_for_legacy_pipeline_uses_bridge_name_source', () => {
    const tool = prepareExternalTool('fetch:url', null, 'Fetch URL', { type: 'object' }, {
      internalPrefix: null, preservePrefix: null, apiNamePrefix: 'mcp.tools.',
      includeServerSuffix: false, apiNameSource: 'bridge_name',
    })!;
    expect(tool.bridgeName).toBe('fetch:url');
    expect(tool.internalToolName).toBe('fetch:url');
    expect(decodeToolNameFromApi(tool.apiName)!.startsWith('mcp.tools.fetch:url')).toBe(true);
  });
  it('prepare_external_tool_for_chat_pipeline_uses_internal_name_source', () => {
    const tool = prepareExternalTool('fetch:url', 'server:alpha', 'Fetch URL', { type: 'object' }, {
      internalPrefix: 'mcp_', preservePrefix: 'builtin-', apiNamePrefix: null,
      includeServerSuffix: true, apiNameSource: 'internal_tool_name',
    })!;
    expect(tool.bridgeName).toBe('fetch:url');
    expect(tool.internalToolName).toBe('mcp_fetch:url');
    expect(tool.preferredServerId).toBe('server:alpha');
    expect(decodeToolNameFromApi(tool.apiName)).toBe('["mcp-route-v1","mcp_fetch:url","server:alpha"]');
  });
  it('external_route_tuple_encoding_prevents_tool_server_boundary_collisions', () => {
    const prepare = (name: string, server: string | null) => prepareExternalTool(name, server, null, null, {
      internalPrefix: 'mcp_', preservePrefix: null, apiNamePrefix: null,
      includeServerSuffix: true, apiNameSource: 'internal_tool_name',
    })!.apiName;
    expect(prepare('foo__srv_bar', 'baz')).not.toBe(prepare('foo', 'bar__srv_baz'));
    expect(prepare('["mcp-route-v1","mcp_foo","bar"]', null)).not.toBe(prepare('foo', 'bar'));
  });
});

describe('chat_v2/pipeline/helpers.rs::tests', () => {
  it('test_normalize_tool_name_for_api_rejects_blank_names', () => {
    expect(normalizeToolNameForApi('')).toBeNull();
    expect(normalizeToolNameForApi('   ')).toBeNull();
    expect(normalizeToolNameForApi('\u0085')).toBeNull();
    expect(decodeToolNameFromApi(normalizeToolNameForApi('\uFEFF')!)).toBe('\uFEFF');
  });

  it('test_normalize_tool_name_for_api_encodes_invalid_names_losslessly', () => {
    const normalized = normalizeToolNameForApi(' mcp:fetch/url ')!;
    expect(normalized).not.toBe('mcp:fetch/url');
    expect(decodeToolNameFromApi(normalized)).toBe('mcp:fetch/url');
    expect(encodeToolNameForApi('lookup_weather')).toBe('lookup_weather');
  });

  it('test_prepare_external_tool_schema_builds_namespaced_payload', () => {
    const prepared = prepareExternalToolSchema(mcpTool({
      name: 'fetch:url',
      serverId: ' server:alpha ',
      description: 'Fetch a URL',
      inputSchema: { type: 'object' },
    }), true)!;

    expect(prepared.rawToolName).toBe('mcp_fetch:url');
    expect(prepared.preferredServerId).toBe('server:alpha');
    expect(decodeToolNameFromApi(prepared.apiName))
      .toBe('["mcp-route-v1","mcp_fetch:url","server:alpha"]');
    const schema = prepared.schema as { function: { name: string; parameters: unknown } };
    expect(schema.function.name).toBe(prepared.apiName);
    expect(schema.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('test_prepare_external_tool_schema_rejects_blank_tool_name', () => {
    expect(prepareExternalToolSchema(mcpTool({ name: '   ' }), false)).toBeNull();
  });

  it('test_prepare_external_tool_schema_namespaces_external_builtin_name', () => {
    const prepared = prepareExternalToolSchema(mcpTool({
      name: 'builtin-workspace_file_read',
      serverId: 'external-server',
      inputSchema: { type: 'object' },
    }), false)!;

    expect(prepared.rawToolName).toBe('mcp_builtin-workspace_file_read');
    expect(decodeToolNameFromApi(prepared.apiName)).toBe('mcp_builtin-workspace_file_read');
  });

  it('test_prepare_external_tool_schema_preserves_trusted_builtin_name', () => {
    const prepared = prepareExternalToolSchema(mcpTool({
      name: 'builtin-workspace_file_read',
      inputSchema: { type: 'object' },
    }), false)!;

    expect(prepared.rawToolName).toBe('builtin-workspace_file_read');
    expect(decodeToolNameFromApi(prepared.apiName)).toBe('builtin-workspace_file_read');
  });

  it('test_prepare_external_tool_schema_rejects_blank_server_id', () => {
    expect(prepareExternalToolSchema(mcpTool({
      name: 'web_search', serverId: '   ',
    }), true)).toBeNull();
  });

  it('test_prepare_external_tool_schema_routes_trusted_load_skills_to_builtin', () => {
    const prepared = prepareExternalToolSchema(mcpTool({
      name: 'load_skills', description: 'Load skills', inputSchema: { type: 'object' },
    }), true)!;

    expect(prepared.rawToolName).toBe('builtin-load_skills');
    expect(prepared.apiName).toBe('builtin-load_skills');
    expect(prepared.preferredServerId).toBeNull();
    expect(isLoadSkillsToolName(prepared.rawToolName)).toBe(true);
    expect(isExternalMcpToolName(prepared.rawToolName)).toBe(false);
  });

  it('test_prepare_external_tool_schema_keeps_external_load_skills_isolated', () => {
    const prepared = prepareExternalToolSchema(mcpTool({
      name: 'load_skills', serverId: 'external-server', description: 'External tool',
      inputSchema: { type: 'object' },
    }), true)!;

    expect(prepared.rawToolName).toBe('mcp_load_skills');
    expect(isExternalMcpToolName(prepared.rawToolName)).toBe(true);
    expect(decodeToolNameFromApi(prepared.apiName))
      .toBe('["mcp-route-v1","mcp_load_skills","external-server"]');
  });

  it('mcp_policy_is_deny_first_and_external_builtin_names_are_not_exempt', () => {
    const trustedBuiltin = mcpTool({ name: 'builtin-workspace_file_read' });
    const spoofedBuiltin = mcpTool({
      name: 'builtin-execute_command', serverId: 'external-server',
    });

    expect(isMcpToolAllowedByPolicy(trustedBuiltin, ['some_other_tool'], [])).toBe(true);
    expect(isMcpToolAllowedByPolicy(trustedBuiltin, [], [trustedBuiltin.name])).toBe(false);
    expect(isMcpToolAllowedByPolicy(spoofedBuiltin, ['some_other_tool'], [])).toBe(false);
    expect(isMcpToolAllowedByPolicy(spoofedBuiltin, [spoofedBuiltin.name], [])).toBe(true);
    expect(isMcpToolAllowedByPolicy(spoofedBuiltin, [spoofedBuiltin.name],
      [spoofedBuiltin.name])).toBe(false);
  });
});
