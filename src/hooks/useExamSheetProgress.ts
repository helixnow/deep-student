/**
 * 题目集识别进度监听 Hook
 * 统一移动端和桌面端的进度处理逻辑
 */

import { useCallback, useEffect, useState } from 'react';
import { useTauriEventListener } from './useTauriEventListener';
import type { ExamSheetProgressEvent } from '../utils/tauriApi';
import { showGlobalNotification } from '../components/UnifiedNotification';
import { multimodalRagService, MULTIMODAL_INDEX_ENABLED } from '../services/multimodalRagService';
import i18n from '@/i18n';

/**
 * 🆕 异步触发多模态索引（不阻塞主流程）
 * ★ 多模态索引已禁用时静默跳过，恢复 MULTIMODAL_INDEX_ENABLED = true 即可重新启用
 */
async function triggerMultimodalIndex(resourceId: string) {
  if (!MULTIMODAL_INDEX_ENABLED) {
    return;
  }
  try {
    // 先检查是否配置了多模态 RAG
    const configured = await multimodalRagService.isConfigured();
    if (!configured) {
      console.log('[MultimodalIndex] Multimodal RAG not configured, skipping auto-index');
      return;
    }

    console.log(`[MultimodalIndex] Starting index for exam: ${resourceId}`);
    const result = await multimodalRagService.vfsIndexResourceBySource('exam', resourceId);

    console.log(`[MultimodalIndex] Indexing complete: ${result.indexedPages} pages indexed`);
  } catch (error: unknown) {
    // 静默失败，不影响主流程
    console.warn('[MultimodalIndex] Auto-index error:', error);
  }
}

export interface ExamSheetProgressState {
  isProcessing: boolean;
  stage: 'idle' | 'uploading' | 'encoding' | 'recognizing' | 'completed';
  progress: { current: number; total: number };
  error: string | null;
}

export interface UseExamSheetProgressOptions {
  onSessionUpdate?: (detail: any) => Promise<void>;
  onProgress?: (stage: string, current: number, total: number) => void;
}

/**
 * 统一的题目集识别进度监听 Hook
 */
export function useExamSheetProgress(options: UseExamSheetProgressOptions = {}) {
  const tauriEvents = useTauriEventListener();
  const [state, setState] = useState<ExamSheetProgressState>({
    isProcessing: false,
    stage: 'idle',
    progress: { current: 0, total: 0 },
    error: null
  });

  const { onSessionUpdate, onProgress } = options;

  const handleProgress = useCallback((payload: ExamSheetProgressEvent) => {
    if (!payload) return;

    // 处理失败事件
    if (payload.type === 'Failed') {
      setState(prev => ({
        ...prev,
        isProcessing: false,
        stage: 'idle',
        error: payload.error
      }));
      showGlobalNotification('error', i18n.t('exam_sheet:error_processing', { error: payload.error, defaultValue: 'Processing failed: {{error}}' }));
      return;
    }

    const detail = payload.detail;
    if (!detail) return;

    // 根据事件类型更新状态
    switch (payload.type) {
      case 'SessionCreated':
        setState(prev => ({
          ...prev,
          isProcessing: true,
          stage: 'encoding',
          progress: { current: 0, total: (payload as any).total_chunks ?? 0 },
          error: null
        }));
        console.log('[ExamSheet] Session created, starting processing');
        onProgress?.('encoding', 0, (payload as any).total_chunks ?? 0);
        break;

      case 'ChunkCompleted':
        setState(prev => {
          const newCurrent = prev.progress.current + 1;
          const newTotal = prev.progress.total;
          console.log('[ExamSheet] Chunk completed:', newCurrent, '/', newTotal);
          onProgress?.('recognizing', newCurrent, newTotal);
          return {
            ...prev,
            stage: 'recognizing',
            progress: { current: newCurrent, total: newTotal }
          };
        });
        break;

      case 'Completed':
        setState(prev => {
          const newTotal = prev.progress.total;
          console.log('[ExamSheet] Processing complete');
          onProgress?.('completed', newTotal, newTotal);
          return {
            ...prev,
            isProcessing: false,
            stage: 'completed',
            progress: { current: newTotal, total: newTotal }
          };
        });

        // 更新会话数据
        if (onSessionUpdate) {
          onSessionUpdate(detail);
          showGlobalNotification('success', i18n.t('exam_sheet:recognition_complete_notification', { defaultValue: 'Question set recognition completed!' }));
        }

        // 🆕 自动触发多模态索引（异步，不阻塞主流程）
        if (detail?.summary?.id) {
          triggerMultimodalIndex(detail.summary.id);
        }
        break;
    }
  }, [onSessionUpdate, onProgress]);

  // 监听进度事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const attach = async () => {
      unlisten = await tauriEvents.attach<ExamSheetProgressEvent>('exam_sheet_progress', ({ payload }) => handleProgress(payload));
    };

    attach();

    return () => {
      if (unlisten) {
        tauriEvents.cleanup(unlisten);
      }
    };
  }, [tauriEvents, handleProgress]);

  // 重置状态
  const reset = useCallback(() => {
    setState({
      isProcessing: false,
      stage: 'idle',
      progress: { current: 0, total: 0 },
      error: null
    });
  }, []);

  // 设置错误
  const setError = useCallback((error: string) => {
    setState(prev => ({
      ...prev,
      isProcessing: false,
      stage: 'idle',
      error
    }));
  }, []);

  return {
    ...state,
    reset,
    setError
  };
}
