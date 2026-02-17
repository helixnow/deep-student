/**
 * 题目集识别进度监听 Hook
 * 统一移动端和桌面端的进度处理逻辑
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  stage: 'idle' | 'uploading' | 'ocr' | 'parsing' | 'completed';
  progress: { current: number; total: number };
  ocrProgress: { current: number; total: number };
  parseProgress: { current: number; total: number };
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
    ocrProgress: { current: 0, total: 0 },
    parseProgress: { current: 0, total: 0 },
    error: null
  });

  // ★ 使用 ref 持有回调，避免 handleProgress 因回调引用变化而重建
  // 这防止了 useEffect 重挂载事件监听器时 Completed 事件被丢失的竞态
  const onSessionUpdateRef = useRef(options.onSessionUpdate);
  const onProgressRef = useRef(options.onProgress);
  useEffect(() => { onSessionUpdateRef.current = options.onSessionUpdate; }, [options.onSessionUpdate]);
  useEffect(() => { onProgressRef.current = options.onProgress; }, [options.onProgress]);

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
      case 'SessionCreated': {
        const totalPages = (payload as any).total_pages ?? (payload as any).total_chunks ?? 0;
        setState(prev => ({
          ...prev,
          isProcessing: true,
          stage: 'ocr',
          progress: { current: 0, total: totalPages * 2 },
          ocrProgress: { current: 0, total: totalPages },
          parseProgress: { current: 0, total: totalPages },
          error: null
        }));
        console.log('[ExamSheet] Session created, starting two-phase processing, pages:', totalPages);
        onProgressRef.current?.('ocr', 0, totalPages);
        break;
      }

      // ★ 阶段一：单页 OCR 完成
      case 'OcrPageCompleted': {
        const pageIdx = (payload as any).page_index ?? 0;
        const totalPages = (payload as any).total_pages ?? 0;
        setState(prev => {
          const ocrCurrent = pageIdx + 1;
          console.log('[ExamSheet] OCR page completed:', ocrCurrent, '/', totalPages);
          onProgressRef.current?.('ocr', ocrCurrent, totalPages);
          return {
            ...prev,
            stage: 'ocr',
            ocrProgress: { current: ocrCurrent, total: totalPages },
            progress: { current: ocrCurrent, total: totalPages * 2 }
          };
        });
        break;
      }

      // ★ 阶段一全部完成 → 切换到阶段二
      case 'OcrPhaseCompleted': {
        const totalPages = (payload as any).total_pages ?? 0;
        setState(prev => ({
          ...prev,
          stage: 'parsing',
          ocrProgress: { current: totalPages, total: totalPages },
          parseProgress: { current: 0, total: totalPages },
          progress: { current: totalPages, total: totalPages * 2 }
        }));
        console.log('[ExamSheet] OCR phase completed, starting parse phase');
        break;
      }

      // ★ 阶段二：单页解析完成
      case 'ParsePageCompleted': {
        const pageIdx = (payload as any).page_index ?? 0;
        const totalPages = (payload as any).total_pages ?? 0;
        setState(prev => {
          const parseCurrent = pageIdx + 1;
          console.log('[ExamSheet] Parse page completed:', parseCurrent, '/', totalPages);
          onProgressRef.current?.('parsing', parseCurrent, totalPages);
          return {
            ...prev,
            stage: 'parsing',
            parseProgress: { current: parseCurrent, total: totalPages },
            progress: { current: totalPages + parseCurrent, total: totalPages * 2 }
          };
        });
        break;
      }

      // ★ 兼容旧后端：ChunkCompleted 仍可正常工作
      case 'ChunkCompleted':
        setState(prev => {
          const newCurrent = prev.ocrProgress.current + 1;
          const newTotal = prev.ocrProgress.total;
          console.log('[ExamSheet] Chunk completed:', newCurrent, '/', newTotal);
          onProgressRef.current?.('ocr', newCurrent, newTotal);
          return {
            ...prev,
            stage: 'ocr',
            ocrProgress: { current: newCurrent, total: newTotal },
            progress: { current: newCurrent, total: newTotal * 2 }
          };
        });
        break;

      case 'Completed':
        console.log('[ExamSheet] ★ Processing complete');
        setState(prev => {
          const total = prev.progress.total;
          onProgressRef.current?.('completed', total, total);
          return {
            ...prev,
            isProcessing: false,
            stage: 'completed',
            progress: { current: total, total }
          };
        });

        // 更新会话数据
        if (onSessionUpdateRef.current) {
          onSessionUpdateRef.current(detail);
          showGlobalNotification('success', i18n.t('exam_sheet:recognition_complete_notification', { defaultValue: 'Question set recognition completed!' }));
        }

        // 🆕 自动触发多模态索引（异步，不阻塞主流程）
        if (detail?.summary?.id) {
          triggerMultimodalIndex(detail.summary.id);
        }
        break;
    }
  }, []); // ★ 无依赖 — 回调通过 ref 访问，永不重建

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
      ocrProgress: { current: 0, total: 0 },
      parseProgress: { current: 0, total: 0 },
      error: null
    });
  }, []);

  // ★ 立即标记为处理中（消除按钮点击→SessionCreated 之间的竞态窗口）
  const startProcessing = useCallback(() => {
    setState({
      isProcessing: true,
      stage: 'ocr',
      progress: { current: 0, total: 0 },
      ocrProgress: { current: 0, total: 0 },
      parseProgress: { current: 0, total: 0 },
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
    startProcessing,
    setError
  };
}
