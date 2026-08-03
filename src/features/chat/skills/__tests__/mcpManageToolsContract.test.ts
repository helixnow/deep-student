/**
 * mcp_server_update / mcp_server_set_enabled / mcp_server_remove — 前端 schema 契约
 *
 * 与后端 mcp_manage_executor.rs 的解析约束对齐：
 * - 凭据红线：schema 不得出现 env 明文字段，env_required 只收变量名
 * - remove 必须携带 expected_transport + expected_entry_revision
 * - set_enabled 必填 server_id + enabled
 */

import { describe, it, expect } from 'vitest';
import { selfServiceToolsSkill } from '../builtin-tools/self-service-tools';

type EmbeddedTool = NonNullable<typeof selfServiceToolsSkill.embeddedTools>[number];

function getTool(name: string): EmbeddedTool {
  const tool = (selfServiceToolsSkill.embeddedTools ?? []).find(t => t.name === name);
  expect(tool, `${name} must be declared in self-service-tools embeddedTools`).toBeDefined();
  return tool as EmbeddedTool;
}

describe('self-service-tools MCP manage tool contracts', () => {
  it('declares all three manage tools alongside mcp_server_propose', () => {
    const names = (selfServiceToolsSkill.embeddedTools ?? []).map(t => t.name);
    expect(names).toContain('builtin-mcp_server_propose');
    expect(names).toContain('builtin-mcp_server_update');
    expect(names).toContain('builtin-mcp_server_set_enabled');
    expect(names).toContain('builtin-mcp_server_remove');
  });

  it('mcp_server_update schema forbids env plaintext and unknown fields', () => {
    const schema = getTool('builtin-mcp_server_update').inputSchema as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['server_id']);
    expect(Object.keys(schema.properties)).not.toContain('env');
    expect(schema.properties.env_required.items.type).toBe('string');
    // env_required 描述必须明确「仅变量名，禁止传值」
    expect(String(schema.properties.env_required.description)).toContain('禁止传值');
  });

  it('mcp_server_set_enabled schema requires server_id and enabled direction', () => {
    const schema = getTool('builtin-mcp_server_set_enabled').inputSchema as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['server_id', 'enabled']);
    expect(schema.properties.enabled.type).toBe('boolean');
  });

  it('mcp_server_remove schema binds transport and the reviewed entry revision', () => {
    const schema = getTool('builtin-mcp_server_remove').inputSchema as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'server_id',
      'expected_transport',
      'expected_entry_revision',
    ]);
    expect(schema.properties.expected_transport.enum).toEqual([
      'stdio',
      'sse',
      'http',
      'websocket',
      'streamable_http',
    ]);
    expect(schema.properties.expected_entry_revision.type).toBe('string');
  });

  it('skill content spells out the MCP manage discipline (single front door, no env values)', () => {
    const content = selfServiceToolsSkill.content ?? '';
    expect(content).toContain('mcp_server_update');
    expect(content).toContain('mcp_server_set_enabled');
    expect(content).toContain('mcp_server_remove');
    expect(content).toContain('expected_transport');
    expect(content).toContain('expected_entry_revision');
    // 纪律：不得绕过正门直改 mcp.tools.list
    expect(content).toContain('mcp.tools.list');
  });

  it('custom_agent_remove binds deletion to the reviewed persona content', () => {
    const schema = getTool('builtin-custom_agent_remove').inputSchema as Record<string, any>;
    expect(schema.required).toEqual(['file_name', 'expected_content_sha256']);
    expect(schema.properties.expected_content_sha256.type).toBe('string');
  });
});
