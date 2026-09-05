import { describe, expect, it } from 'vitest';

import { ATTACHMENT_STAGE_TOOL, attachmentToolsSkill } from '../builtin-tools/attachment-tools';
import { workspaceToolsSkill } from '../builtin-tools/workspace-tools';
import type { SkillDefinition, ToolSchema } from '../types';

const ATTACHMENT_TOOL_NAMES = [
  'builtin-attachment_list',
  'builtin-attachment_read',
  'builtin-attachment_stage',
  'builtin-attachment_extract',
] as const;

function getTool(skill: SkillDefinition, name: string): ToolSchema {
  const matches = skill.embeddedTools?.filter((candidate) => candidate.name === name) ?? [];
  expect(matches, `${skill.id} must expose ${name} exactly once`).toHaveLength(1);
  return matches[0];
}

describe('attachment-tools contract', () => {
  it('exposes list/read/stage/extract and shares the stage schema with workspace-tools', () => {
    expect(attachmentToolsSkill.allowedTools).toEqual([...ATTACHMENT_TOOL_NAMES]);
    expect(attachmentToolsSkill.embeddedTools?.map((tool) => tool.name)).toEqual([...ATTACHMENT_TOOL_NAMES]);

    const attachmentStage = getTool(attachmentToolsSkill, 'builtin-attachment_stage');
    const workspaceStage = getTool(workspaceToolsSkill, 'builtin-attachment_stage');
    expect(attachmentStage).toBe(ATTACHMENT_STAGE_TOOL);
    expect(workspaceStage).toBe(ATTACHMENT_STAGE_TOOL);
    expect(attachmentStage.inputSchema).toBe(workspaceStage.inputSchema);
  });

  it('keeps list/stage/read schemas closed and requires non-empty stage/read IDs', () => {
    const list = getTool(attachmentToolsSkill, 'builtin-attachment_list');
    const read = getTool(attachmentToolsSkill, 'builtin-attachment_read');
    const stage = getTool(attachmentToolsSkill, 'builtin-attachment_stage');

    expect(list.inputSchema.additionalProperties).toBe(false);
    expect(read.inputSchema.additionalProperties).toBe(false);
    expect(stage.inputSchema.additionalProperties).toBe(false);

    expect(read.inputSchema.required).toEqual(['message_id', 'attachment_id']);
    expect(stage.inputSchema.required).toEqual(['message_id', 'attachment_id']);
    expect(read.inputSchema.properties.message_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(read.inputSchema.properties.attachment_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(stage.inputSchema.properties.message_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(stage.inputSchema.properties.attachment_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('tells the model not to use stage as list/search and to reuse attachment_metadata', () => {
    expect(ATTACHMENT_STAGE_TOOL.description).toContain('不是列表或搜索工具');
    expect(ATTACHMENT_STAGE_TOOL.description).toContain('<attachment_metadata>');
    expect(ATTACHMENT_STAGE_TOOL.description).toContain('rootId/relativePath/objectHandle');
    expect(attachmentToolsSkill.content).toContain('查找/搜索附件只用 list，不要用 stage');
    expect(attachmentToolsSkill.content).toContain('<attachment_metadata>');
    expect(attachmentToolsSkill.content).toContain('不要用 stage 代替 list');
    expect(workspaceToolsSkill.content).toContain('不是列表或搜索工具');
    expect(workspaceToolsSkill.content).toContain('<attachment_metadata>');
  });
});
