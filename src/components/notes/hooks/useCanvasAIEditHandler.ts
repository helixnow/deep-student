import { useEffect, useRef, useCallback } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { CrepeEditorApi } from '../../crepe';
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

    if (editor) {
      editor.setMarkdown(proposedContent);
      
      if (onSaveRef.current) {
        try {
          await onSaveRef.current(proposedContent);
        } catch (err) {
          console.warn('[useCanvasAIEditHandler] Auto-save failed:', err);
        }
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

      if (request.noteId !== noteIdRef.current) {
        console.log('[useCanvasAIEditHandler] Note ID mismatch:', request.noteId, 'vs', noteIdRef.current);
        const result: CanvasAIEditResult = {
          requestId: request.requestId,
          success: false,
          error: `笔记 ${request.noteId} 未在编辑器中打开`,
        };
        await sendResult(result);
        return;
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
      startEdit(request, originalContent);
    },
    [startEdit, sendResult]
  );

  useEffect(() => {
    if (!enabled) return;

    let unlisten: UnlistenFn | null = null;

    const setup = async () => {
      try {
        unlisten = await listen<CanvasAIEditRequest>(
          'canvas:ai-edit-request',
          (event) => {
            handleEditRequest(event.payload);
          }
        );
        console.log('[useCanvasAIEditHandler] Listening for AI edit requests');
      } catch (err) {
        console.error('[useCanvasAIEditHandler] Failed to setup listener:', err);
      }
    };

    setup();

    return () => {
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
