/**
 * Chat V2 - 上下文类型定义 - 系统提示 (System Prompt)
 *
 * 用于统一注入系统提示覆盖（如学习模式提示词、模式插件提示词）
 *
 * 优先级: 1（最高，在所有用户上下文之前）
 * XML 标签: <system_instructions>
 * 关联工具: 无
 *
 * 设计说明：
 * - 学习模式提示词、模式插件 system prompt 统一走此类型
 * - 后端收到后直接作为 system prompt 的一部分
 * - 不存储到资源库（临时生成）
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createXmlTextBlock, createTextBlock } from '../types';
import { t } from '@/utils/i18n';

/**
 * 系统提示元数据类型
 */
export interface SystemPromptMetadata {
  /** 提示词来源（mode: 模式插件, learn: 学习模式） */
  source?: 'mode' | 'learn' | 'custom';
  /** 模式名称（如 canvas, analysis） */
  modeName?: string;
}

/**
 * 系统提示类型定义
 */
export const systemPromptDefinition: ContextTypeDefinition = {
  typeId: 'system_prompt',
  xmlTag: 'system_instructions',
  get label() { return t('contextDef.systemPrompt.label', {}, 'chatV2'); },
  labelEn: 'System Prompt',
  priority: 1, // 最高优先级，在所有用户上下文之前
  tools: [], // 无关联工具

  formatToBlocks(resource: Resource): ContentBlock[] {
    const metadata = resource.metadata as SystemPromptMetadata | undefined;
    const source = metadata?.source;

    // 检查数据是否为空
    if (!resource.data || resource.data.trim() === '') {
      return [];
    }

    // 根据来源添加属性
    const attrs: Record<string, string | undefined> = {};
    if (source) {
      attrs.source = source;
    }
    if (metadata?.modeName) {
      attrs.mode = metadata.modeName;
    }

    return [createXmlTextBlock('system_instructions', resource.data, attrs)];
  },
};

/**
 * 系统提示类型 ID 常量
 */
export const SYSTEM_PROMPT_TYPE_ID = 'system_prompt' as const;

/**
 * 系统提示来源类型
 */
export type SystemPromptSource = 'mode' | 'learn' | 'custom';

/**
 * 快速创建系统提示内容块（不经过资源库）
 * 用于发送时直接构建 formattedBlocks
 *
 * @param content 提示词内容
 * @param source 来源类型
 * @param modeName 模式名称（可选）
 */
export function createSystemPromptBlocks(
  content: string,
  source?: SystemPromptSource,
  modeName?: string
): ContentBlock[] {
  if (!content || content.trim() === '') {
    return [];
  }

  const attrs: Record<string, string | undefined> = {};
  if (source) {
    attrs.source = source;
  }
  if (modeName) {
    attrs.mode = modeName;
  }

  return [createXmlTextBlock('system_instructions', content, attrs)];
}
