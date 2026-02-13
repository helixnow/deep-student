/**
 * 技能默认启用管理
 *
 * 用户可以设置默认启用的技能，新建会话时自动激活这些技能。
 * 使用 localStorage 持久化存储。
 *
 * 基于 PersistentSetManager 实现，扩展了 isDefault / getEffective 语义方法。
 */

import { PersistentSetManager } from './PersistentSetManager';

const STORAGE_KEY = 'dstu-skill-defaults';
const DEFAULT_SKILL_ID = 'deep-student';
const LEGACY_RENAMED_SKILL_ID = 'deep-scholar';
const LEGACY_DEFAULT_SKILL_ID = 'dstu-memory-orchestrator';
const MIGRATION_KEY = 'dstu-skill-defaults:migrate-deep-student-v1';

const manager = new PersistentSetManager('dstu-skill-defaults', 'SkillDefaults');

/**
 * 默认技能引导：
 * 1) 新用户（无存储）默认开启 deep-student
 * 2) 老用户一次性迁移：替换 legacy 默认技能并加入 deep-student（用户后续可手动关闭）
 */
function bootstrapDefaultSkills(): void {
  if (typeof globalThis === 'undefined' || typeof globalThis.localStorage === 'undefined') {
    return;
  }

  try {
    const storage = globalThis.localStorage;
    const hasStoredDefaults = storage.getItem(STORAGE_KEY) !== null;
    const migrated = storage.getItem(MIGRATION_KEY) === '1';

    if (!hasStoredDefaults) {
      manager.add(DEFAULT_SKILL_ID);
      storage.setItem(MIGRATION_KEY, '1');
      return;
    }

    if (!migrated) {
      if (manager.has(LEGACY_DEFAULT_SKILL_ID)) {
        manager.remove(LEGACY_DEFAULT_SKILL_ID);
      }
      if (manager.has(LEGACY_RENAMED_SKILL_ID)) {
        manager.remove(LEGACY_RENAMED_SKILL_ID);
      }
      if (!manager.has(DEFAULT_SKILL_ID)) {
        manager.add(DEFAULT_SKILL_ID);
      }
    }
    storage.setItem(MIGRATION_KEY, '1');
  } catch (error: unknown) {
    console.warn('[SkillDefaults] Failed to bootstrap default skills:', error);
  }
}

bootstrapDefaultSkills();

/**
 * 技能默认启用管理器（公共 API 保持不变）
 */
export const skillDefaults = {
  /** 添加为默认技能 */
  add: (skillId: string) => manager.add(skillId),

  /** 移除默认技能 */
  remove: (skillId: string) => manager.remove(skillId),

  /** 切换默认状态 */
  toggle: (skillId: string) => manager.toggle(skillId),

  /** 检查是否为默认技能 */
  isDefault: (skillId: string) => manager.has(skillId),

  /** 获取所有默认技能 ID */
  getAll: () => manager.getAll(),

  /**
   * 获取有效的默认 skills（合并全局+分组，分组优先）
   */
  getEffective: (groupDefaults?: string[]): string[] => {
    const globalDefaults = manager.getAll();
    if (!groupDefaults || groupDefaults.length === 0) {
      return globalDefaults;
    }
    return [...new Set([...groupDefaults, ...globalDefaults])];
  },

  /** 清空默认技能 */
  clear: () => manager.clear(),

  /** 订阅变更 */
  subscribe: (listener: () => void) => manager.subscribe(listener),
};
