import { useEffect, useRef, useCallback, useState } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import type { CrepeEditorApi } from '@/components/crepe';
import { registerNoteAIEditControl } from '../aiEditControlRegistry';
import {
  useAIEditState,
  computeProposedContent,
  computeDiffLines,
  type CanvasAIEditRequest,
  type CanvasAIEditResult,
  type AIEditState,
  type DiffLine,
  type CanvasEditOperation,
} from './useAIEditState';

interface UseCanvasAIEditHandlerOptions {
  noteId: string | null | undefined;
  editorApi: CrepeEditorApi | null;
  onSave?: (content: string) => Promise<void>;
  enabled?: boolean;
  windowId?: string;
}

type LocalSuggestionDisposition =
  | { accepted: true }
  | { accepted: false; reason: string };

type LocalCanvasAIEditRequest = CanvasAIEditRequest & {
  onLocalDisposition?: (disposition: LocalSuggestionDisposition) => void;
  /**
   * ACR 4.0：建议生命周期终结回调（Accept/Reject/切换笔记/编辑器卸载）。
   * noteDriver 用它清除 reviewing presence。
   */
  onSettled?: () => void;
};

/** ★ 2.1 AI 编辑检查点：接受后仍可回滚整轮（P2 起为每笔记栈，上限 MAX_AI_EDIT_CHECKPOINTS 条） */
export interface AIEditCheckpoint {
  /** 栈条目 id（回滚/忽略按 id 定位） */
  id: string;
  /** 编辑前的完整内容 */
  originalContent: string;
  /** 编辑后的完整内容（回滚安全性基线：current !== resultContent 时该条不可回滚） */
  resultContent: string;
  /** 应用时间戳 */
  appliedAt: number;
  /** 所属笔记（切换笔记后检查点失效） */
  noteId: string;
  /** 冲突标记：内容已偏离 resultContent（用户中间编辑/其他写入），不可回滚不强行覆盖 */
  stale?: boolean;
  /** accept 时重算的行级 diff（等待期间用户编辑会使 startEdit 时的 diff 陈旧） */
  diffLines: DiffLine[];
  /** 触发该次编辑的操作摘要（人读核对用） */
  operation: CanvasEditOperation;
}

/** 每笔记 checkpoint 栈上限（超出丢弃最旧） */
export const MAX_AI_EDIT_CHECKPOINTS = 5;

interface UseCanvasAIEditHandlerReturn {
  aiEditState: AIEditState;
  handleAccept: () => Promise<void>;
  handleReject: () => Promise<void>;
  isLocked: boolean;
  isApplying: boolean;
  /** ★ 2.1 已接受 AI 编辑的检查点栈（新→旧在尾部；只有栈顶可回滚，顺序 undo） */
  checkpoints: AIEditCheckpoint[];
  /** 栈顶条目（back-compat：单槽时代的 checkpoint） */
  checkpoint: AIEditCheckpoint | null;
  /** ★ 2.1 回滚栈顶检查点（恢复 AI 编辑前内容并落盘；冲突时标记 stale 不覆盖） */
  rollbackCheckpoint: (checkpointId?: string) => Promise<void>;
  /** ★ 2.1 放弃检查点（无 id 清空全部；有 id 移除指定条） */
  dismissCheckpoint: (checkpointId?: string) => void;
}

