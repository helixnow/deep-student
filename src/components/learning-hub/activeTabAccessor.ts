/**
 * activeTabAccessor - 轻量级全局活跃标签页访问器
 *
 * 供 CommandPalette 等外部模块获取当前活跃标签页信息。
 * LearningHubPage 在 activeTab 变化时调用 setActiveTabForExternal 同步。
 */

import type { OpenTab } from './types/tabs';

let _activeTab: OpenTab | null = null;

/** 获取当前活跃标签页（供外部模块调用） */
export function getActiveTab(): OpenTab | null {
  return _activeTab;
}

/** 由 LearningHubPage 调用，同步活跃标签页 */
export function setActiveTabForExternal(tab: OpenTab | null): void {
  _activeTab = tab;
}
