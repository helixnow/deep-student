/**
 * useMediaFocusListener — 监听 `media-ref:focus`（聊天 / 笔记的 `[媒体@id:mm:ss]` 跳转）
 *
 * 与 usePdfFocusListener 同构：匹配 resourceId（node.id / sourceId / path）后生成
 * focusRequest；媒体视图在播放器就绪并 seek 完成后调用 handled(requestId, true)
 * 回执派发方，停止重发。真实卸载时对所有 pending ack 显式回失败。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MEDIA_REF_FOCUS_EVENT, type MediaFocusEventDetail } from './mediaRefEvents';

export interface MediaFocusRequest {
  seconds: number;
  play: boolean;
  requestId: number;
  isStale?: () => boolean;
}

interface UseMediaFocusListenerOptions {
  enabled: boolean;
  focusScopeId?: string;
  nodeId: string;
  nodeSourceId?: string;
  nodePath?: string;
}

/** 资源 id 是否指向本视图（id / sourceId / `/id` 路径三者任一） */
export function matchesMediaFocusTarget(
  resourceId: string | undefined,
  node: { nodeId: string; nodeSourceId?: string; nodePath?: string },
): boolean {
  if (!resourceId) return false;
  const bare = resourceId.replace(/^\/+/, '');
  if (bare === node.nodeId || (node.nodeSourceId && bare === node.nodeSourceId)) return true;
  if (node.nodePath) {
    const path = node.nodePath.replace(/^\/+/, '');
    if (path === bare || path.endsWith(`/${bare}`)) return true;
  }
  return false;
}

export function useMediaFocusListener({
  enabled,
  focusScopeId,
  nodeId,
  nodeSourceId,
  nodePath,
}: UseMediaFocusListenerOptions): [
  MediaFocusRequest | null,
  (requestId: number, handled: boolean) => void,
] {
  const [focusRequest, setFocusRequest] = useState<MediaFocusRequest | null>(null);
  const requestIdRef = useRef(0);
  const pendingAcksRef = useRef(new Map<number, (handled: boolean) => void>());

  const handleFocusHandled = useCallback((requestId: number, handled: boolean) => {
    pendingAcksRef.current.get(requestId)?.(handled);
    pendingAcksRef.current.delete(requestId);
    setFocusRequest((prev) => (prev && prev.requestId === requestId ? null : prev));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MediaFocusEventDetail>).detail;
      if (!detail) return;
      if (detail.targetScopeId && detail.targetScopeId !== focusScopeId) return;
      const { resourceId, seconds } = detail;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return;
      if (!matchesMediaFocusTarget(resourceId, { nodeId, nodeSourceId, nodePath })) return;

      const requestId = ++requestIdRef.current;
      if (detail.acknowledge) {
        // 防泄漏兜底：派发方自带超时/重发，静默丢弃最旧的未消费 ack 是安全的
        while (pendingAcksRef.current.size >= 8) {
          const oldest = pendingAcksRef.current.keys().next().value;
          if (oldest === undefined) break;
          pendingAcksRef.current.delete(oldest);
        }
        pendingAcksRef.current.set(requestId, detail.acknowledge);
      }
      setFocusRequest({
        seconds,
        play: detail.play !== false,
        requestId,
        isStale: detail.isStale,
      });
    };
    document.addEventListener(MEDIA_REF_FOCUS_EVENT, handler);
    return () => document.removeEventListener(MEDIA_REF_FOCUS_EVENT, handler);
  }, [enabled, focusScopeId, nodeId, nodeSourceId, nodePath]);

  useEffect(() => {
    const pendingAcks = pendingAcksRef.current;
    return () => {
      for (const ack of pendingAcks.values()) {
        try {
          ack(false);
        } catch {
          /* 非关键 */
        }
      }
      pendingAcks.clear();
    };
  }, []);

  return [focusRequest, handleFocusHandled];
}
