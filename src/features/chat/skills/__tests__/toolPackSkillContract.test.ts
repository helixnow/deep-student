import { describe, expect, it } from 'vitest';

import { builtinToolSkills, getBuiltinToolSkillById } from '../builtin-tools';
import { toolPackSkill } from '../builtin-tools/tool-pack';
import { BUILTIN_NAMESPACE, getBuiltinToolSchemas } from '@/mcp/builtinMcpServer';

function getDynamicBuiltinTool(name: string) {
  return getBuiltinToolSchemas().find(tool => tool.name === `${BUILTIN_NAMESPACE}${name}`);
}

describe('toolPackSkill contract', () => {
  it('is registered through the builtin tool skill lookup path', () => {
    expect(getBuiltinToolSkillById('tool-pack')).toBe(toolPackSkill);

    const identityMatches = builtinToolSkills.filter(skill => skill === toolPackSkill);
    const idMatches = builtinToolSkills.filter(skill => skill.id === 'tool-pack');

    expect(identityMatches).toHaveLength(1);
    expect(idMatches).toHaveLength(1);
  });

  it('exposes exactly one backend tool schema with the required description', () => {
    expect(toolPackSkill.embeddedTools).toHaveLength(1);

    const embeddedTool = toolPackSkill.embeddedTools?.[0];

    expect(embeddedTool?.name).toBe('builtin-tool_pack');
    expect(embeddedTool?.description).toContain('Rust backend executor');
    expect(embeddedTool?.description).toContain('frontend only exposes this schema');
  });

  it('requires tools and matches the backend tool_pack bounds', () => {
    const embeddedTool = toolPackSkill.embeddedTools?.[0];
    const schema = embeddedTool?.inputSchema;
    const toolsSchema = schema?.properties.tools as any;
    const itemSchema = toolsSchema.items as any;
    const timeoutSchema = schema?.properties.timeout as any;

    expect(schema?.required).toEqual(['tools']);
    expect(toolsSchema.type).toBe('array');
    expect(toolsSchema.minItems).toBe(1);
    expect(toolsSchema.maxItems).toBe(20);
    expect(itemSchema.required).toEqual(['name', 'args']);
    expect(itemSchema.properties.name.type).toBe('string');
    expect(itemSchema.properties.args.type).toBe('object');
    expect(itemSchema.properties.input).toBeUndefined();
    expect(timeoutSchema.type).toBe('integer');
    expect(timeoutSchema.minimum).toBe(1);
    expect(timeoutSchema.maximum).toBe(600);
  });

  it('is exposed through the dynamic builtin MCP schema path', () => {
    const embeddedTool = toolPackSkill.embeddedTools?.[0];
    const dynamicTool = getDynamicBuiltinTool('tool_pack');

    expect(dynamicTool?.name).toBe('builtin-tool_pack');
    expect(dynamicTool?.inputSchema).toEqual(embeddedTool?.inputSchema);
  });
});
