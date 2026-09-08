/**
 * 题目集 AI 出题 Hook（MVP）
 *
 * 复用 useQbankAiGrading 的 Promise 包装 + Tauri 事件监听模式：
 * - Promise 包装 + settle 幂等
 * - Ref 防竞态（currentStreamSessionIdRef）
 * - 120s 超时 + 事件重置
 * - 组件卸载清理
 *
 * 与批改 hook 的差异：complete 事件回传的是校验后的题目草稿列表
 * （GeneratedQuestionDraft[]），不落库；入库由调用方在用户确认后
 * 通过 qbank_batch_create_questions 完成（source_type=ai_generated）。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { QuestionType, Difficulty } from '@/api/questionBankApi';

// ============================================================================
// 类型定义（与 Rust qbank_generation::types 对齐）
// ============================================================================

export interface GeneratedQuestionOption {
  key: string;
  content: string;
}

export interface GeneratedQuestionDraft {
  question_type: QuestionType;
  content: string;
  options?: GeneratedQuestionOption[];
  answer?: string;
  explanation?: string;
  difficulty?: Difficulty;
  tags?: string[];
}

export interface QuestionGenerationSpec {
  question_type: QuestionType;
  count: number;
  difficulty?: Difficulty | null;
}

export interface QbankGenerationRequestPayload {
  exam_id: string;
  stream_session_id: string;
  model_config_id?: string | null;
  max_questions: number;
  specs: QuestionGenerationSpec[];
  difficulty?: Difficulty | null;
  topic_hint?: string | null;
  based_on_existing: boolean;
  language?: string | null;
}

export interface QbankGenerationState {
  /** 是否正在生成 */
  isGenerating: boolean;
  /** 流式累积的原始输出（JSON 数组文本，用于生成中展示） */
  rawOutput: string;
  /** 生成完成后的题目草稿（仅 complete 时填充） */
  drafts: GeneratedQuestionDraft[];
  /** 被剔除的题目数（校验失败） */
  rejectedCount: number;
  rejectionReasons: string[];
  /** 错误信息 */
  error?: string;
  /** 当前流 session ID */
  streamSessionId?: string;
}

interface QbankGenerationStreamEvent {
  type: 'data' | 'complete' | 'error' | 'cancelled';
  // data
  chunk?: string;
  accumulated?: string;
  // complete
  exam_id?: string;
  drafts?: GeneratedQuestionDraft[];
  rejected_count?: number;
  rejection_reasons?: string[];
  // error
  message?: string;
}

const INITIAL_STATE: QbankGenerationState = {
  isGenerating: false,
  rawOutput: '',
  drafts: [],
  rejectedCount: 0,
  rejectionReasons: [],
};

const TIMEOUT_MS = 180_000; // 180 秒超时（批量出题比单题批改长）

// ============================================================================
// Hook
// ============================================================================

