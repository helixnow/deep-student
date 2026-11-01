/**
 * Super-agent 会话状态（前端镜像）：{ enabled, sessionId }。
 *
 * 权威状态在后端（主库 settings 的 `super_agent.enabled` + chat_v2_sessions 中
 * `metadata.super_agent.active` 的那一个会话）。前端只做镜像，用于：
 * - 设置页开关；
 * - 侧栏把 Super-agent 会话固定在置顶区最上面、删除后切到后端新建的会话。
 *
 * 镜像缓存在 localStorage 以避免启动时入口闪烁，随后以后端状态为准校正一次；
 * 后端在开关、删除重建等时机广播 `super_session_changed`，由 useSyncSuperAgentEnabled 订阅。
 *
 * 分层说明：本 store 位于 platform 层（ui 层侧栏与 features/settings 都要读），
 * 不能 import features/chat/superSession/api.ts（会形成 platform → feature 的上行依赖），
 * 因此直接 invoke 与其相同的命令（命令与载荷契约见 decisions/2026-11-01-super-agent.md）。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/** 后端 SuperSessionState（camelCase） */
export interface SuperSessionStateSnapshot {
  enabled: boolean;
  sessionId: string | null;
  workspaceId?: string | null;
  pendingInbox?: number;
}

/** 后端事件 super_session_changed 的载荷 */
export interface SuperSessionChangedPayload {
  enabled: boolean;
  sessionId: string | null;
}

export const SUPER_SESSION_CHANGED_EVENT = 'super_session_changed';

const superSessionCommands = {
  getState: () => invoke<SuperSessionStateSnapshot>('super_session_get_state'),
  setEnabled: (enabled: boolean) => invoke<SuperSessionStateSnapshot>('super_session_set_enabled', { enabled }),
};

const STORAGE_KEY = 'ds.superAgent.enabled';
const SESSION_STORAGE_KEY = 'ds.superAgent.sessionId';

function readCachedEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readCachedSessionId(): string | null {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function writeCached(enabled: boolean, sessionId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 隐私模式 / 禁用存储：忽略，镜像仅是体验优化
  }
}

function emitSessionsUpdated() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
}

interface SuperAgentEnabledState {
  enabled: boolean;
  /** 当前活跃 Super-agent 会话 id；未启用或尚未创建时为 null */
  sessionId: string | null;
  /** 后端是否已校正过镜像 */
  synced: boolean;
  /** 仅更新镜像（后端状态已由别处写入时使用，如 super_session_changed）；sessionId 省略时保持不变 */
  setMirror: (enabled: boolean, sessionId?: string | null) => void;
  /** 设置页开关：写后端，成功后更新镜像并派发 chat-v2:sessions-updated；失败则抛出且镜像不变 */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** 首次从后端校正镜像；后端不可用（如非 Tauri 环境）时保持现状 */
  syncFromBackend: () => Promise<void>;
  /** 强制重新读取后端状态（如删除 Super 会话后获取新建的 id）；失败返回 null 且镜像不变 */
  refresh: () => Promise<SuperSessionChangedPayload | null>;
}

let syncing: Promise<void> | null = null;

export const useSuperAgentEnabledStore = create<SuperAgentEnabledState>()((set, get) => ({
  enabled: readCachedEnabled(),
  sessionId: readCachedSessionId(),
  synced: false,
  setMirror: (enabled, sessionId) => {
    const nextSessionId = sessionId === undefined ? get().sessionId : sessionId;
    writeCached(enabled, nextSessionId);
    set({ enabled, sessionId: nextSessionId });
  },
  setEnabled: async (enabled) => {
    const state = await superSessionCommands.setEnabled(enabled);
    const nextEnabled = typeof state?.enabled === 'boolean' ? state.enabled : enabled;
    get().setMirror(nextEnabled, state?.sessionId ?? null);
    set({ synced: true });
    emitSessionsUpdated();
  },
  syncFromBackend: () => {
    if (get().synced) return Promise.resolve();
    syncing ??= get()
      .refresh()
      .then(() => undefined)
      .finally(() => {
        syncing = null;
      });
    return syncing;
  },
  refresh: async () => {
    try {
      const s = await superSessionCommands.getState();
      const next = { enabled: !!s?.enabled, sessionId: s?.sessionId ?? null };
      writeCached(next.enabled, next.sessionId);
      set({ ...next, synced: true });
      return next;
    } catch {
      // 后端未就绪：保持缓存值，下次挂载再试
      return null;
    }
  },
}));

/** 设置页等处使用：只读镜像，不发起后端调用（校正由 useSyncSuperAgentEnabled 负责）。 */
export function useSuperAgentEnabled(): boolean {
  return useSuperAgentEnabledStore((s) => s.enabled);
}

/** 当前活跃 Super-agent 会话 id（未启用时恒为 null）。 */
export function useSuperAgentSessionId(): string | null {
  return useSuperAgentEnabledStore((s) => (s.enabled ? s.sessionId : null));
}

/** 非 React 场景读取当前活跃 Super-agent 会话 id（未启用时为 null）。 */
export function getSuperAgentSessionId(): string | null {
  const { enabled, sessionId } = useSuperAgentEnabledStore.getState();
  return enabled ? sessionId : null;
}

/**
 * 挂载后从后端校正一次镜像，并订阅 super_session_changed（应用壳与设置页调用；渲染期间不做副作用）。
 */
export function useSyncSuperAgentEnabled(): void {
  useEffect(() => {
    void useSuperAgentEnabledStore.getState().syncFromBackend();

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<SuperSessionChangedPayload>(SUPER_SESSION_CHANGED_EVENT, (event) => {
        const payload = event.payload;
        if (!payload || typeof payload.enabled !== 'boolean') return;
        useSuperAgentEnabledStore.getState().setMirror(payload.enabled, payload.sessionId ?? null);
        emitSessionsUpdated();
      }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // 非 Tauri 环境（测试 / 浏览器预览）：没有事件总线，忽略
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
