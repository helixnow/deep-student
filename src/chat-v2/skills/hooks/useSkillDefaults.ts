/**
 * 默认技能 React Hook
 *
 * 提供默认技能状态的订阅和操作方法
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { skillDefaults } from '../skillDefaults';
import type { SkillDefinition } from '../types';

/**
 * 默认技能 Hook 返回值
 */
export interface UseSkillDefaultsReturn {
  /** 所有默认技能 ID */
  defaultIds: string[];
  /** 检查技能是否为默认 */
  isDefault: (skillId: string) => boolean;
  /** 切换默认状态 */
  toggleDefault: (skillId: string) => void;
  /** 添加默认技能 */
  addDefault: (skillId: string) => void;
  /** 移除默认技能 */
  removeDefault: (skillId: string) => void;
  /** 清空所有默认技能 */
  clearDefaults: () => void;
  /** 对技能列表按默认状态排序（默认在前） */
  sortByDefault: <T extends SkillDefinition>(skills: T[]) => T[];
}

/**
 * 默认技能 Hook
 *
 * @example
 * ```tsx
 * const { defaultIds, isDefault, toggleDefault, sortByDefault } = useSkillDefaults();
 *
 * // 检查是否为默认
 * const isDefaultSkill = isDefault('my-skill');
 *
 * // 切换默认状态
 * <button onClick={() => toggleDefault('my-skill')}>
 *   {isDefaultSkill ? '取消默认' : '设为默认'}
 * </button>
 *
 * // 排序（默认在前）
 * const sortedSkills = sortByDefault(skills);
 * ```
 */
export function useSkillDefaults(): UseSkillDefaultsReturn {
  const [defaultIds, setDefaultIds] = useState<string[]>(() => skillDefaults.getAll());

  // 订阅默认状态变更
  useEffect(() => {
    const unsubscribe = skillDefaults.subscribe(() => {
      setDefaultIds(skillDefaults.getAll());
    });
    return unsubscribe;
  }, []);

  const isDefault = useCallback((skillId: string) => {
    return skillDefaults.isDefault(skillId);
  }, []);

  const toggleDefault = useCallback((skillId: string) => {
    skillDefaults.toggle(skillId);
  }, []);

  const addDefault = useCallback((skillId: string) => {
    skillDefaults.add(skillId);
  }, []);

  const removeDefault = useCallback((skillId: string) => {
    skillDefaults.remove(skillId);
  }, []);

  const clearDefaults = useCallback(() => {
    skillDefaults.clear();
  }, []);

  const sortByDefault = useCallback(<T extends SkillDefinition>(skills: T[]): T[] => {
    const defaultSet = new Set(defaultIds);
    return [...skills].sort((a, b) => {
      const aDefault = defaultSet.has(a.id) ? 0 : 1;
      const bDefault = defaultSet.has(b.id) ? 0 : 1;
      return aDefault - bDefault;
    });
  }, [defaultIds]);

  return useMemo(() => ({
    defaultIds,
    isDefault,
    toggleDefault,
    addDefault,
    removeDefault,
    clearDefaults,
    sortByDefault,
  }), [defaultIds, isDefault, toggleDefault, addDefault, removeDefault, clearDefaults, sortByDefault]);
}

export default useSkillDefaults;
