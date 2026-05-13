/**
 * Chat V2 - useLoadedSkills Hook
 *
 * 订阅会话中通过工具调用加载的技能状态
 * 用于 UI 实时显示技能激活状态
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getLoadedSkills,
  subscribeToLoadedSkills,
  type LoadedSkillInfo,
} from '../progressiveDisclosure';

/**
 * 订阅会话已加载技能状态的 Hook
 *
 * @param sessionId 会话 ID
 * @returns 已加载的技能 ID 集合和技能信息列表
 */
export function useLoadedSkills(sessionId: string | null): {
  /** 已加载的技能 ID 集合（用于快速查找） */
  loadedSkillIds: Set<string>;
  /** 已加载的技能详细信息列表 */
  loadedSkills: LoadedSkillInfo[];
  /** 检查某个技能是否已通过工具调用加载 */
  isSkillLoaded: (skillId: string) => boolean;
} {
  const [loadedSkillIds, setLoadedSkillIds] = useState<Set<string>>(new Set());
  const [loadedSkills, setLoadedSkills] = useState<LoadedSkillInfo[]>([]);

  // 初始加载 + 订阅变化
  useEffect(() => {
    if (!sessionId) {
      setLoadedSkillIds(new Set());
      setLoadedSkills([]);
      return;
    }

    // 初始加载
    const initial = getLoadedSkills(sessionId);
    setLoadedSkills(initial);
    setLoadedSkillIds(new Set(initial.map(s => s.id)));

    // 订阅变化
    const unsubscribe = subscribeToLoadedSkills((changedSessionId, skillIds) => {
      if (changedSessionId === sessionId) {
        const skills = getLoadedSkills(sessionId);
        setLoadedSkills(skills);
        setLoadedSkillIds(new Set(skillIds));
      }
    });

    return unsubscribe;
  }, [sessionId]);

  const isSkillLoaded = useCallback(
    (skillId: string) => loadedSkillIds.has(skillId),
    [loadedSkillIds]
  );

  return {
    loadedSkillIds,
    loadedSkills,
    isSkillLoaded,
  };
}
