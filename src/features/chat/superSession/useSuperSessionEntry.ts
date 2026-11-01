/**
 * 侧栏 Super-agent 入口数据（工作包 F 的 ModernSidebar / 移动端会话列表使用）
 *
 * - 启动时 super_session_get_state；订阅 super_session_changed 跟随开关 / 删除重建；
 * - 按 sessionId 用 chat_v2_get_session 拉取会话摘要（置顶在客户端计算，分页后
 *   Super 会话可能不在普通列表第一页，所以必须按 id 单独拉取，再由调用方从普通列表去重）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatSession } from '../types/session';
import { getSuperSessionState, onSuperSessionChanged } from './api';

export interface SuperSessionEntry {
  enabled: boolean;
  sessionId: string | null;
  /** 按 id 拉取的会话摘要；未启用 / 拉取失败为 null */
  session: ChatSession | null;
  /** 首次状态尚未返回 */
  loading: boolean;
  /** 重新拉取状态与摘要（如重命名后） */
  refresh: () => void;
}

export function useSuperSessionEntry(): SuperSessionEntry {
  const [enabled, setEnabled] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const mountedRef = useRef(true);

  const applyState = useCallback((next: { enabled: boolean; sessionId: string | null }) => {
    if (!mountedRef.current) return;
    setEnabled(next.enabled);
    setSessionId(next.enabled ? next.sessionId : null);
  }, []);

  // 状态：初次拉取 + 事件订阅
  useEffect(() => {
    mountedRef.current = true;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    void onSuperSessionChanged((payload) => {
      if (!disposed) applyState(payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 非 Tauri 环境 */
      });

    getSuperSessionState()
      .then((state) => {
        if (!disposed) applyState(state);
      })
      .catch(() => {
        /* 后端不可用：保持未启用 */
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, [applyState, refreshTick]);

  // 摘要：按 id 拉取
  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      return;
    }
    let cancelled = false;
    invoke<ChatSession | null>('chat_v2_get_session', { sessionId })
      .then((result) => {
        if (!cancelled) setSession(result ?? null);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  return { enabled, sessionId, session, loading, refresh };
}
