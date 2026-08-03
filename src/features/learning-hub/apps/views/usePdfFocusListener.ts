/**
 * usePdfFocusListener - 共享的 PDF 页码跳转事件监听 Hook
 *
 * 监听 `pdf-ref:focus` 自定义事件（来自聊天引用的页码跳转），
 * 匹配 sourceId 或 path 后生成 focusRequest。
 *
 * 供 TextbookContentView 和 FileContentView 复用。
 */

import { useState, useRef, useCallback, useEffect } from 'react';

export interface PdfFocusRequest {
  path?: string;
  name?: string;
  pageNumber: number;
  requestId: number;
  /**
   * ACR 4.0（A7）：派发方（pdfFocusAck）超时/失败后返回 true。
   * viewer 兑现 pendingFocus 前必须检查——回执已说失败的请求不得再兑现。
   */
  isStale?: () => boolean;
}

export interface PdfFocusEventDetail {
  sourceId?: string;
  pageNumber?: number;
  path?: string;
  acknowledge?: (handled: boolean) => void;
  /** 请求是否已被派发方判定失败（超时/卸载），见 PdfFocusRequest.isStale */
  isStale?: () => boolean;
}

interface UsePdfFocusListenerOptions {
  /** 是否启用（仅 PDF 类型时启用） */
  enabled: boolean;
  /** 节点 ID */
  nodeId: string;
  /** 节点 sourceId（用于匹配引用来源） */
  nodeSourceId?: string;
  /** 节点路径 */
  nodePath?: string;
  /** 节点文件名 */
  nodeName?: string;
}

/**
 * PDF 页码跳转事件监听 Hook
 *
 * @returns [focusRequest, handleFocusHandled] 当前跳转请求和处理完成回调
 */
export function usePdfFocusListener({
  enabled,
  nodeId,
  nodeSourceId,
  nodePath,
  nodeName,
}: UsePdfFocusListenerOptions): [PdfFocusRequest | null, (requestId: number) => void] {
  const [focusRequest, setFocusRequest] = useState<PdfFocusRequest | null>(null);
  const focusRequestIdRef = useRef(0);
  const pendingAcksRef = useRef(new Map<number, (handled: boolean) => void>());

  const handleFocusHandled = useCallback((requestId: number) => {
    pendingAcksRef.current.get(requestId)?.(true);
    pendingAcksRef.current.delete(requestId);
    setFocusRequest((prev) => (prev && prev.requestId === requestId ? null : prev));
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<PdfFocusEventDetail>;
      const { sourceId, pageNumber, path } = customEvent.detail || {};
      if (!pageNumber || !Number.isFinite(pageNumber) || pageNumber <= 0) return;

      const matchesSource = sourceId && (sourceId === nodeId || sourceId === nodeSourceId);
      const matchesPath = path && path === nodePath;
      if (!matchesSource && !matchesPath) return;

      const requestId = ++focusRequestIdRef.current;
      if (customEvent.detail?.acknowledge) {
        // 防泄漏兜底：未被 handleFocusHandled 消费的旧 ack 只保留有限个。
        // 静默丢弃是安全的——派发方（pdfFocusAck.requestPdfPageFocus）自带
        // 1.5s 超时兜底，且 finish 有幂等保护。
        while (pendingAcksRef.current.size >= 8) {
          const oldestKey = pendingAcksRef.current.keys().next().value;
          if (oldestKey === undefined) break;
          pendingAcksRef.current.delete(oldestKey);
        }
        pendingAcksRef.current.set(requestId, customEvent.detail.acknowledge);
      }
      setFocusRequest({
        path: nodePath,
        name: nodeName,
        pageNumber,
        requestId,
        isStale: customEvent.detail?.isStale,
      });
    };

    document.addEventListener('pdf-ref:focus', handler);
    return () => {
      document.removeEventListener('pdf-ref:focus', handler);
      // ★ 依赖变化重订阅时对 pending ack 保持静默（不回 false）：
      // - 立即回 false 会在视图切换（同实例换 node）时误报"跳转失败"，
      //   即使跳转随后被同实例的 viewer 正常完成；
      // - 派发方 requestPdfPageFocus（pdfFocusAck.ts）自带 1.5s 超时兜底并对
      //   resolve 做了幂等保护，静默等价于"让真实结果（或超时）说话"；
      // - 真实卸载的显式失败回执见下面的 unmount-only effect。
      // pendingAcksRef 存于 ref，重订阅后 handleFocusHandled 仍可回 true。
    };
  }, [enabled, nodeId, nodeSourceId, nodePath, nodeName]);

  // ★ ACR 4.0（A7）：组件真实卸载时对所有 pending ack 显式回失败，
  // 不再留给 1.5s 超时——派发方立即拿到失败回执并把请求标记 stale，
  // 后续挂载的 viewer 也不会再兑现（消除「回执失败但跳页仍发生」竞态）。
  // 空依赖 effect 的 cleanup 只在卸载（含 StrictMode 探测性卸载，彼时
  // pendingAcks 必为空）时运行，不影响上面 effect 的重订阅语义。
  useEffect(() => {
    const pendingAcks = pendingAcksRef.current;
    return () => {
      for (const ack of pendingAcks.values()) {
        try {
          ack(false);
        } catch {
          /* 非关键：ack 通知失败不影响卸载 */
        }
      }
      pendingAcks.clear();
    };
  }, []);

  return [focusRequest, handleFocusHandled];
}
