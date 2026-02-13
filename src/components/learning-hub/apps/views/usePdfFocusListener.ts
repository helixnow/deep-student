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

  const handleFocusHandled = useCallback((requestId: number) => {
    setFocusRequest((prev) => (prev && prev.requestId === requestId ? null : prev));
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{
        sourceId?: string;
        pageNumber?: number;
        path?: string;
      }>;
      const { sourceId, pageNumber, path } = customEvent.detail || {};
      if (!pageNumber || !Number.isFinite(pageNumber) || pageNumber <= 0) return;

      const matchesSource = sourceId && (sourceId === nodeId || sourceId === nodeSourceId);
      const matchesPath = path && path === nodePath;
      if (!matchesSource && !matchesPath) return;

      const requestId = ++focusRequestIdRef.current;
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
    };
  }, [enabled, nodeId, nodeSourceId, nodePath, nodeName]);

  return [focusRequest, handleFocusHandled];
}
