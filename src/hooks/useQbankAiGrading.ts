/**
 * 题目集 AI 评判 Hook
 *
 * 复用 useEssayGradingStream 的 Promise 包装 + Tauri 事件监听模式：
 * - Promise 包装 + settle 幂等
 * - Ref 防竞态（currentStreamSessionIdRef）
 * - 120s 超时 + 事件重置
 * - 组件卸载清理
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ============================================================================
// 类型定义
// ============================================================================

export type QbankGradingMode = 'grade' | 'analyze';
export type QbankVerdict = 'correct' | 'partial' | 'incorrect';

export interface QbankGradingState {
  /** 是否正在评判 */
  isGrading: boolean;
  /** 流式累积的 AI 反馈文本 */
  feedback: string;
  /** 判定结论（仅 grade 模式） */
  verdict?: QbankVerdict;
  /** AI 评分 0-100（仅 grade 模式） */
  score?: number;
  /** 错误信息 */
  error?: string;
  /** 当前流 session ID */
  streamSessionId?: string;
}

interface QbankGradingStreamEvent {
  type: 'data' | 'complete' | 'error' | 'cancelled';
  // data
  chunk?: string;
  accumulated?: string;
  // complete
  submission_id?: string;
  verdict?: string;
  score?: number;
  feedback?: string;
  // error
  message?: string;
}

const INITIAL_STATE: QbankGradingState = {
  isGrading: false,
  feedback: '',
};

const TIMEOUT_MS = 120_000; // 120 秒超时

// ============================================================================
// Hook
// ============================================================================

