import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isSubagentSession } from '../core/subagentSession';
import type { ChatSession } from '../types/session';

/**
 * 对话侧栏过滤偏好（纯前端过滤，不改后端分页）
 *
 * 默认隐藏子代理会话（subagent_call 创建：`subagent_`/`agent_` 前缀、
 * `mode='subagent'` 或 `metadata.is_subagent=true`——判定走
 * `core/subagentSession.ts` SSOT），用户可经侧栏过滤菜单切换显隐。
 *
 * 后续在此扩展排序策略等更多选项；所有侧栏派生列表（搜索/分组/置顶/最近）
 * 都应基于 `filterSidebarSessions` 的输出，保证口径一致。
 */
export interface SidebarFilterPrefs {
  /** 是否在侧栏显示子代理会话（默认 false = 不显示） */
  showSubagentSessions: boolean;
}

export const DEFAULT_SIDEBAR_FILTER_PREFS: SidebarFilterPrefs = {
  showSubagentSessions: false,
};

interface SidebarFilterPrefsState extends SidebarFilterPrefs {
  setShowSubagentSessions: (show: boolean) => void;
}

export const useSidebarFilterPrefs = create<SidebarFilterPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SIDEBAR_FILTER_PREFS,
      setShowSubagentSessions: (show) => set({ showSubagentSessions: show }),
    }),
    {
      name: 'chat-v2-sidebar-filter-prefs',
      version: 1,
      partialize: (state) => ({
        showSubagentSessions: state.showSubagentSessions,
      }),
    },
  ),
);

/** 当前偏好是否偏离默认配置（用于过滤按钮的激活态指示） */
export function isSidebarFilterModified(prefs: SidebarFilterPrefs): boolean {
  return prefs.showSubagentSessions !== DEFAULT_SIDEBAR_FILTER_PREFS.showSubagentSessions;
}

/**
 * 按过滤偏好筛选侧栏会话列表（SSOT）。
 * 注意：不过滤「当前会话」本身——子代理会话被打开时主区只读视图不受影响，
 * 仅列表不再展示。
 */
export function filterSidebarSessions(
  sessions: ChatSession[],
  prefs: SidebarFilterPrefs,
): ChatSession[] {
  if (prefs.showSubagentSessions) {
    return sessions;
  }
  return sessions.filter(
    (session) =>
      !isSubagentSession({
        sessionId: session.id,
        mode: session.mode,
        metadata: session.metadata ?? null,
      }),
  );
}