export function useQbankAiGeneration() {
  const [state, setState] = useState<QbankGenerationState>(INITIAL_STATE);

  // Refs 防竞态
  const currentStreamSessionIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(false);
  const isStartingRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 结束进行中 Promise（超时/取消/重置路径），避免 startGeneration 永久挂起
  const settleRef = useRef<((result: 'completed' | 'cancelled') => void) | null>(null);
  const failRef = useRef<((error: Error) => void) | null>(null);

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
      debugLog.warn('[useQbankAiGeneration] 超时：180 秒无数据');
      cleanup();
      setState((prev) => ({
        ...prev,
        isGenerating: false,
        error: 'AI 出题超时，请重试',
      }));
      const sid = currentStreamSessionIdRef.current;
      if (sid) {
        currentStreamSessionIdRef.current = null;
        void invoke('qbank_cancel_generation', {
          streamEventName: `qbank_generation_stream_${sid}`,
        });
      }
      isActiveRef.current = false;
      isStartingRef.current = false;
      failRef.current?.(new Error('AI 出题超时，请重试'));
    }, TIMEOUT_MS);
  }, [cleanup]);

  /**
   * 启动 AI 出题
   *
   * @param request 出题参数（stream_session_id 由本 hook 生成）
   * @param onComplete 生成完成时的回调（草稿列表，未入库）
   * @returns Promise<'completed' | 'cancelled'>
   */
  const startGeneration = useCallback(
    (
      request: Omit<QbankGenerationRequestPayload, 'stream_session_id'>,
      onComplete?: (drafts: GeneratedQuestionDraft[]) => void,
    ): Promise<'completed' | 'cancelled'> => {
      return new Promise(async (resolve, reject) => {
        if (isStartingRef.current || isActiveRef.current) {
          reject(new Error('出题正在进行中'));
          return;
        }

        isStartingRef.current = true;
        isActiveRef.current = true;

        const streamSessionId = nanoid(12);
        currentStreamSessionIdRef.current = streamSessionId;

        cleanup();
        setState({
          isGenerating: true,
          rawOutput: '',
          drafts: [],
          rejectedCount: 0,
          rejectionReasons: [],
          streamSessionId,
        });

        let settled = false;
        const settledRef = { current: false };

        const settle = (result: 'completed' | 'cancelled') => {
          if (settledRef.current) return;
          settledRef.current = true;
          settled = true;
          settleRef.current = null;
          failRef.current = null;
          resolve(result);
        };

        const fail = (error: Error) => {
          if (settledRef.current) return;
          settledRef.current = true;
          settled = true;
          settleRef.current = null;
          failRef.current = null;
          reject(error);
        };

        settleRef.current = settle;
        failRef.current = fail;

        try {
          const eventName = `qbank_generation_stream_${streamSessionId}`;
          const unlisten = await listen<QbankGenerationStreamEvent>(eventName, (event) => {
            if (currentStreamSessionIdRef.current !== streamSessionId) return;

            const payload = event.payload;
            resetTimeout();

            if (payload.type === 'data') {
              setState((prev) => ({
                ...prev,
                rawOutput: payload.accumulated || prev.rawOutput,
              }));
            }

            if (payload.type === 'complete') {
              cleanup();
              const drafts = payload.drafts ?? [];
              setState((prev) => ({
                ...prev,
                isGenerating: false,
                drafts,
                rejectedCount: payload.rejected_count ?? 0,
                rejectionReasons: payload.rejection_reasons ?? [],
              }));
              isActiveRef.current = false;
              currentStreamSessionIdRef.current = null;
              onComplete?.(drafts);
              settle('completed');
            }

            if (payload.type === 'error') {
              cleanup();
              setState((prev) => ({
                ...prev,
                isGenerating: false,
                error: payload.message || '出题失败',
              }));
              isActiveRef.current = false;
              currentStreamSessionIdRef.current = null;
              fail(new Error(payload.message || '出题失败'));
            }

            if (payload.type === 'cancelled') {
              cleanup();
              setState((prev) => ({
                ...prev,
                isGenerating: false,
              }));
              isActiveRef.current = false;
              currentStreamSessionIdRef.current = null;
              settle('cancelled');
            }
          });

          unlistenRef.current = unlisten;
          isStartingRef.current = false;
          resetTimeout();

          await invoke('qbank_ai_generate_questions', {
            request: {
              ...request,
              stream_session_id: streamSessionId,
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
            isGenerating: false,
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
   * 取消出题
   */
  const cancelGeneration = useCallback(async () => {
    const sid = currentStreamSessionIdRef.current;
    if (!sid) return;

    currentStreamSessionIdRef.current = null;
    cleanup();

    setState((prev) => ({
      ...prev,
      isGenerating: false,
    }));

    isActiveRef.current = false;
    isStartingRef.current = false;
    settleRef.current?.('cancelled');

    await invoke('qbank_cancel_generation', {
      streamEventName: `qbank_generation_stream_${sid}`,
    });
  }, [cleanup]);

  /**
   * 重置状态（同时取消正在进行的后端流）
   */
  const resetState = useCallback(() => {
    const sid = currentStreamSessionIdRef.current;
    if (sid && isActiveRef.current) {
      void invoke('qbank_cancel_generation', {
        streamEventName: `qbank_generation_stream_${sid}`,
      });
    }
    cleanup();
    setState(INITIAL_STATE);
    currentStreamSessionIdRef.current = null;
    isActiveRef.current = false;
    isStartingRef.current = false;
    settleRef.current?.('cancelled');
  }, [cleanup]);

  // 组件卸载清理
  useEffect(() => {
    return () => {
      if (isActiveRef.current) {
        const sid = currentStreamSessionIdRef.current;
        if (sid) {
          void invoke('qbank_cancel_generation', {
            streamEventName: `qbank_generation_stream_${sid}`,
          });
        }
      }
      settleRef.current?.('cancelled');
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    startGeneration,
    cancelGeneration,
    resetState,
  };
}
