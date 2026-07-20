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
}

export interface PdfFocusEventDetail {
  sourceId?: string;
  pageNumber?: number;
  path?: string;
  acknowledge?: (handled: boolean) => void;
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
      });
    };

    document.addEventListener('pdf-ref:focus', handler);
    return () => {
      document.removeEventListener('pdf-ref:focus', handler);
      // ★ 卸载/依赖变化重订阅时对 pending ack 保持静默（不回 false）：
      // - 立即回 false 会在视图切换 / StrictMode 重挂载时误报"跳转失败"，
      //   即使跳转随后被重挂载的实例正常完成；
      // - 唯一带 acknowledge 的派发方 requestPdfPageFocus（pdfFocusAck.ts）
      //   自带 1.5s 超时兜底并对 resolve 做了幂等保护，静默等价于
      //   "让真实结果（或超时）说话"；
      // - 其余派发方（useChatPageEvents / WorkbenchEventBridge）不传
      //   acknowledge，无影响。
      // pendingAcksRef 存于 ref，重订阅后 handleFocusHandled 仍可回 true。
    };
  }, [enabled, nodeId, nodeSourceId, nodePath, nodeName]);

  return [focusRequest, handleFocusHandled];
}
