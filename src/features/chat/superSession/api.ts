/**
 * Super 会话前端 API
 *
 * 封装后端 super_session_* 命令（全部 camelCase）与两个 Tauri 事件的订阅。
 * 侧栏、常驻控制器从这里导入。例外：src/stores/superAgentEnabledStore.ts 与设置页
 * （SuperAgentConfigPanel）受前端分层守卫约束不能 import 本模块，按同一命令名/载荷直接
 * invoke；修改命令契约时必须同步那两处。
 *
 * 契约：docs 方案第 6 节 / decisions/2026-11-01-super-agent.md
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DeliverOutcome } from '../core/types/store';

export type { DeliverOutcome };

// ============================================================================
// 类型
// ============================================================================

/** 后端 SuperSessionState */
export interface SuperSessionState {
  enabled: boolean;
  sessionId: string | null;
  workspaceId: string | null;
  pendingInbox: number;
}

/** 后端 SuperSessionSettings */
export interface SuperSessionSettings {
  instructions: string;
}

/** 事件 super_session_changed 载荷 */
export interface SuperSessionChangedPayload {
  enabled: boolean;
  sessionId: string | null;
}

/** 事件 super_session_inbox_changed 载荷 */
export interface SuperSessionInboxChangedPayload {
  sessionId: string;
  pendingInbox: number;
}

export const SUPER_SESSION_EVENTS = {
  CHANGED: 'super_session_changed',
  INBOX_CHANGED: 'super_session_inbox_changed',
} as const;

// ============================================================================
// 命令
// ============================================================================

function normalizeState(raw: Partial<SuperSessionState> | null | undefined): SuperSessionState {
  return {
    enabled: raw?.enabled === true,
    sessionId: typeof raw?.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    workspaceId: typeof raw?.workspaceId === 'string' && raw.workspaceId ? raw.workspaceId : null,
    pendingInbox:
      typeof raw?.pendingInbox === 'number' && Number.isFinite(raw.pendingInbox)
        ? Math.max(0, raw.pendingInbox)
        : 0,
  };
}

export async function getSuperSessionState(): Promise<SuperSessionState> {
  return normalizeState(await invoke<SuperSessionState>('super_session_get_state'));
}

export async function setSuperSessionEnabled(enabled: boolean): Promise<SuperSessionState> {
  return normalizeState(await invoke<SuperSessionState>('super_session_set_enabled', { enabled }));
}

export async function ensureSuperSession(): Promise<SuperSessionState> {
  return normalizeState(await invoke<SuperSessionState>('super_session_ensure'));
}

export async function getSuperSessionSettings(): Promise<SuperSessionSettings> {
  const raw = await invoke<SuperSessionSettings | null>('super_session_get_settings');
  return { instructions: typeof raw?.instructions === 'string' ? raw.instructions : '' };
}

export async function setSuperSessionSettings(settings: SuperSessionSettings): Promise<void> {
  await invoke<void>('super_session_set_settings', { settings });
}

// ============================================================================
// 事件订阅
// ============================================================================

/** 订阅 super_session_changed；返回 unlisten */
export function onSuperSessionChanged(
  handler: (payload: SuperSessionChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SuperSessionChangedPayload>(SUPER_SESSION_EVENTS.CHANGED, (event) => {
    const payload = event.payload;
    handler({
      enabled: payload?.enabled === true,
      sessionId: typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : null,
    });
  });
}

/** 订阅 super_session_inbox_changed；返回 unlisten */
export function onSuperSessionInboxChanged(
  handler: (payload: SuperSessionInboxChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SuperSessionInboxChangedPayload>(SUPER_SESSION_EVENTS.INBOX_CHANGED, (event) => {
    const payload = event.payload;
    if (typeof payload?.sessionId !== 'string') return;
    handler({
      sessionId: payload.sessionId,
      pendingInbox: typeof payload.pendingInbox === 'number' ? Math.max(0, payload.pendingInbox) : 0,
    });
  });
}
