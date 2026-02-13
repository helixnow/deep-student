/**
 * Chat V2 - 内置 Skills 自定义存储
 *
 * 管理用户对内置 skills 的自定义版本
 * 使用数据库 settings 表存储，保持内置和用户 skills 平等
 *
 * 存储格式：
 * - key: skill.builtin.<id>.customization
 * - value: JSON 字符串，包含自定义的元数据和内容
 */

import { invoke } from '@tauri-apps/api/core';
import type { SkillDefinition, SkillMetadata } from './types';
import { debugLog } from '../../debug-panel/debugMasterSwitch';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[BuiltinSkillStorage]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** 存储键前缀 */
const STORAGE_KEY_PREFIX = 'skill.builtin.';

/** 存储键后缀 */
const STORAGE_KEY_SUFFIX = '.customization';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 内置 skill 自定义数据
 * 存储用户对内置 skill 的修改
 */
export interface BuiltinSkillCustomization {
  /** 自定义的名称 */
  name?: string;
  /** 自定义的描述 */
  description?: string;
  /** 自定义的版本 */
  version?: string;
  /** 自定义的作者 */
  author?: string;
  /** 自定义的优先级 */
  priority?: number;
  /** 自定义的自动激活设置 */
  disableAutoInvoke?: boolean;
  /** 自定义 allowedTools（权限过滤） */
  allowedTools?: string[];
  /** 自定义 skillType */
  skillType?: import('./types').SkillType;
  /** 自定义 relatedSkills */
  relatedSkills?: string[];
  /** 自定义 dependencies */
  dependencies?: string[];
  /** 自定义的指令内容 */
  content?: string;
  /** 自定义的内嵌工具定义（渐进披露架构） */
  embeddedTools?: import('./types').ToolSchema[];
  /** 自定义时间戳 */
  customizedAt?: number;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成存储键
 */
function getStorageKey(skillId: string): string {
  return `${STORAGE_KEY_PREFIX}${skillId}${STORAGE_KEY_SUFFIX}`;
}

/**
 * 检查是否在 Tauri 运行时
 */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

// ============================================================================
// API 函数
// ============================================================================

/**
 * 获取内置 skill 的自定义数据
 *
 * @param skillId 内置 skill ID
 * @returns 自定义数据，如果没有自定义则返回 null
 */
export async function getBuiltinSkillCustomization(
  skillId: string
): Promise<BuiltinSkillCustomization | null> {
  if (!isTauriRuntime()) {
    console.warn(LOG_PREFIX, 'Non-Tauri environment, skipping custom load');
    return null;
  }

  try {
    const key = getStorageKey(skillId);
    const stored = await invoke<string | null>('get_setting', { key });

    if (!stored || typeof stored !== 'string') {
      return null;
    }

    const customization = JSON.parse(stored);
    // Validate essential fields
    if (typeof customization !== 'object' || customization === null) {
      console.warn(LOG_PREFIX, `Invalid customization data for ${skillId}: not an object`);
      return null;
    }
    if (customization.name !== undefined && typeof customization.name !== 'string') {
      console.warn(LOG_PREFIX, `Invalid customization.name for ${skillId}`);
      return null;
    }
    if (customization.content !== undefined && typeof customization.content !== 'string') {
      console.warn(LOG_PREFIX, `Invalid customization.content for ${skillId}`);
      return null;
    }
    console.log(LOG_PREFIX, `Loaded custom data for ${skillId}`);
    return customization as BuiltinSkillCustomization;
  } catch (error: unknown) {
    console.warn(LOG_PREFIX, `Failed to load custom data for ${skillId}:`, error);
    return null;
  }
}

/**
 * 保存内置 skill 的自定义数据
 *
 * @param skillId 内置 skill ID
 * @param customization 自定义数据
 */
export async function saveBuiltinSkillCustomization(
  skillId: string,
  customization: BuiltinSkillCustomization
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('非 Tauri 环境，无法保存自定义');
  }

