/**
 * Super 会话常驻控制器的可观察状态（供暂停提示条订阅）。
 *
 * 只由 residentController 写入；UI 只读并通过 controller.resume() 触发继续投递。
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/** 自动投递暂停原因：用户主动停止 / 后端连续自动回合达到上限 */
export type SuperInboxPauseReason = 'user_stop' | 'auto_limit';

export interface SuperResidentState {
  /** 当前常驻（持有 lease）的 Super 会话 ID；未启用为 null */
  sessionId: string | null;
  workspaceId: string | null;
  /** 后端收件箱待处理条数（最近一次 get_state / inbox_changed 的值） */
  pendingInbox: number;
  /** 暂停原因；null = 自动投递正常运行 */
  pausedReason: SuperInboxPauseReason | null;
  /** auto_limit 时后端报告的连续自动回合数 */
  autoTurns: number;
  /** 用户点击「继续处理」后的强制投递进行中 */
  resuming: boolean;
}

export const INITIAL_SUPER_RESIDENT_STATE: SuperResidentState = {
  sessionId: null,
  workspaceId: null,
  pendingInbox: 0,
  pausedReason: null,
  autoTurns: 0,
  resuming: false,
};

export const superResidentStore = createStore<SuperResidentState>(() => ({
  ...INITIAL_SUPER_RESIDENT_STATE,
}));

export function useSuperResidentState<T>(selector: (state: SuperResidentState) => T): T {
  return useStore(superResidentStore, selector);
}

/** 提示条是否应显示：已暂停，且（预算暂停 或 仍有待处理事件） */
export function shouldShowPausedBanner(state: SuperResidentState, sessionId: string | null): boolean {
  if (!sessionId || state.sessionId !== sessionId) return false;
  if (state.pausedReason === null) return false;
  return state.pausedReason === 'auto_limit' || state.pendingInbox > 0;
}
