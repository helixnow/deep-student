/**
 * Chat V2 - 上下文类型定义 - 技能指令 (Skill Instruction)
 *
 * 用于注入激活的 Skill 指令到对话上下文
 *
 * 优先级: 3（在 system_prompt=1, user_preference=2 之后）
 * XML 标签: <skill_instruction>
 * 关联工具: 由 skill 定义的 tools 列表决定
 *
 * 设计说明：
 * - 支持同时激活多个 skill（多选模式）
 * - skill 内容由 TauriAdapter.buildSystemPromptWithSkills 直接从 skillRegistry 注入 system prompt
 *   （2026-02 改造：绕过 ContextRef → VFS pipeline，确保可靠注入 + 提升 AI 遵循度）
 * - ContextRef 仍用于 UI 状态管理（激活/取消激活），但其 formattedBlocks 不再用于 LLM 注入
 * - 元数据（available_skills）在 system prompt 中提供
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../context/types';
import { createXmlTextBlock } from '../context/types';
import type { SkillResourceMetadata } from './types';
import { SKILL_INSTRUCTION_TYPE_ID, SKILL_XML_TAG } from './types';

/**
 * 技能指令类型定义
 */
export const skillInstructionDefinition: ContextTypeDefinition = {
  typeId: SKILL_INSTRUCTION_TYPE_ID,
  xmlTag: SKILL_XML_TAG,
  label: '技能指令',
  labelEn: 'Skill Instruction',
  priority: 3, // 在 system_prompt(1) 和 user_preference(2) 之后
  tools: [], // 动态决定，基于激活的 skill 的 tools 字段

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<skill_instruction skill-id="..." skill-name="...">技能专属指令</skill_instruction> - ' +
    '当前激活的技能指令，请严格按照指令要求执行',

  formatToBlocks(resource: Resource): ContentBlock[] {
    const metadata = resource.metadata as (SkillResourceMetadata & Record<string, unknown>) | undefined;

    // 检查数据是否为空
    if (!resource.data || resource.data.trim() === '') {
      return [];
    }

    // 构建属性
    const attrs: Record<string, string | undefined> = {
      'skill-id': metadata?.skillId,
      'skill-name': metadata?.skillName,
    };

    // 如果有版本信息，添加版本属性
    if (metadata?.skillVersion) {
      attrs.version = metadata.skillVersion;
    }

    return [createXmlTextBlock(SKILL_XML_TAG, resource.data, attrs)];
  },
};

/**
 * 快速创建技能指令内容块（不经过资源库）
 * 用于发送时直接构建 formattedBlocks
 *
 * @param content 技能指令内容
 * @param metadata 技能元数据
 */
export function createSkillInstructionBlocks(
  content: string,
  metadata?: Partial<SkillResourceMetadata>
): ContentBlock[] {
  if (!content || content.trim() === '') {
    return [];
  }

  const attrs: Record<string, string | undefined> = {
    'skill-id': metadata?.skillId,
    'skill-name': metadata?.skillName,
  };

  if (metadata?.skillVersion) {
    attrs.version = metadata.skillVersion;
  }

  return [createXmlTextBlock(SKILL_XML_TAG, content, attrs)];
}
