import { describe, expect, it } from 'vitest';
import zhMcp from '@/locales/zh-CN/mcp.json';
import enMcp from '@/locales/en-US/mcp.json';
import { builtinSkills } from '@/features/chat/skills/builtin';
import {
  browserToolsSkill,
  builtinToolSkills,
} from '@/features/chat/skills/builtin-tools';
import type { SkillDefinition } from '@/features/chat/skills/types';
import {
  getToolDisplayNameKey,
  hasToolDisplayName,
} from '@/mcp/builtinMcpServer';

function embeddedToolKeys(skills: readonly SkillDefinition[]): string[] {
  const keys = skills.flatMap((skill) =>
    (skill.embeddedTools ?? []).map((tool) =>
      tool.name
        .replace(/^builtin[-:]/, '')
        .replace(/^mcp_/, ''),
    ),
  );
  return [...new Set(keys)].sort();
}

describe('built-in tool display name locales', () => {
  it('keeps every built-in embedded tool covered in both locales', () => {
    // browserToolsSkill is added explicitly because builtinToolSkills is
    // platform-filtered and unit tests may run without a browser platform.
    const keys = embeddedToolKeys([
      ...builtinToolSkills,
      browserToolsSkill,
      ...builtinSkills,
    ]);

    const zhTools = zhMcp.tools as Record<string, string>;
    const enTools = enMcp.tools as Record<string, string>;
    const missingZh = keys.filter((key) => !zhTools[key]);
    const missingEn = keys.filter((key) => !enTools[key]);

    expect(missingZh, `zh-CN missing: ${missingZh.join(', ')}`).toEqual([]);
    expect(missingEn, `en-US missing: ${missingEn.join(', ')}`).toEqual([]);
  });

  it('keeps the zh-CN and en-US tool key sets aligned', () => {
    expect(Object.keys(zhMcp.tools).sort()).toEqual(Object.keys(enMcp.tools).sort());
  });

  it('covers synthetic and governed runtime tool names', () => {
    const runtimeOnlyKeys = [
      'image_gen',
      'qbank_submit_mock_exam',
      'skill_market_download_and_scan',
      'skill_market_verify',
      'subagent_retry',
      'workspace_status',
    ];

    for (const key of runtimeOnlyKeys) {
      expect(zhMcp.tools[key as keyof typeof zhMcp.tools], `zh-CN missing: ${key}`).toBeTruthy();
      expect(enMcp.tools[key as keyof typeof enMcp.tools], `en-US missing: ${key}`).toBeTruthy();
    }
  });

  it('never treats external MCP names as builtin display-name keys', () => {
    expect(getToolDisplayNameKey('builtin-web_search')).toBe('tools.web_search');
    expect(getToolDisplayNameKey('mcp_web_search')).toBeUndefined();
    expect(getToolDisplayNameKey('mcp.tools.web_search')).toBeUndefined();
    expect(hasToolDisplayName('mcp_web_search')).toBe(false);
  });

  it('uses action-oriented names for tool_pack', () => {
    expect(zhMcp.tools.tool_pack).toBe('并行执行工具');
    expect(enMcp.tools.tool_pack).toBe('Run Tools in Parallel');
  });
});
