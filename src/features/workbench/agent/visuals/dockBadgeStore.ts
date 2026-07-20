/**
 * ACR 4.0（A5）— Dock 后台完成角标数据层
 *
 * 语义（章程 §0 支柱 3）：agent 在**非前台聚焦**窗口上完成一个 run
 * （presence 进入 'done' 时该窗口不是 focusStack 栈顶）→ 该窗口所属应用的
 * Dock 图标显示小绿点；用户聚焦该窗口（或窗口被关闭）后清除。
 *
 * 依赖：presenceStore / windowStore 均**只读订阅**，不改写两者状态。
 * 渲染侧：DockItem 经 useDockAgentBadge(typeId) 消费；样式见 agent-visuals.css
 * （.wb-dock-agent-badge，淡入只动 opacity，reduced-motion / forced-colors 全路径）。
 */
import { create } from 'zustand';
import { usePresenceStore } from '../presenceStore';
import { useWindowStore } from '../../core/windowStore';
import type { PresenceState } from '../types';

interface DockAgentBadgeState {
  /** windowId -> typeId：后台完成、等待用户查看的窗口 */
  byWindow: Record<string, string>;
  markDone: (windowId: string, typeId: string) => void;
  clearWindow: (windowId: string) => void;
  clearAll: () => void;
}

export const useDockAgentBadgeStore = create<DockAgentBadgeState>((set) => ({
  byWindow: {},
  markDone: (windowId, typeId) =>
    set((s) =>
      s.byWindow[windowId] === typeId
        ? s
        : { byWindow: { ...s.byWindow, [windowId]: typeId } },
    ),
  clearWindow: (windowId) =>
    set((s) => {
      if (!(windowId in s.byWindow)) return s;
      const next = { ...s.byWindow };
      delete next[windowId];
      return { byWindow: next };
    }),
  clearAll: () => set({ byWindow: {} }),
}));

/** 该窗口是否前台聚焦（focusStack 栈顶；栈只含非 minimized 窗口） */
function isForegroundFocused(windowId: string): boolean {
  const { focusStack } = useWindowStore.getState();
  return focusStack[focusStack.length - 1] === windowId;
}

/**
 * 启动订阅（幂等清理由返回函数负责）：
 * - presence 变化：某窗口状态迁移到 'done' 且该窗口非前台聚焦 → 记录角标；
 * - windowStore 变化：带角标窗口获得前台焦点或被关闭 → 清除角标。
 *
 * 挂载位置：Dock（Dock 存续期间角标才有渲染意义）。
 */
export function startDockAgentBadgeTracking(): () => void {
  const unsubPresence = usePresenceStore.subscribe((state, prevState) => {
    const prev: Record<string, PresenceState> = prevState?.byWindow ?? {};
    for (const [windowId, presence] of Object.entries(state.byWindow)) {
      if (presence.status !== 'done') continue;
      if (prev[windowId]?.runKey === presence.runKey && prev[windowId]?.status === 'done') {
        continue;
      }
      if (isForegroundFocused(windowId)) continue;
      useDockAgentBadgeStore.getState().markDone(windowId, presence.typeId);
    }
  });

  const unsubWindows = useWindowStore.subscribe((state) => {
    const badges = useDockAgentBadgeStore.getState().byWindow;
    const topId = state.focusStack[state.focusStack.length - 1];
    for (const windowId of Object.keys(badges)) {
      if (windowId === topId || !state.windows[windowId]) {
        useDockAgentBadgeStore.getState().clearWindow(windowId);
      }
    }
  });

  return () => {
    unsubPresence();
    unsubWindows();
  };
}

/** DockItem 消费：该应用是否有「后台完成待查看」角标 */
export function useDockAgentBadge(typeId: string): boolean {
  return useDockAgentBadgeStore((s) => Object.values(s.byWindow).includes(typeId));
}