  try {
    const key = getStorageKey(skillId);
    const data: BuiltinSkillCustomization = {
      ...customization,
      customizedAt: Date.now(),
    };
    const value = JSON.stringify(data);

    await invoke('save_setting', { key, value });
    console.log(LOG_PREFIX, `Saved custom data for ${skillId}`);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, `Failed to save custom data for ${skillId}:`, error);
    throw error;
  }
}

/**
 * 删除内置 skill 的自定义数据（恢复默认）
 *
 * @param skillId 内置 skill ID
 */
export async function resetBuiltinSkillCustomization(
  skillId: string
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('非 Tauri 环境，无法重置自定义');
  }

  try {
    const key = getStorageKey(skillId);
    await invoke('delete_setting', { key });
    console.log(LOG_PREFIX, `Reset ${skillId} to defaults`);
  } catch (error: unknown) {
    console.error(LOG_PREFIX, `Failed to reset ${skillId}:`, error);
    throw error;
  }
}

/**
 * 获取所有内置 skills 的自定义数据
 *
 * @param skillIds 内置 skill ID 列表
 * @returns Map<skillId, customization>
 */
export async function getAllBuiltinSkillCustomizations(
  skillIds: string[]
): Promise<Map<string, BuiltinSkillCustomization>> {
  const result = new Map<string, BuiltinSkillCustomization>();

  if (!isTauriRuntime()) {
    return result;
  }

  // 并行加载所有自定义数据
  const promises = skillIds.map(async (id) => {
    const customization = await getBuiltinSkillCustomization(id);
    if (customization) {
      result.set(id, customization);
    }
  });

  await Promise.all(promises);
  console.log(LOG_PREFIX, `Loaded ${result.size}/${skillIds.length} custom data entries`);
  return result;
}

/**
 * 将自定义数据应用到内置 skill 定义
 *
 * @param original 原始内置 skill 定义
 * @param customization 自定义数据
 * @returns 应用自定义后的 skill 定义
 */
export function applyCustomizationToSkill(
  original: SkillDefinition,
  customization: BuiltinSkillCustomization | null
): SkillDefinition {
  // 保存原始数据用于恢复
  const originalMetadata: Partial<SkillMetadata> = {
    name: original.name,
    description: original.description,
    version: original.version,
    author: original.author,
    priority: original.priority,
    disableAutoInvoke: original.disableAutoInvoke,
  };
  const originalContent = original.content;

  // 如果没有自定义，返回带原始数据标记的 skill
  if (!customization) {
    return {
      ...original,
      isBuiltin: true,
      isCustomized: false,
      originalContent,
      originalMetadata,
    };
  }

  // 应用自定义数据
  return {
    ...original,
    name: customization.name ?? original.name,
    description: customization.description ?? original.description,
    version: customization.version ?? original.version,
    author: customization.author ?? original.author,
    priority: customization.priority ?? original.priority,
    disableAutoInvoke: customization.disableAutoInvoke ?? original.disableAutoInvoke,
    allowedTools: customization.allowedTools ?? original.allowedTools,
    skillType: customization.skillType ?? original.skillType,
    relatedSkills: customization.relatedSkills ?? original.relatedSkills,
    dependencies: customization.dependencies ?? original.dependencies,
    content: customization.content ?? original.content,
    embeddedTools: customization.embeddedTools ?? original.embeddedTools,
    isBuiltin: true,
    isCustomized: true,
    originalContent,
    originalMetadata,
  };
}

/**
 * 从 skill 定义提取自定义数据
 *
 * @param skill 当前 skill 定义
 * @returns 自定义数据
 */
export function extractCustomizationFromSkill(
  skill: SkillDefinition
): BuiltinSkillCustomization {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    author: skill.author,
    priority: skill.priority,
    disableAutoInvoke: skill.disableAutoInvoke,
    allowedTools: skill.allowedTools,
    skillType: skill.skillType,
    relatedSkills: skill.relatedSkills,
    dependencies: skill.dependencies,
    content: skill.content,
    embeddedTools: skill.embeddedTools,
  };
}
