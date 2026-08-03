/**
 * 题目集识别进度监听 Hook
 * 统一移动端和桌面端的进度处理逻辑
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTauriEventListener } from './useTauriEventListener';
import type { ExamSheetProgressEvent } from '../utils/tauriApi';
import { showGlobalNotification } from '../components/UnifiedNotification';
import { multimodalRagService } from '../services/multimodalRagService';
import i18n from '@/i18n';
import { emitExamSheetDebug } from '../debug-panel/plugins/ExamSheetProcessingDebugPlugin';

/**
 * 异步触发多模态索引（不阻塞题目识别主流程）。
 */
async function triggerMultimodalIndex(resourceId: string) {
  try {
    const capability = await multimodalRagService.getCapabilityStatus();
    if (!capability.available) {
      const message = capability.reason === 'not_configured'
        ? 'Multimodal embedding is not configured'
        : capability.reason === 'probe_failed'
          ? `Multimodal capability probe failed (state unknown): ${capability.error ?? 'unknown error'}`
          : `Multimodal embedding is temporarily unavailable: ${capability.error ?? 'unknown error'}`;
      console.warn(`[MultimodalIndex] ${message}; skipping auto-index`);
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

/** 单页处理状态（阶段一 OCR / 阶段二解析） */
export type ExamSheetPageStatus = 'pending' | 'ocr_done' | 'parsed';

export interface ExamSheetProgressState {
  isProcessing: boolean;
  stage: 'idle' | 'uploading' | 'ocr' | 'parsing' | 'completed';
  progress: { current: number; total: number };
  ocrProgress: { current: number; total: number };
  parseProgress: { current: number; total: number };
  /** 每页处理状态（索引 = 页序号），供 UI 展示逐页进度 */
  pageStatuses: ExamSheetPageStatus[];
  error: string | null;
}

export interface UseExamSheetProgressOptions {
  /** ★ 标签页：当前 session ID，用于过滤非当前 session 的进度事件 */
  sessionId?: string | null;
  onSessionUpdate?: (detail: any) => Promise<void>;
  onProgress?: (stage: string, current: number, total: number) => void;
}

const createInitialState = (): ExamSheetProgressState => ({
  isProcessing: false,
  stage: 'idle',
  progress: { current: 0, total: 0 },
  ocrProgress: { current: 0, total: 0 },
  parseProgress: { current: 0, total: 0 },
  pageStatuses: [],
  error: null,
});

const buildPageStatuses = (total: number, ocrDone: number, parsedDone: number): ExamSheetPageStatus[] =>
  Array.from({ length: Math.max(0, total) }, (_, idx) =>
    idx < parsedDone ? 'parsed' : idx < ocrDone ? 'ocr_done' : 'pending');

/**
 * 统一的题目集识别进度监听 Hook
 */
export function useExamSheetProgress(options: UseExamSheetProgressOptions = {}) {
  const tauriEvents = useTauriEventListener();
  const [state, setState] = useState<ExamSheetProgressState>(createInitialState);

  // ★ 使用 ref 持有回调，避免 handleProgress 因回调引用变化而重建
  // 这防止了 useEffect 重挂载事件监听器时 Completed 事件被丢失的竞态
  const onSessionUpdateRef = useRef(options.onSessionUpdate);
  const onProgressRef = useRef(options.onProgress);
  useEffect(() => { onSessionUpdateRef.current = options.onSessionUpdate; }, [options.onSessionUpdate]);
  useEffect(() => { onProgressRef.current = options.onProgress; }, [options.onProgress]);

  // ★ 标签页：用 ref 持有 sessionId 以便在 handleProgress 中引用
  const sessionIdRef = useRef(options.sessionId);
  useEffect(() => { sessionIdRef.current = options.sessionId; }, [options.sessionId]);

  // ★ Bug 修复：进度计数持有在 ref 中，事件按单调合并（Math.max）处理，
  //   乱序/重复到达的页事件不会让进度回退；setState updater 中不再包含副作用
  //   （StrictMode 下 updater 会被调用两次，原实现的 console/onProgress 会重复触发）。
  const countersRef = useRef({ total: 0, ocrDone: 0, parseDone: 0 });

  const handleProgress = useCallback((payload: ExamSheetProgressEvent) => {
    if (!payload) return;

    // ★ 标签页：过滤非当前 session 的事件
    //   优先从 detail.summary.id 取 session ID；Failed 事件 detail 可能为 null，回退到顶层 session_id
    const targetSessionId = sessionIdRef.current;
    if (targetSessionId) {
      const eventSessionId = payload.detail?.summary?.id ?? (payload as any).session_id;
      if (eventSessionId && eventSessionId !== targetSessionId) {
        return; // 忽略其他 session 的事件
      }
    }

    // 处理失败事件
    if (payload.type === 'Failed') {
      emitExamSheetDebug('error', 'frontend:hook-state', `Hook 收到 Failed 事件: ${payload.error}`, { detail: { error: payload.error } });
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

    const counters = countersRef.current;

    // 根据事件类型更新状态
    switch (payload.type) {
      case 'SessionCreated': {
        const totalPages = (payload as any).total_pages ?? (payload as any).total_chunks ?? 0;
        counters.total = totalPages;
        counters.ocrDone = 0;
        counters.parseDone = 0;
        console.log('[ExamSheet] Session created, starting two-phase processing, pages:', totalPages);
        onProgressRef.current?.('ocr', 0, totalPages);
        setState(prev => ({
          ...prev,
          isProcessing: true,
          stage: 'ocr',
          progress: { current: 0, total: totalPages * 2 },
          ocrProgress: { current: 0, total: totalPages },
          parseProgress: { current: 0, total: totalPages },
          pageStatuses: buildPageStatuses(totalPages, 0, 0),
          error: null
        }));
        break;
      }

      // ★ 阶段一：单页 OCR 完成（单调合并，乱序事件不会让进度回退）
      case 'OcrPageCompleted': {
        const pageIdx = (payload as any).page_index ?? 0;
        const totalPages = Math.max((payload as any).total_pages ?? 0, counters.total);
        counters.total = totalPages;
        counters.ocrDone = Math.max(counters.ocrDone, pageIdx + 1);
        const ocrCurrent = counters.ocrDone;
        console.log('[ExamSheet] OCR page completed:', ocrCurrent, '/', totalPages);
        onProgressRef.current?.('ocr', ocrCurrent, totalPages);
        setState(prev => ({
          ...prev,
          isProcessing: true,
          // 已进入解析阶段后迟到的 OCR 事件不应把阶段拉回 ocr
          stage: prev.stage === 'parsing' ? 'parsing' : 'ocr',
          ocrProgress: { current: ocrCurrent, total: totalPages },
          progress: {
            current: Math.max(prev.progress.current, ocrCurrent),
            total: totalPages * 2
          },
          pageStatuses: buildPageStatuses(totalPages, counters.ocrDone, counters.parseDone),
        }));
        break;
      }

      // ★ 阶段一全部完成 → 切换到阶段二
      case 'OcrPhaseCompleted': {
        const totalPages = Math.max((payload as any).total_pages ?? 0, counters.total);
        counters.total = totalPages;
        counters.ocrDone = totalPages;
        console.log('[ExamSheet] OCR phase completed, starting parse phase');
        setState(prev => ({
          ...prev,
          isProcessing: true,
          stage: 'parsing',
          ocrProgress: { current: totalPages, total: totalPages },
          parseProgress: { current: counters.parseDone, total: totalPages },
          progress: { current: Math.max(prev.progress.current, totalPages), total: totalPages * 2 },
          pageStatuses: buildPageStatuses(totalPages, totalPages, counters.parseDone),
        }));
        break;
      }

      // ★ 阶段二：单页解析完成（单调合并）
      case 'ParsePageCompleted': {
        const pageIdx = (payload as any).page_index ?? 0;
        const totalPages = Math.max((payload as any).total_pages ?? 0, counters.total);
        counters.total = totalPages;
        counters.parseDone = Math.max(counters.parseDone, pageIdx + 1);
        counters.ocrDone = Math.max(counters.ocrDone, counters.parseDone);
        const parseCurrent = counters.parseDone;
        console.log('[ExamSheet] Parse page completed:', parseCurrent, '/', totalPages);
        onProgressRef.current?.('parsing', parseCurrent, totalPages);
        setState(prev => ({
          ...prev,
          isProcessing: true,
          stage: 'parsing',
          parseProgress: { current: parseCurrent, total: totalPages },
          progress: {
            current: Math.max(prev.progress.current, totalPages + parseCurrent),
            total: totalPages * 2
          },
          pageStatuses: buildPageStatuses(totalPages, counters.ocrDone, counters.parseDone),
        }));
        break;
      }

      // ★ 兼容旧后端：ChunkCompleted 仍可正常工作
      case 'ChunkCompleted': {
        counters.ocrDone += 1;
        const newCurrent = counters.ocrDone;
        const newTotal = counters.total;
        console.log('[ExamSheet] Chunk completed:', newCurrent, '/', newTotal);
        onProgressRef.current?.('ocr', newCurrent, newTotal);
        setState(prev => ({
          ...prev,
          stage: 'ocr',
          ocrProgress: { current: newCurrent, total: newTotal },
          progress: { current: Math.max(prev.progress.current, newCurrent), total: newTotal * 2 },
          pageStatuses: buildPageStatuses(newTotal, newCurrent, counters.parseDone),
        }));
        break;
      }

      case 'Completed': {
        console.log('[ExamSheet] ★ Processing complete');
        emitExamSheetDebug('success', 'frontend:hook-state', 'Hook 收到 Completed 事件 → isProcessing=false, stage=completed');
        counters.ocrDone = counters.total;
        counters.parseDone = counters.total;
        const total = counters.total * 2;
        onProgressRef.current?.('completed', total, total);
        setState(prev => {
          const finalTotal = prev.progress.total || total;
          return {
            ...prev,
            isProcessing: false,
            stage: 'completed',
            progress: { current: finalTotal, total: finalTotal },
            pageStatuses: buildPageStatuses(counters.total, counters.total, counters.total),
          };
        });

        // 更新会话数据
        if (onSessionUpdateRef.current) {
          emitExamSheetDebug('info', 'frontend:hook-state', 'Hook 调用 onSessionUpdate 回调');
          void onSessionUpdateRef.current(detail);
          showGlobalNotification('success', i18n.t('exam_sheet:recognition_complete_notification', { defaultValue: 'Question set recognition completed!' }));
        } else {
          emitExamSheetDebug('warn', 'frontend:hook-state', 'Hook onSessionUpdateRef.current 为空，无法触发导航');
        }

        // 🆕 自动触发多模态索引（异步，不阻塞主流程）
        if (detail?.summary?.id) {
          void triggerMultimodalIndex(detail.summary.id);
        }
        break;
      }
    }
  }, []); // ★ 无依赖 — 回调通过 ref 访问，永不重建

  // 监听进度事件
  // ★ Bug 修复：attach 是异步的。若 effect 在 attach resolve 前被清理
  //   （StrictMode 双挂载 / 快速卸载重挂载），旧监听器不会被释放并与新监听器
  //   重复消费事件。disposed 标记确保迟到 resolve 的 unlisten 被立即释放。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const attach = async () => {
      const next = await tauriEvents.attach<ExamSheetProgressEvent>('exam_sheet_progress', ({ payload }) => handleProgress(payload));
      if (disposed) {
        tauriEvents.cleanup(next);
        return;
      }
      unlisten = next;
    };

    void attach();

    return () => {
      disposed = true;
      if (unlisten) {
        tauriEvents.cleanup(unlisten);
        unlisten = undefined;
      }
    };
  }, [tauriEvents, handleProgress]);

  // 重置状态
  const reset = useCallback(() => {
    countersRef.current = { total: 0, ocrDone: 0, parseDone: 0 };
    setState(createInitialState());
  }, []);

  // ★ 立即标记为处理中（消除按钮点击→SessionCreated 之间的竞态窗口）
  const startProcessing = useCallback(() => {
    countersRef.current = { total: 0, ocrDone: 0, parseDone: 0 };
    setState({
      ...createInitialState(),
      isProcessing: true,
      stage: 'ocr',
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
