/**
 * 技能收藏 React Hook
 *
 * 提供技能收藏状态的订阅和操作方法
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { skillFavorites } from '../skillFavorites';
import type { SkillDefinition } from '../types';

/**
 * 技能收藏 Hook 返回值
 */
export interface UseSkillFavoritesReturn {
  /** 所有收藏的技能 ID */
  favoriteIds: string[];
  /** 检查技能是否已收藏 */
  isFavorite: (skillId: string) => boolean;
  /** 切换收藏状态 */
  toggleFavorite: (skillId: string) => void;
  /** 添加收藏 */
  addFavorite: (skillId: string) => void;
  /** 移除收藏 */
  removeFavorite: (skillId: string) => void;
  /** 清空所有收藏 */
  clearFavorites: () => void;
  /** 对技能列表按收藏状态排序（收藏在前） */
  sortByFavorite: <T extends SkillDefinition>(skills: T[]) => T[];
}

/**
 * 技能收藏 Hook
 *
 * @example
 * ```tsx
 * const { favoriteIds, isFavorite, toggleFavorite, sortByFavorite } = useSkillFavorites();
 *
 * // 检查是否收藏
 * const isStarred = isFavorite('my-skill');
 *
 * // 切换收藏
 * <button onClick={() => toggleFavorite('my-skill')}>
 *   {isStarred ? '取消收藏' : '收藏'}
 * </button>
 *
 * // 排序（收藏在前）
 * const sortedSkills = sortByFavorite(skills);
 * ```
 */
export function useSkillFavorites(): UseSkillFavoritesReturn {
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => skillFavorites.getAll());

  // 订阅收藏变更
  useEffect(() => {
    const unsubscribe = skillFavorites.subscribe(() => {
      setFavoriteIds(skillFavorites.getAll());
    });
    return unsubscribe;
  }, []);

  const isFavorite = useCallback((skillId: string) => {
    return skillFavorites.isFavorite(skillId);
  }, []);

  const toggleFavorite = useCallback((skillId: string) => {
    skillFavorites.toggle(skillId);
  }, []);

  const addFavorite = useCallback((skillId: string) => {
    skillFavorites.add(skillId);
  }, []);

  const removeFavorite = useCallback((skillId: string) => {
    skillFavorites.remove(skillId);
  }, []);

  const clearFavorites = useCallback(() => {
    skillFavorites.clear();
  }, []);

  const sortByFavorite = useCallback(<T extends SkillDefinition>(skills: T[]): T[] => {
    const favoriteSet = new Set(favoriteIds);
    return [...skills].sort((a, b) => {
      const aFav = favoriteSet.has(a.id) ? 0 : 1;
      const bFav = favoriteSet.has(b.id) ? 0 : 1;
      return aFav - bFav;
    });
  }, [favoriteIds]);

  return useMemo(() => ({
    favoriteIds,
    isFavorite,
    toggleFavorite,
    addFavorite,
    removeFavorite,
    clearFavorites,
    sortByFavorite,
  }), [favoriteIds, isFavorite, toggleFavorite, addFavorite, removeFavorite, clearFavorites, sortByFavorite]);
}

export default useSkillFavorites;
