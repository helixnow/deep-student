/**
 * 向笔记编辑器派发 canvas:ai-edit-request（Generative UI → HITL 写入链入口）
 *
 * 禁止 generative handler 直接调用 saveNoteContent / 后端 write API。
 * @see docs/generative-ui/NOTES_INTEGRATION.md
 */

import i18n from '@/i18n';
import type { CanvasEditOperation } from '@/features/notes/hooks/useAIEditState';
import { noteEditPayloadSchema } from './extractNoteEditPayload';

/** 派发护栏文案走 generativeUi:notes.*；defaultValue 兜底延迟命名空间加载窗口。 */
function dispatchReason(key: string, defaultValue: string): string {
  return String(i18n.t(`generativeUi:notes.${key}`, { defaultValue }));
}

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
    return {
      claimed: false,
      reason: dispatchReason('edit_dispatch_no_panel', '当前环境没有可用的建议面板'),
    };
  }

  // Defense in depth for direct handler callers that bypass extractNoteEditPayload.
  // In particular, never forward model-controlled regular expressions to the editor.
  const validation = noteEditPayloadSchema.safeParse(payload);
  if (!validation.success) {
    return {
      claimed: false,
      reason: dispatchReason('edit_dispatch_invalid', '笔记编辑建议无效或内容过大'),
    };
  }

  let result: CanvasAIEditDispatchResult = {
    claimed: false,
    reason: dispatchReason('edit_dispatch_unclaimed', '没有匹配的笔记编辑器认领建议'),
  };

  const sanitized = validation.data;
  window.dispatchEvent(
    new CustomEvent('canvas:ai-edit-request', {
      detail: {
        requestId: payload.requestId,
        noteId: payload.noteId,
        targetWindowId: payload.targetWindowId,
        operation: sanitized.operation,
        content: sanitized.content,
        search: sanitized.search,
        replace: sanitized.replace,
        section: sanitized.section,
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
