/**
 * Learning Hub 标签页类型定义
 *
 * 支持多标签页打开资源，通过 display:none 保活非活跃标签页的组件状态。
 */

import { nanoid } from 'nanoid';
import type { ResourceType } from '../types';

/**
 * 已打开的标签页信息
 */
export interface OpenTab {
  /** 标签页唯一标识（nanoid 生成，与 resourceId 无关） */
  tabId: string;
  /** 资源类型 */
  type: ResourceType;
  /** 资源 ID（对应 DstuNode.id） */
  resourceId: string;
  /** DSTU 真实路径 */
  dstuPath: string;
  /** 显示标题 */
  title: string;
  /** 是否固定 */
  isPinned?: boolean;
  /** 打开时间戳（用于 LRU 淘汰） */
  openedAt: number;
}

/** 标签页数量上限 */
export const MAX_TABS = 20;

/**
 * 创建新标签页（自动生成 tabId 和 openedAt）
 */
export function createTab(app: Omit<OpenTab, 'tabId' | 'openedAt'>): OpenTab {
  return { ...app, tabId: nanoid(8), openedAt: Date.now() };
}
