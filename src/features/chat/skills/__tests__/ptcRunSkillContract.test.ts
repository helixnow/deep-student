import { describe, expect, it } from 'vitest';

import { builtinToolSkills, getBuiltinToolSkillById } from '../builtin-tools';
import { ptcRunSkill } from '../builtin-tools/ptc-run';
import { BUILTIN_NAMESPACE, getBuiltinToolSchemas } from '@/mcp/builtinMcpServer';

function getDynamicBuiltinTool(name: string) {
  return getBuiltinToolSchemas().find(tool => tool.name === `${BUILTIN_NAMESPACE}${name}`);
}

describe('ptcRunSkill contract', () => {
  it('is registered through the builtin tool skill lookup path', () => {
    expect(getBuiltinToolSkillById('ptc-run')).toBe(ptcRunSkill);

    const identityMatches = builtinToolSkills.filter(skill => skill === ptcRunSkill);
    const idMatches = builtinToolSkills.filter(skill => skill.id === 'ptc-run');

    expect(identityMatches).toHaveLength(1);
    expect(idMatches).toHaveLength(1);
  });

  it('exposes exactly one backend tool schema', () => {
    expect(ptcRunSkill.embeddedTools).toHaveLength(1);

    const embeddedTool = ptcRunSkill.embeddedTools?.[0];

    expect(embeddedTool?.name).toBe('builtin-ptc_run');
    expect(embeddedTool?.description).toContain('Rust backend executor');
    // 句子位置会变（词首可能大写），按概念大小写不敏感地锁契约
    expect(embeddedTool?.description?.toLowerCase()).toContain('central admission');
  });

  it('requires script and matches the backend ptc_run bounds', () => {
    const embeddedTool = ptcRunSkill.embeddedTools?.[0];
    const schema = embeddedTool?.inputSchema as any;
    const maxCalls = schema?.properties?.max_calls;
    const timeoutSecs = schema?.properties?.timeout_secs;

    expect(schema?.required).toEqual(['script']);
    expect(schema?.properties?.script?.type).toBe('string');
    // 与 Rust 侧 ptc_runtime.rs 常量对齐：MAX_CALLS_LIMIT=200 / MAX_TIMEOUT_SECS=600
    expect(maxCalls?.type).toBe('integer');
    expect(maxCalls?.maximum).toBe(200);
    expect(timeoutSecs?.type).toBe('integer');
    expect(timeoutSecs?.maximum).toBe(600);
  });

  it('is exposed through the dynamic builtin MCP schema path', () => {
    const embeddedTool = ptcRunSkill.embeddedTools?.[0];
    const dynamicTool = getDynamicBuiltinTool('ptc_run');

    expect(dynamicTool?.name).toBe('builtin-ptc_run');
    expect(dynamicTool?.inputSchema).toEqual(embeddedTool?.inputSchema);
  });
});
