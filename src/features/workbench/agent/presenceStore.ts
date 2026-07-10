/**
 * ACR presence 真相源 — R1-06
 * 消费方：WindowShell 光环 / AgentStrip / DevPanel。驱动器不得直接改 DOM 光环。
 * 见 docs/dev/acr/DESIGN.md §4.1（TTL 心跳由 StageManager 续期）。
 */
import { create } from 'zustand';
import type { AcrRunStatus, PresenceState } from './types';

interface PresenceStoreState {
  /** windowId -> presence（一窗同时最多一个 run，租约互斥由 StageManager 保证） */
  byWindow: Record<string, PresenceState>;
  setPresence: (p: PresenceState) => void;
  /** 更新状态；传入 label 时同步覆盖（AgentStrip 文案） */
  updateStatus: (runId: string, status: AcrRunStatus, label?: string) => void;
  /** 心跳续期：刷新 startedAt，使 ttl 从现在起重新计时 */
  renew: (runId: string) => void;
  clearByRun: (runId: string) => void;
  clearAll: () => void;
  /**
   * R2-06：清除 TTL 过期条目（无心跳续期的泄漏 presence）。
   * 返回被清除的 runId 列表（去重）。
   */
  sweepExpired: (now?: number) => string[];
}

/** 是否已超过 presence.ttlMs（未续期） */
export function isPresenceExpired(p: PresenceState, now = Date.now()): boolean {
  return now - p.startedAt > p.ttlMs;
}

export const usePresenceStore = create<PresenceStoreState>((set, get) => ({
  byWindow: {},
  setPresence: (p) =>
    set((s) => ({ byWindow: { ...s.byWindow, [p.windowId]: p } })),
  updateStatus: (runId, status, label) =>
    set((s) => {
      const next: Record<string, PresenceState> = {};
      for (const [wid, p] of Object.entries(s.byWindow)) {
        next[wid] =
          p.runId === runId
            ? { ...p, status, label: label !== undefined ? label : p.label }
            : p;
      }
      return { byWindow: next };
    }),
  renew: (runId) =>
    set((s) => {
      const next: Record<string, PresenceState> = {};
      const now = Date.now();
      for (const [wid, p] of Object.entries(s.byWindow)) {
        next[wid] = p.runId === runId ? { ...p, startedAt: now } : p;
      }
      return { byWindow: next };
    }),
  clearByRun: (runId) =>
    set((s) => {
      const next: Record<string, PresenceState> = {};
      for (const [wid, p] of Object.entries(s.byWindow)) {
        if (p.runId !== runId) next[wid] = p;
      }
      return { byWindow: next };
    }),
  clearAll: () => set({ byWindow: {} }),
  sweepExpired: (now = Date.now()) => {
    const expiredRunIds: string[] = [];
    const next: Record<string, PresenceState> = {};
    for (const [wid, p] of Object.entries(get().byWindow)) {
      if (isPresenceExpired(p, now)) {
        if (!expiredRunIds.includes(p.runId)) expiredRunIds.push(p.runId);
      } else {
        next[wid] = p;
      }
    }
    if (expiredRunIds.length > 0) set({ byWindow: next });
    return expiredRunIds;
  },
}));

/** 便捷 selector：某窗口当前 presence（无则 undefined） */
export function useWindowPresence(windowId: string): PresenceState | undefined {
  return usePresenceStore((s) => s.byWindow[windowId]);
}
