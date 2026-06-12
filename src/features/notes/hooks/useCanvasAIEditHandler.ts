import { useEffect, useRef, useCallback } from 'react';
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

interface UseCanvasAIEditHandlerReturn {
  aiEditState: AIEditState;
  handleAccept: () => Promise<void>;
  handleReject: () => Promise<void>;
  isLocked: boolean;
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
    try {
      await invoke('chat_v2_canvas_edit_result', { result });
      console.log('[useCanvasAIEditHandler] Sent result:', result.requestId, result.success);
    } catch (err) {
      console.error('[useCanvasAIEditHandler] Failed to send result:', err);
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

    await sendResult(result);
  }, [accept, sendResult]);

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

  useEffect(() => {
    return () => {
      clear();
    };
  }, [clear]);

  return {
    aiEditState,
    handleAccept,
    handleReject,
    isLocked: aiEditState.isActive,
  };
}

export default useCanvasAIEditHandler;
