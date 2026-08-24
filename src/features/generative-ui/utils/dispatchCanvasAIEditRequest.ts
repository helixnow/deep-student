/**
 * 向笔记编辑器派发 canvas:ai-edit-request（Generative UI → HITL 写入链入口）
 *
 * 禁止 generative handler 直接调用 saveNoteContent / 后端 write API。
 * @see docs/generative-ui/NOTES_INTEGRATION.md
 */

import type { CanvasEditOperation } from '@/features/notes/hooks/useAIEditState';

export interface CanvasAIEditDispatchPayload {
  requestId: string;
  noteId: string;
  targetWindowId?: string;
  operation: CanvasEditOperation;
  content?: string;
  search?: string;
  replace?: string;
  isRegex?: boolean;
  section?: string;
}

export interface CanvasAIEditDispatchResult {
  claimed: boolean;
  reason?: string;
}

/** 生成唯一 requestId（浏览器 / SSR 安全） */
export function createCanvasEditRequestId(prefix = 'gen-ui'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 派发 canvas:ai-edit-request CustomEvent。
 * 认领方（useCanvasAIEditHandler）经 onLocalDisposition 回传是否被接受展示。
 */
export function dispatchCanvasAIEditRequest(
  payload: CanvasAIEditDispatchPayload,
  options?: { onSettled?: () => void },
): CanvasAIEditDispatchResult {
  if (typeof window === 'undefined') {
    return { claimed: false, reason: '当前环境没有可用的建议面板' };
  }

  let result: CanvasAIEditDispatchResult = {
    claimed: false,
    reason: '没有匹配的笔记编辑器认领建议',
  };

  window.dispatchEvent(
    new CustomEvent('canvas:ai-edit-request', {
      detail: {
        ...payload,
        onSettled: options?.onSettled,
        onLocalDisposition: (disposition: { accepted: boolean; reason?: string }) => {
          result = disposition.accepted
            ? { claimed: true }
            : { claimed: false, reason: disposition.reason ?? result.reason };
        },
      },
    }),
  );

  return result;
}
