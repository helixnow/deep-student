/**
 * 技能收藏管理
 *
 * 用户可以收藏常用技能，收藏的技能在列表中优先显示。
 * 使用 localStorage 持久化存储。
 *
 * 基于 PersistentSetManager 实现，扩展了 isFavorite 语义方法。
 */

import { PersistentSetManager } from './PersistentSetManager';

const manager = new PersistentSetManager('dstu-skill-favorites', 'SkillFavorites');

/**
 * 技能收藏管理器（公共 API 保持不变）
 */
export const skillFavorites = {
  /** 添加收藏 */
  add: (skillId: string) => manager.add(skillId),

  /** 移除收藏 */
  remove: (skillId: string) => manager.remove(skillId),

  /** 切换收藏状态 */
  toggle: (skillId: string) => manager.toggle(skillId),

  /** 检查是否已收藏 */
  isFavorite: (skillId: string) => manager.has(skillId),

  /** 获取所有收藏的技能 ID */
  getAll: () => manager.getAll(),

  /** 清空收藏 */
  clear: () => manager.clear(),

  /** 订阅变更 */
  subscribe: (listener: () => void) => manager.subscribe(listener),
};
