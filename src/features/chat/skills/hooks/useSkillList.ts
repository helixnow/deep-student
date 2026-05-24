/**
 * Chat V2 - Skills 列表 Hook
 *
 * 提供从 SkillRegistry 获取技能列表的 React Hook
 * 支持响应式更新（当 skills 变化时刷新）
 */

import { useState, useEffect, useCallback } from 'react';
import i18n from 'i18next';
import { skillRegistry, subscribeToSkillRegistry } from '../registry';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '../utils';
import type { SkillMetadata, SkillDefinition, SkillLocation } from '../types';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[useSkillList]';

// ============================================================================
// Hook: useSkillList
// ============================================================================

/**
 * 获取所有技能的元数据列表
 *
 * @returns 技能元数据列表和刷新函数
 */
export function useSkillList(): {
  skills: SkillMetadata[];
  isLoading: boolean;
  refresh: () => void;
} {
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // 用于触发重新获取的版本号
  const [version, setVersion] = useState(0);

  // 刷新技能列表
  const refresh = useCallback(() => {
    setIsLoading(true);
    try {
      const allSkills = skillRegistry.getAllMetadata();
      setSkills(allSkills);
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'Failed to get skill list:', error);
      setSkills([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 订阅 registry 更新
  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  // 当版本号变化时刷新
  useEffect(() => {
    refresh();
  }, [refresh, version]);

  return { skills, isLoading, refresh };
}

// ============================================================================
// Hook: useSkillDetails
// ============================================================================

/**
 * 获取单个技能的完整定义
 *
 * @param skillId 技能 ID
 * @returns 技能定义或 undefined
 */
export function useSkillDetails(skillId: string | null): SkillDefinition | undefined {
  const [skill, setSkill] = useState<SkillDefinition | undefined>(undefined);

  useEffect(() => {
    const updateSkill = () => {
      if (!skillId) {
        setSkill(undefined);
        return;
      }
      setSkill(skillRegistry.get(skillId));
    };
    updateSkill();
    const unsubscribe = subscribeToSkillRegistry(updateSkill);
    return unsubscribe;
  }, [skillId]);

  return skill;
}

// ============================================================================
// Hook: useSkillsByLocation
// ============================================================================

/**
 * 按来源位置筛选技能
 *
 * @param location 来源位置
 * @returns 符合条件的技能列表
 */
export function useSkillsByLocation(location: SkillLocation): SkillDefinition[] {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);

  useEffect(() => {
    const updateSkills = () => {
      setSkills(skillRegistry.getByLocation(location));
    };
    updateSkills();
    const unsubscribe = subscribeToSkillRegistry(updateSkills);
    return unsubscribe;
  }, [location]);

  return skills;
}

// ============================================================================
// Hook: useAutoInvokeSkills
// ============================================================================

/**
 * 获取可自动激活的技能列表
 *
 * @returns 可自动激活的技能元数据列表
 */
export function useAutoInvokeSkills(): SkillMetadata[] {
  const [skills, setSkills] = useState<SkillMetadata[]>([]);

  useEffect(() => {
    const updateSkills = () => {
      setSkills(skillRegistry.getAllMetadata().filter((skill) => !skill.disableAutoInvoke));
    };
    updateSkills();
    const unsubscribe = subscribeToSkillRegistry(updateSkills);
    return unsubscribe;
  }, []);

  return skills;
}

// ============================================================================
// Hook: useSkillSearch
// ============================================================================

/**
 * 技能搜索 Hook
 *
 * @param searchTerm 搜索词
 * @returns 匹配的技能列表
 */
export function useSkillSearch(searchTerm: string): SkillMetadata[] {
  const [results, setResults] = useState<SkillMetadata[]>([]);

  useEffect(() => {
    const updateResults = () => {
      if (!searchTerm.trim()) {
        setResults(skillRegistry.getAllMetadata());
        return;
      }
      const term = searchTerm.toLowerCase();
      const translate = i18n.t.bind(i18n);
      setResults(skillRegistry.getAllMetadata().filter((skill) =>
        getLocalizedSkillName(skill.id, skill.name, translate).toLowerCase().includes(term) ||
        getLocalizedSkillDescription(skill.id, skill.description, translate).toLowerCase().includes(term) ||
        skill.id.toLowerCase().includes(term)
      ));
    };
    updateResults();
    const unsubscribe = subscribeToSkillRegistry(updateResults);
    return unsubscribe;
  }, [searchTerm]);

  return results;
}

// ============================================================================
// Hook: useSkillSummary
// ============================================================================

/**
 * 获取技能摘要信息
 *
 * @returns 技能摘要
 */
export function useSkillSummary(): {
  total: number;
  global: number;
  project: number;
  builtin: number;
  summary: string;
} {
  const [summary, setSummary] = useState({
    total: 0,
    global: 0,
    project: 0,
    builtin: 0,
    summary: '',
  });

  useEffect(() => {
    const updateSummary = () => {
      setSummary({
        total: skillRegistry.size,
        global: skillRegistry.getByLocation('global').length,
        project: skillRegistry.getByLocation('project').length,
        builtin: skillRegistry.getByLocation('builtin').length,
        summary: skillRegistry.generateSummary(),
      });
    };
    updateSummary();
    const unsubscribe = subscribeToSkillRegistry(updateSummary);
    return unsubscribe;
  }, []);

  return summary;
}
