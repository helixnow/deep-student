/**
 * 最近访问记录存储
 *
 * 使用 zustand + persist 在前端维护最近访问的资源记录。
 * 由于后端暂未实现 accessedAt 字段和 dstu_list_recent API，
 * 采用前端方案先快速实现功能。
 *
 * @see 文档28-DSTU统一虚拟路径架构改造设计.md
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DstuNodeType } from '@/dstu/types';

/**
 * 最近访问项
 */
export interface RecentItem {
  /** 资源 ID */
  id: string;
  /** 资源路径（DSTU 虚拟路径） */
  path: string;
  /** 资源名称 */
  name: string;
  /** 资源类型 */
  type: DstuNodeType;
  /** 访问时间戳（毫秒） */
  accessedAt: number;
}

/**
 * 最近访问记录状态
 */
interface RecentState {
  /** 最近访问项列表（按访问时间倒序） */
  items: RecentItem[];
  /** 最大保存数量 */
  maxItems: number;

  /**
   * 添加访问记录
   *
   * - 如果资源已存在，会移到列表开头并更新访问时间
   * - 如果超过最大数量，会删除最旧的记录
   *
   * @param item 访问项（不含 accessedAt，自动添加当前时间）
   */
  addRecent: (item: Omit<RecentItem, 'accessedAt'>) => void;

  /**
   * 移除指定的访问记录
   * @param id 资源 ID
   */
  removeRecent: (id: string) => void;

  /**
   * 获取最近访问项列表
   * @returns 按访问时间倒序的列表
   */
  getRecentItems: () => RecentItem[];

  /**
   * 清空所有访问记录
   */
  clearRecent: () => void;
}

/**
 * 最近访问记录 Store
 *
 * 使用 localStorage 持久化，key 为 'learning-hub-recent'
 */
export const useRecentStore = create<RecentState>()(
  persist(
    (set, get) => ({
      items: [],
      maxItems: 50, // 默认保留最近50个访问记录

      addRecent: (item) => {
        const { items, maxItems } = get();

        // 移除已存在的同ID项（避免重复）
        const filtered = items.filter(i => i.id !== item.id);

        // 创建新记录并添加到开头
        const newItem: RecentItem = {
          ...item,
          accessedAt: Date.now(),
        };

        // 限制最大数量
        const newItems = [newItem, ...filtered].slice(0, maxItems);

        set({ items: newItems });
      },

      removeRecent: (id) => {
        set({ items: get().items.filter(i => i.id !== id) });
      },

      getRecentItems: () => {
        return get().items;
      },

      clearRecent: () => set({ items: [] }),
    }),
    {
      name: 'learning-hub-recent',
    }
  )
);