export function useCanvasAIEditHandler({
  noteId,
  editorApi,
  onSave,
  enabled = true,
  windowId,
}: UseCanvasAIEditHandlerOptions): UseCanvasAIEditHandlerReturn {
  const noteIdRef = useRef(noteId);
  const editorApiRef = useRef(editorApi);
  const onSaveRef = useRef(onSave);
  const windowIdRef = useRef(windowId);

  const { state: aiEditState, startEdit, accept, reject, clear } = useAIEditState();
  const [isApplying, setIsApplying] = useState(false);
  const isApplyingRef = useRef(false);
  const pendingRequestRef = useRef<LocalCanvasAIEditRequest | null>(null);

  // ACR 4.0：建议生命周期终结（清 pending 引用 + 通知 noteDriver 清 reviewing presence）
  const settlePendingRequest = useCallback(() => {
    const pending = pendingRequestRef.current;
    pendingRequestRef.current = null;
    try {
      pending?.onSettled?.();
    } catch (err) {
      console.warn('[useCanvasAIEditHandler] onSettled callback failed:', err);
    }
  }, []);

  // ★ 2.1 AI 编辑检查点栈（P2：单槽 → 每笔记栈，上限 MAX_AI_EDIT_CHECKPOINTS）
  const [checkpoints, setCheckpoints] = useState<AIEditCheckpoint[]>([]);
  const checkpointsRef = useRef<AIEditCheckpoint[]>([]);
  checkpointsRef.current = checkpoints;

  // 切换笔记后检查点栈失效（回滚目标已不在编辑器中）
  useEffect(() => {
    setCheckpoints((prev) => (prev.length > 0 && prev[0].noteId !== noteId ? [] : prev));
  }, [noteId]);

  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  useEffect(() => {
    editorApiRef.current = editorApi;
  }, [editorApi]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    windowIdRef.current = windowId;
  }, [windowId]);

  const sendResult = useCallback(async (result: CanvasAIEditResult) => {
    // ACR R2-03：noteDriver 建议模式经 window CustomEvent 派发，工具已立即回执
    // suggestionPending；此时 Rust 侧无 oneshot 等待。仍尝试上报（兼容旧
    // execute_write_frontend 路径），失败仅 debug，不阻断 Accept/Reject UI。
    try {
      await invoke('chat_v2_canvas_edit_result', { result });
      console.log('[useCanvasAIEditHandler] Sent result:', result.requestId, result.success);
    } catch (err) {
      console.debug('[useCanvasAIEditHandler] Result notify skipped/failed (ACR suggestion ok):', err);
    }
  }, []);

  const handleAccept = useCallback(async () => {
    if (isApplyingRef.current) return;

    // 保留 diff，直到编辑器应用和持久化都成功；任一步失败都允许原地重试。
    const acceptResult = accept({ clear: false });
    if (!acceptResult) return;

    const { result, originalContent, request } = acceptResult;
    let { proposedContent } = acceptResult;
    const editor = editorApiRef.current;
    isApplyingRef.current = true;
    setIsApplying(true);

    try {
      if (!editor || editor.isReadonly()) {
        await sendResult({
          requestId: result.requestId,
          success: false,
          error: i18n.t('vfs:canvas_edit.editor_readonly', { defaultValue: '编辑器不可写，修改未应用' }),
        });
        return;
      }

      // ★ 2.1 接受前记录检查点（编辑前全文），接受后仍可整轮回滚
      const contentBeforeApply = editor.getFullMarkdown?.() ?? editor.getMarkdown();

      // 内联 diff 下编辑器保持可编辑：若等待确认期间用户改了文档，
      // 按最新全文重算建议，避免整体覆盖时吃掉用户编辑。
      if (contentBeforeApply !== originalContent) {
        const recomputed = computeProposedContent(request, contentBeforeApply);
        if (recomputed.error) {
          clear();
          settlePendingRequest();
          await sendResult({
            requestId: result.requestId,
            success: false,
            error: i18n.t('vfs:canvas_edit.doc_changed_while_pending', {
              defaultValue: '文档在等待确认期间已被修改，建议无法应用：{{error}}',
              error: recomputed.error,
            }),
          });
          return;
        }
        proposedContent = recomputed.content;
        if (recomputed.replaceCount !== undefined) {
          result.replaceCount = recomputed.replaceCount;
        }
      }

      try {
        if (editor.replaceFullMarkdown) {
          const replaced = await editor.replaceFullMarkdown(proposedContent, {
            expectedMarkdown: contentBeforeApply,
          });
          if (!replaced) {
            throw new Error(i18n.t('vfs:canvas_edit.apply_rejected', { defaultValue: '编辑器拒绝应用建议' }));
          }
        } else {
          if (!editor.setMarkdown(proposedContent)) {
            throw new Error(i18n.t('vfs:canvas_edit.apply_rejected', { defaultValue: '编辑器拒绝应用建议' }));
          }
          if (onSaveRef.current) {
            await onSaveRef.current(proposedContent);
          }
        }
      } catch (err) {
        const contentAfterFailure = editor.getFullMarkdown?.() ?? editor.getMarkdown();
        if (contentAfterFailure === proposedContent) {
          try {
            if (editor.replaceFullMarkdown) {
              const restored = await editor.replaceFullMarkdown(contentBeforeApply, {
                expectedMarkdown: proposedContent,
              });
              if (!restored) {
                throw new Error(i18n.t('vfs:canvas_edit.restore_rejected', { defaultValue: '编辑器拒绝恢复建议前内容' }));
              }
            } else if (!editor.setMarkdown(contentBeforeApply)) {
              throw new Error(i18n.t('vfs:canvas_edit.restore_rejected', { defaultValue: '编辑器拒绝恢复建议前内容' }));
            }
          } catch (restoreErr) {
            console.warn('[useCanvasAIEditHandler] Failed to restore after apply error:', restoreErr);
          }
        }
        await sendResult({
          requestId: result.requestId,
          success: false,
          error: err instanceof Error
            ? err.message
            : i18n.t('vfs:canvas_edit.apply_failed', { defaultValue: '应用编辑建议失败' }),
          beforePreview: result.beforePreview,
          afterPreview: result.afterPreview,
          addedContent: result.addedContent,
        });
        return;
      }

      clear();
      settlePendingRequest();
      if (noteIdRef.current) {
        // P2：accept 时补算 diffLines（等待确认期间的用户编辑会使 startEdit 时的 diff 陈旧），
        // 随检查点入栈供回滚与核对。
        const entry: AIEditCheckpoint = {
          id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          originalContent: contentBeforeApply,
          resultContent: proposedContent,
          appliedAt: Date.now(),
          noteId: noteIdRef.current,
          diffLines: computeDiffLines(contentBeforeApply, proposedContent),
          operation: request.operation,
        };
        setCheckpoints((prev) => [...prev.slice(-(MAX_AI_EDIT_CHECKPOINTS - 1)), entry]);
      }
      await sendResult(result);
    } finally {
      isApplyingRef.current = false;
      setIsApplying(false);
    }
  }, [accept, clear, sendResult, settlePendingRequest]);

  // ★ 2.1 回滚栈顶检查点（顺序 undo：只有栈顶可回滚；冲突标记 stale 不强行覆盖）
  const rollbackCheckpoint = useCallback(async (checkpointId?: string) => {
    const stack = checkpointsRef.current;
    const top = stack[stack.length - 1];
    if (!top) return;
    if (checkpointId && checkpointId !== top.id) {
      console.warn('[useCanvasAIEditHandler] Rollback rejected: not the top checkpoint', checkpointId);
      return;
    }
    const editor = editorApiRef.current;
    if (!editor || editor.isReadonly()) {
      console.warn('[useCanvasAIEditHandler] Rollback skipped: editor not writable');
      return;
    }

    // 冲突检测：当前内容偏离该条的 resultContent（用户中间编辑/其他写入）→
    // 标记不可回滚，不强行覆盖（P2 冲突语义）。
    const current = editor.getFullMarkdown?.() ?? editor.getMarkdown();
    if (current !== top.resultContent) {
      setCheckpoints((prev) => prev.map((e) => (e.id === top.id ? { ...e, stale: true } : e)));
      console.warn('[useCanvasAIEditHandler] Rollback rejected: content diverged, checkpoint marked stale');
      return;
    }

    try {
      if (editor.replaceFullMarkdown) {
        const restored = await editor.replaceFullMarkdown(top.originalContent, {
          expectedMarkdown: current,
        });
        if (!restored) {
          throw new Error(i18n.t('vfs:canvas_edit.rollback_rejected', { defaultValue: '编辑器拒绝回滚检查点' }));
        }
      } else if (!editor.setMarkdown(top.originalContent)) {
        throw new Error(i18n.t('vfs:canvas_edit.rollback_rejected', { defaultValue: '编辑器拒绝回滚检查点' }));
      }
    } catch (err) {
      console.warn('[useCanvasAIEditHandler] Rollback apply failed:', err);
      return;
    }
    if (!editor.replaceFullMarkdown && onSaveRef.current) {
      try {
        await onSaveRef.current(top.originalContent);
      } catch (err) {
        console.warn('[useCanvasAIEditHandler] Rollback save failed:', err);
        // 保留 checkpoint，允许用户稍后再次触发回滚保存；不要把未落盘状态伪装成完成。
        return;
      }
    }
    setCheckpoints((prev) => prev.slice(0, -1));
  }, []);

  const dismissCheckpoint = useCallback((checkpointId?: string) => {
    setCheckpoints((prev) => (
      checkpointId ? prev.filter((e) => e.id !== checkpointId) : []
    ));
  }, []);

  const handleReject = useCallback(async () => {
    if (isApplyingRef.current) return;
    const result = reject();
    if (!result) return;

    settlePendingRequest();
    await sendResult(result);
  }, [reject, sendResult, settlePendingRequest]);

  // P2 人机双写 #4：向 generative-ui action undo 暴露查询/回滚通道
  // （未 accept = 撤回建议；已 accept = checkpoint 栈顶回滚）。
  useEffect(() => {
    if (!noteId || !enabled) return;
    return registerNoteAIEditControl(noteId, {
      hasPendingSuggestion: () => pendingRequestRef.current != null,
      rejectPendingSuggestion: async () => {
        if (pendingRequestRef.current != null) {
          await handleReject();
        }
      },
      rollbackLatestCheckpoint: async () => {
        const top = checkpointsRef.current[checkpointsRef.current.length - 1];
        if (!top || top.stale) return false;
        await rollbackCheckpoint();
        // rollbackCheckpoint 冲突时会把条目标记 stale 而不出栈——以出栈与否判定成败
        return checkpointsRef.current[checkpointsRef.current.length - 1]?.id !== top.id;
      },
    });
  }, [noteId, enabled, handleReject, rollbackCheckpoint]);

  const handleEditRequest = useCallback(
    async (request: LocalCanvasAIEditRequest) => {
      console.log('[useCanvasAIEditHandler] Received edit request:', request.requestId, request.operation);

      // ★ R2 修复：非目标实例静默忽略。
      // 之前这里会立即回复"笔记未打开"失败，抢先消费后端的 oneshot 回调，
      // 导致目标实例随后的真实结果（diff 确认）丢失，AI 误判编辑失败。
      // 现在由目标实例通过 ACK 认领请求；无人认领时后端 ACK 超时快速失败。
      if (request.noteId !== noteIdRef.current) {
        console.log('[useCanvasAIEditHandler] Ignoring request for other note:', request.noteId, 'current:', noteIdRef.current);
        return;
      }
      if (request.targetWindowId && request.targetWindowId !== windowIdRef.current) {
        return;
      }

      // 先同步占位再等待 ACK，防止两条事件在同一事件循环内越过异步间隙，
      // 后到的建议必须保留当前 diff，而不是静默覆盖它。
      const pendingRequest = pendingRequestRef.current;
      if (pendingRequest) {
        request.onLocalDisposition?.({
          accepted: false,
          reason: i18n.t('vfs:canvas_edit.suggestion_pending', { defaultValue: '已有一条笔记编辑建议等待确认' }),
        });
        try {
          await invoke('chat_v2_canvas_edit_ack', { requestId: request.requestId });
        } catch (err) {
          console.error('[useCanvasAIEditHandler] Failed to ack duplicate edit request:', err);
        }
        if (pendingRequest.requestId !== request.requestId) {
          await sendResult({
            requestId: request.requestId,
            success: false,
            error: i18n.t('vfs:canvas_edit.suggestion_pending_detail', {
              defaultValue: '已有一条笔记编辑建议等待确认，请先接受或拒绝当前建议',
            }),
          });
        }
        return;
      }
      pendingRequestRef.current = request;

      const editor = editorApiRef.current;
      if (!editor) {
        settlePendingRequest();
        const editorNotReady = i18n.t('vfs:canvas_edit.editor_not_ready', { defaultValue: '编辑器未就绪' });
        request.onLocalDisposition?.({ accepted: false, reason: editorNotReady });
        const result: CanvasAIEditResult = {
          requestId: request.requestId,
          success: false,
          error: editorNotReady,
        };
        await sendResult(result);
        return;
      }

      const originalContent = editor.getFullMarkdown?.() ?? editor.getMarkdown();
      const {
        onLocalDisposition: _onLocalDisposition,
        onSettled: _onSettled,
        ...stateRequest
      } = request;
      const immediateFailure = startEdit(stateRequest, originalContent);
      if (immediateFailure) {
        settlePendingRequest();
        request.onLocalDisposition?.({
          accepted: false,
          reason: immediateFailure.error
            ?? i18n.t('vfs:canvas_edit.invalid_suggestion', { defaultValue: '建议内容无效' }),
        });
        await sendResult(immediateFailure);
        return;
      }
      request.onLocalDisposition?.({ accepted: true });
      // P2：新建议不再清空 checkpoint 栈——历史条目仍是有效回滚目标（stale 惰性检测）

      // 认领请求：告知后端目标编辑器存在（失败不阻断后续流程，
      // 后端会在 ACK 超时后以"笔记未打开"失败，结果回调仍可兜底）
      try {
        await invoke('chat_v2_canvas_edit_ack', { requestId: request.requestId });
      } catch (err) {
        console.error('[useCanvasAIEditHandler] Failed to ack edit request:', err);
      }

    },
    [startEdit, sendResult, settlePendingRequest]
  );

  useEffect(() => {
    if (!enabled) return;

    let unlisten: UnlistenFn | null = null;
    let active = true;

    // ACR R1-13：noteDriver 建议模式派发 window CustomEvent（同名）；
    // Rust execute_write_frontend 仍走 Tauri emit。双通道共用 handleEditRequest。
    const handleDomCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<LocalCanvasAIEditRequest>).detail;
      if (!detail || typeof detail !== 'object') return;
      void handleEditRequest(detail);
    };
    window.addEventListener('canvas:ai-edit-request', handleDomCustomEvent);

    const setup = async () => {
      try {
        const fn = await listen<CanvasAIEditRequest>(
          'canvas:ai-edit-request',
          (event) => {
            handleEditRequest(event.payload);
          }
        );
        if (!active) {
          fn();
          return;
        }
        unlisten = fn;
        console.log('[useCanvasAIEditHandler] Listening for AI edit requests');
      } catch (err) {
        console.error('[useCanvasAIEditHandler] Failed to setup listener:', err);
      }
    };

    setup();

    return () => {
      active = false;
      window.removeEventListener('canvas:ai-edit-request', handleDomCustomEvent);
      if (unlisten) {
        unlisten();
        console.log('[useCanvasAIEditHandler] Stopped listening');
      }
    };
  }, [enabled, handleEditRequest]);

  useEffect(() => {
    if (aiEditState.isActive && aiEditState.request?.noteId !== noteIdRef.current) {
      const result = reject();
      if (result) {
        settlePendingRequest();
        sendResult(result);
      }
    }
  }, [noteId, aiEditState.isActive, aiEditState.request?.noteId, reject, sendResult, settlePendingRequest]);

  // ★ F3 修复：编辑器卸载（关闭 tab/切换笔记）时若仍有待确认的 AI 编辑，
  // 立即向后端发送拒绝结果，避免 AI 干等 30 秒超时。
  const aiEditStateRef = useRef(aiEditState);
  aiEditStateRef.current = aiEditState;

  useEffect(() => {
    return () => {
      const pending = aiEditStateRef.current;
      if (pending.isActive && pending.request) {
        invoke('chat_v2_canvas_edit_result', {
          result: {
            requestId: pending.request.requestId,
            success: false,
            error: i18n.t('vfs:canvas_edit.editor_closed', { defaultValue: '编辑器已关闭，修改未应用' }),
          },
        }).catch((err) => {
          console.warn('[useCanvasAIEditHandler] Failed to send unmount rejection:', err);
        });
      }
      clear();
      settlePendingRequest();
    };
  }, [clear, settlePendingRequest]);

  return {
    aiEditState,
    handleAccept,
    handleReject,
    isLocked: aiEditState.isActive,
    isApplying,
    checkpoints,
    checkpoint: checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null,
    rollbackCheckpoint,
    dismissCheckpoint,
  };
}

export default useCanvasAIEditHandler;
