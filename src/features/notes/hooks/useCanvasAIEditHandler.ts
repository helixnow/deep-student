import { useEffect, useRef, useCallback, useState } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { CrepeEditorApi } from '@/components/crepe';
import { useAIEditState, type CanvasAIEditRequest, type CanvasAIEditResult, type AIEditState } from './useAIEditState';

interface UseCanvasAIEditHandlerOptions {
  noteId: string | null | undefined;
  editorApi: CrepeEditorApi | null;
  onSave?: (content: string) => Promise<void>;
  enabled?: boolean;
}

/** ★ 2.1 AI 编辑检查点：接受后仍可回滚整轮 */
export interface AIEditCheckpoint {
  /** 编辑前的完整内容 */
  originalContent: string;
  /** 应用时间戳 */
  appliedAt: number;
  /** 所属笔记（切换笔记后检查点失效） */
  noteId: string;
}

interface UseCanvasAIEditHandlerReturn {
  aiEditState: AIEditState;
  handleAccept: () => Promise<void>;
  handleReject: () => Promise<void>;
  isLocked: boolean;
  /** ★ 2.1 最近一次已接受 AI 编辑的检查点（可回滚） */
  checkpoint: AIEditCheckpoint | null;
  /** ★ 2.1 回滚到检查点（恢复 AI 编辑前内容并落盘） */
  rollbackCheckpoint: () => Promise<void>;
  /** ★ 2.1 放弃检查点（保留 AI 编辑结果） */
  dismissCheckpoint: () => void;
}

export function useCanvasAIEditHandler({
  noteId,
  editorApi,
  onSave,
  enabled = true,
}: UseCanvasAIEditHandlerOptions): UseCanvasAIEditHandlerReturn {
  const noteIdRef = useRef(noteId);
  const editorApiRef = useRef(editorApi);
  const onSaveRef = useRef(onSave);

  const { state: aiEditState, startEdit, accept, reject, clear } = useAIEditState();

  // ★ 2.1 AI 编辑检查点
  const [checkpoint, setCheckpoint] = useState<AIEditCheckpoint | null>(null);

  // 切换笔记后检查点失效（回滚目标已不在编辑器中）
  useEffect(() => {
    setCheckpoint((prev) => (prev && prev.noteId !== noteId ? null : prev));
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
    const acceptResult = accept();
    if (!acceptResult) return;

    const { proposedContent, result } = acceptResult;
    const editor = editorApiRef.current;

    if (!editor || editor.isReadonly()) {
      await sendResult({
        requestId: result.requestId,
        success: false,
        error: '编辑器不可写，修改未应用',
      });
      return;
    }

    // ★ 2.1 接受前记录检查点（编辑前全文），接受后仍可整轮回滚
    const contentBeforeApply = editor.getMarkdown();

    editor.setMarkdown(proposedContent);

    if (onSaveRef.current) {
      try {
        await onSaveRef.current(proposedContent);
      } catch (err) {
        console.warn('[useCanvasAIEditHandler] Auto-save failed:', err);
        await sendResult({
          requestId: result.requestId,
          success: false,
          error: err instanceof Error ? err.message : '保存失败，修改未落盘',
          beforePreview: result.beforePreview,
          afterPreview: result.afterPreview,
          addedContent: result.addedContent,
        });
        return;
      }
    }

    if (noteIdRef.current) {
      setCheckpoint({
        originalContent: contentBeforeApply,
        appliedAt: Date.now(),
        noteId: noteIdRef.current,
      });
    }

    await sendResult(result);
  }, [accept, sendResult]);

  // ★ 2.1 回滚到检查点
  const rollbackCheckpoint = useCallback(async () => {
    if (!checkpoint) return;
    const editor = editorApiRef.current;
    if (!editor || editor.isReadonly()) {
      console.warn('[useCanvasAIEditHandler] Rollback skipped: editor not writable');
      return;
    }

    editor.setMarkdown(checkpoint.originalContent);
    if (onSaveRef.current) {
      try {
        await onSaveRef.current(checkpoint.originalContent);
      } catch (err) {
        console.warn('[useCanvasAIEditHandler] Rollback save failed:', err);
      }
    }
    setCheckpoint(null);
  }, [checkpoint]);

  const dismissCheckpoint = useCallback(() => setCheckpoint(null), []);

  const handleReject = useCallback(async () => {
    const result = reject();
    if (!result) return;

    await sendResult(result);
  }, [reject, sendResult]);

  const handleEditRequest = useCallback(
    async (request: CanvasAIEditRequest) => {
      console.log('[useCanvasAIEditHandler] Received edit request:', request.requestId, request.operation);

      // ★ R2 修复：非目标实例静默忽略。
      // 之前这里会立即回复"笔记未打开"失败，抢先消费后端的 oneshot 回调，
      // 导致目标实例随后的真实结果（diff 确认）丢失，AI 误判编辑失败。
      // 现在由目标实例通过 ACK 认领请求；无人认领时后端 ACK 超时快速失败。
      if (request.noteId !== noteIdRef.current) {
        console.log('[useCanvasAIEditHandler] Ignoring request for other note:', request.noteId, 'current:', noteIdRef.current);
        return;
      }

      // 认领请求：告知后端目标编辑器存在（失败不阻断后续流程，
      // 后端会在 ACK 超时后以"笔记未打开"失败，结果回调仍可兜底）
      try {
        await invoke('chat_v2_canvas_edit_ack', { requestId: request.requestId });
      } catch (err) {
        console.error('[useCanvasAIEditHandler] Failed to ack edit request:', err);
      }

      const editor = editorApiRef.current;
      if (!editor) {
        const result: CanvasAIEditResult = {
          requestId: request.requestId,
          success: false,
          error: '编辑器未就绪',
        };
        await sendResult(result);
        return;
      }

      // ★ 2.1 新一轮编辑开始 → 旧检查点失效（只支持回滚最近一轮）
      setCheckpoint(null);

      const originalContent = editor.getMarkdown();
      const immediateFailure = startEdit(request, originalContent);
      if (immediateFailure) {
        await sendResult(immediateFailure);
      }
    },
    [startEdit, sendResult]
  );

  useEffect(() => {
    if (!enabled) return;

    let unlisten: UnlistenFn | null = null;
    let active = true;

    // ACR R1-13：noteDriver 建议模式派发 window CustomEvent（同名）；
    // Rust execute_write_frontend 仍走 Tauri emit。双通道共用 handleEditRequest。
    const handleDomCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<CanvasAIEditRequest>).detail;
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
        sendResult(result);
      }
    }
  }, [noteId, aiEditState.isActive, aiEditState.request?.noteId, reject, sendResult]);

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
            error: '编辑器已关闭，修改未应用',
          },
        }).catch((err) => {
          console.warn('[useCanvasAIEditHandler] Failed to send unmount rejection:', err);
        });
      }
      clear();
    };
  }, [clear]);

  return {
    aiEditState,
    handleAccept,
    handleReject,
    isLocked: aiEditState.isActive,
    checkpoint,
    rollbackCheckpoint,
    dismissCheckpoint,
  };
}

export default useCanvasAIEditHandler;