export function useQbankAiGrading() {
  const [state, setState] = useState<QbankGradingState>(INITIAL_STATE);

  // Refs 防竞态
  const currentStreamSessionIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(false);
  const isStartingRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestRef = useRef<{
    questionId: string;
    submissionId: string;
    mode: QbankGradingMode;
    modelConfigId?: string;
    onComplete?: (verdict?: QbankVerdict, score?: number, feedback?: string) => void;
  } | null>(null);

  // 清理函数
  const cleanup = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // 超时重置
  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      debugLog.warn('[useQbankAiGrading] 超时：120 秒无数据');
      cleanup();
      setState((prev) => ({
        ...prev,
        isGrading: false,
        error: 'AI 评判超时，请重试',
      }));
      // 通知后端取消
      const sid = currentStreamSessionIdRef.current;
      if (sid) {
        currentStreamSessionIdRef.current = null;
        void invoke('qbank_cancel_grading', {
          streamEventName: `qbank_grading_stream_${sid}`,
        });
      }
      isActiveRef.current = false;
    }, TIMEOUT_MS);
  }, [cleanup]);

  /**
   * 启动 AI 评判
   *
   * @param onComplete 评判完成时的回调（在事件 handler 中直接调用，避免闭包过时值问题）
   * @returns Promise<'completed' | 'cancelled'>
   */
  const startGrading = useCallback(
    (
      questionId: string,
      submissionId: string,
      mode: QbankGradingMode,
      modelConfigId?: string,
      onComplete?: (verdict?: QbankVerdict, score?: number, feedback?: string) => void,
    ): Promise<'completed' | 'cancelled'> => {
      return new Promise(async (resolve, reject) => {
        // 防重入
        if (isStartingRef.current || isActiveRef.current) {
          reject(new Error('评判正在进行中'));
          return;
        }

        isStartingRef.current = true;
        isActiveRef.current = true;

        // 保存请求信息（包含 onComplete，以便 retryGrading 能正确回调）
        lastRequestRef.current = { questionId, submissionId, mode, modelConfigId, onComplete };

        // 生成新的 stream session ID
        const streamSessionId = nanoid(12);
        currentStreamSessionIdRef.current = streamSessionId;

        // 清理旧状态
        cleanup();
        setState({
          isGrading: true,
          feedback: '',
          streamSessionId,
        });

        let settled = false;
        const settledRef = { current: false };

        const settle = (result: 'completed' | 'cancelled') => {
          if (settledRef.current) return;
          settledRef.current = true;
          settled = true;
          resolve(result);
        };

        const fail = (error: Error) => {
          if (settledRef.current) return;
          settledRef.current = true;
          settled = true;
          reject(error);
        };

        try {
          // 注册事件监听
          const eventName = `qbank_grading_stream_${streamSessionId}`;
          const unlisten = await listen<QbankGradingStreamEvent>(eventName, (event) => {
            // 竞态守卫：如果 session 已被 resetState/cancelGrading 清除，忽略迟到的事件
            if (currentStreamSessionIdRef.current !== streamSessionId) return;

            const payload = event.payload;
            resetTimeout();

            if (payload.type === 'data') {
              setState((prev) => ({
                ...prev,
                feedback: payload.accumulated || prev.feedback,
              }));
            }

            if (payload.type === 'complete') {
              cleanup();
              const finalVerdict = payload.verdict as QbankVerdict | undefined;
              const finalScore = payload.score;
              setState((prev) => ({
                ...prev,
                isGrading: false,
                feedback: payload.feedback || prev.feedback,
                verdict: finalVerdict,
                score: finalScore,
              }));
              isActiveRef.current = false;
              currentStreamSessionIdRef.current = null;
              // 直接回调，避免闭包过时值问题
              onComplete?.(finalVerdict, finalScore, payload.feedback || '');
              settle('completed');
            }

            if (payload.type === 'error') {
              cleanup();
              setState((prev) => ({
                ...prev,
                isGrading: false,
                error: payload.message || '评判失败',
              }));
              isActiveRef.current = false;
              currentStreamSessionIdRef.current = null;
              fail(new Error(payload.message || '评判失败'));
            }

            if (payload.type === 'cancelled') {
              cleanup();
              setState((prev) => ({
                ...prev,
                isGrading: false,
              }));
              isActiveRef.current = false;
              currentStreamSessionIdRef.current = null;
              settle('cancelled');
            }
          });

          unlistenRef.current = unlisten;
          isStartingRef.current = false;

          // 启动超时计时器
          resetTimeout();

          // 调用后端
          await invoke('qbank_ai_grade', {
            request: {
              question_id: questionId,
              submission_id: submissionId,
              stream_session_id: streamSessionId,
              mode,
              model_config_id: modelConfigId || null,
            },
          });
        } catch (error: unknown) {
          cleanup();
          isStartingRef.current = false;
          isActiveRef.current = false;
          currentStreamSessionIdRef.current = null;

          const errMsg = error instanceof Error ? error.message : String(error);
          setState((prev) => ({
            ...prev,
            isGrading: false,
            error: errMsg,
          }));

          if (!settled) {
            fail(error instanceof Error ? error : new Error(errMsg));
          }
        }
      });
    },
    [cleanup, resetTimeout],
  );

  /**
   * 取消评判
   */
  const cancelGrading = useCallback(async () => {
    const currentStreamSessionId = currentStreamSessionIdRef.current;
    if (!currentStreamSessionId) return;

    currentStreamSessionIdRef.current = null;
    cleanup();

    setState((prev) => ({
      ...prev,
      isGrading: false,
    }));

    isActiveRef.current = false;

    await invoke('qbank_cancel_grading', {
      streamEventName: `qbank_grading_stream_${currentStreamSessionId}`,
    });
  }, [cleanup]);

  /**
   * 重试评判（使用新的 stream session ID）
   */
  const retryGrading = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last) return;

    return startGrading(last.questionId, last.submissionId, last.mode, last.modelConfigId, last.onComplete);
  }, [startGrading]);

  /**
   * 重置状态（同时取消正在进行的后端流）
   */
  const resetState = useCallback(() => {
    const sid = currentStreamSessionIdRef.current;
    if (sid && isActiveRef.current) {
      void invoke('qbank_cancel_grading', {
        streamEventName: `qbank_grading_stream_${sid}`,
      });
    }
    cleanup();
    setState(INITIAL_STATE);
    currentStreamSessionIdRef.current = null;
    isActiveRef.current = false;
    isStartingRef.current = false;
    lastRequestRef.current = null;
  }, [cleanup]);

  // 组件卸载清理（E-3）
  useEffect(() => {
    return () => {
      if (isActiveRef.current) {
        const sid = currentStreamSessionIdRef.current;
        if (sid) {
          void invoke('qbank_cancel_grading', {
            streamEventName: `qbank_grading_stream_${sid}`,
          });
        }
      }
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    startGrading,
    cancelGrading,
    retryGrading,
    resetState,
  };
}
