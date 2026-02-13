/**
 * Chat V2 - Skill 资源辅助函数
 *
 * 提供从 SkillDefinition 创建资源和 ContextRef 的功能
 *
 * 设计说明：
 * - Skill 内容存储在 VFS 资源库中（type: 'file'）
 * - ContextRef 使用 typeId: 'skill_instruction' 进行格式化
 * - 元数据包含 skill 相关信息
 */

import i18n from '@/i18n';
import { resourceStoreApi } from '../resources';
import type { ContextRef, ResourceMetadata } from '../resources/types';
import type { SkillDefinition, SkillResourceMetadata } from './types';
import { SKILL_INSTRUCTION_TYPE_ID } from './types';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillResourceHelper]';

/**
 * Skill 资源使用的基础类型
 * 使用 'file' 类型存储 skill 内容（纯文本）
 */
const SKILL_RESOURCE_TYPE = 'file' as const;

// ============================================================================
// 资源创建
// ============================================================================

/**
 * 从 SkillDefinition 创建资源并返回 ContextRef
 *
 * 流程：
 * 1. 将 skill 内容作为 'file' 类型资源存储到 VFS
 * 2. 在元数据中存储 skill 信息（用于 formatToBlocks）
 * 3. 返回 ContextRef（typeId 为 'skill_instruction'）
 *
 * @param skill Skill 定义
 * @returns ContextRef 或 null（创建失败时）
 */
export async function createResourceFromSkill(
  skill: SkillDefinition
): Promise<ContextRef | null> {
  try {
    // 构建元数据
    const metadata: ResourceMetadata & SkillResourceMetadata = {
      // 标准资源元数据
      name: `skill_${skill.id}`,
      title: skill.name,
      mimeType: 'text/markdown',

      // Skill 专属元数据
      skillId: skill.id,
      skillName: skill.name,
      skillVersion: skill.version,
      location: skill.location,
    };

    // 调用 VFS 创建资源
    const result = await resourceStoreApi.createOrReuse({
      type: SKILL_RESOURCE_TYPE,
      data: skill.content,
      sourceId: `skill:${skill.id}`, // 使用 skill: 前缀标识来源
      metadata,
    });

    console.log(
      LOG_PREFIX,
      `已创建 skill 资源: ${skill.id}`,
      `resourceId=${result.resourceId}`,
      `isNew=${result.isNew}`
    );

    // 构建 ContextRef
    // ★ isSticky: true 表示这是持久引用，发送消息后不会被清空
    // ★ displayName: 优先使用国际化名称，否则使用 skill.name
    const i18nName = i18n.t(`skills:builtinNames.${skill.id}`, { defaultValue: '' });
    const displayName = i18nName || skill.name;
    
    const contextRef: ContextRef = {
      resourceId: result.resourceId,
      hash: result.hash,
      typeId: SKILL_INSTRUCTION_TYPE_ID,
      isSticky: true, // 技能引用为持久引用，持续生效直到取消
      displayName, // 显示国际化友好名称
      skillId: skill.id, // 🔧 直接存储 skillId，避免 removeContextRef 时异步查找
    };

    return contextRef;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, `Failed to create skill resource: ${skill.id}`, error);
    return null;
  }
}

/**
 * 批量创建 Skill 资源
 *
 * @param skills Skill 定义数组
 * @returns 成功创建的 ContextRef 数组
 */
export async function createResourcesFromSkills(
  skills: SkillDefinition[]
): Promise<ContextRef[]> {
  const results: ContextRef[] = [];

  for (const skill of skills) {
    const contextRef = await createResourceFromSkill(skill);
    if (contextRef) {
      results.push(contextRef);
    }
  }

  console.log(
    LOG_PREFIX,
    `批量创建完成: ${results.length}/${skills.length} 个 skill 资源`
  );

  return results;
}

/**
 * 检查 ContextRef 是否为 Skill 类型
 *
 * @param ref ContextRef
 * @returns 是否为 skill_instruction 类型
 */
export function isSkillContextRef(ref: ContextRef): boolean {
  return ref.typeId === SKILL_INSTRUCTION_TYPE_ID;
}
