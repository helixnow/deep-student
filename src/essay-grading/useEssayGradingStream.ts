/**
 * 作文批改流式管理 Hook
 *
 * 职责：
 * - 管理批改流式会话状态
 * - 监听 SSE 事件并更新状态
 * - 提供批改触发与取消接口
 *
 * ═══════════ Settle 状态机语义（2026-07 重构） ═══════════
 *
 * startGrading 返回的 Promise 保证"恰好 settle 一次"，可能的结算路径：
 *   1. complete 事件        → resolve('completed')
 *   2. error 事件           → reject(Error(message))
 *   3. cancelled 事件       → resolve('cancelled')
 *   4. 本地取消（cancelGrading / resetState / 卸载）→ resolve('cancelled')，不等后端事件
 *   5. 滑动超时（距上一次事件 120s）→ reject(timeout)
 *   6. invoke reject        → reject(原始错误)
 *   7. invoke resolve 兜底  → 事件丢失时按命令返回值 resolve（见 startGrading 内注释）
 *
 * 关键不变量：
 * - settledRef 的生命周期归属于"单次 startGrading 运行"：只在运行开始时复位，
 *   由 settle/fail 置位。cleanup() 绝不触碰它——否则取消后卸载 listener 会
 *   击穿结算屏障，导致迟到的后端事件被二次处理。
 * - 结算顺序统一为：settle（resolve/reject + 置位屏障）→ setState → cleanup（卸 listener）。
 *   listener 保留到 settle 之后才卸载，settle 与 unlisten 之间到达的迟到事件
 *   由 settledRef 守卫忽略。
 * - 取消路径"本地优先结算"：cancelGrading 先 resolve('cancelled') 再通知后端，
 *   即使后端 cancelled 事件丢失/迟到，调用方 await 也不会挂起。
 */

import { useState, useEffect, useCallback, useRef, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getErrorMessage } from '../utils/errorUtils';
import { classifyGradingError, type GradingErrorKind } from './essayGradingApi';

/** 批改滑动超时（毫秒）——距上一次收到流事件超过该时长判定为超时 */
const GRADING_TIMEOUT_MS = 120000;

/**
 * 批改请求参数
 */
export interface GradingRequest {
  session_id: string;
  stream_session_id: string;
  round_number: number;
  input_text: string;
  /** 作文题干（可选） */
  topic?: string;
  /** 批阅模式 ID（可选，默认使用日常练习模式） */
  mode_id?: string;
  /** 模型配置 ID（可选，默认使用 Model2） */
  model_config_id?: string;
  essay_type: string;
  grade_level: string;
  custom_prompt?: string;
  previous_result?: string;
  previous_input?: string;
  /** 作文原图 base64 列表（多模态模型使用原图，文本模型使用 OCR 文本） */
  image_base64_list?: string[];
  /** 题目/参考材料图片 base64 列表（作文要求、原题目、参考范文等） */
  topic_image_base64_list?: string[];
}

/**
 * 批改流式状态
 */
export interface GradingStreamState {
  isGrading: boolean;
  gradingResult: string;
  error: string | null;
  streamSessionId: string | null;
  charCount: number;
  currentRoundId: string | null;
  /** 是否可以重试（只在错误后且有上次请求时为 true） */
  canRetry: boolean;
  isPartialResult: boolean;
  /** 后端权威综合得分（complete 事件的 overall_score，未评分为 null） */
  finalScore?: number | null;
  /** 后端解析后的评分 JSON 字符串（complete 事件的 parsed_score） */
  finalParsedScore?: string | null;
  /** 错误分类（网络/鉴权/限流/超时等），无错误时为 null；供 UI 分别呈现 */
  errorKind?: GradingErrorKind | null;
  /** 分类建议是否可重试（配置类错误重试无意义）；无错误时为 null */
  errorRetryable?: boolean | null;
}

/**
 * SSE 事件负载类型
 */
interface GradingStreamEvent {
  type: 'data' | 'complete' | 'error' | 'cancelled';
  chunk?: string;
  char_count?: number;
  round_id?: string;
  grading_result?: string;
  overall_score?: number | null;
  parsed_score?: string | null;
  created_at?: string;
  message?: string;
  /** error 事件可选附加：错误前已流出的字符数（后端向后兼容扩展字段） */
  partial_chars?: number;
}

/**
 * essay_grading_stream 命令返回值（后端 GradingResponse；取消时为 null）
 */
interface GradingCommandResponse {
  round_id: string;
  session_id: string;
  round_number: number;
  grading_result: string;
  overall_score: number | null;
  dimension_scores_json: string | null;
  created_at: string;
}

/** 单次 startGrading 运行的本地结算句柄（供取消/卸载路径立即 settle 主 Promise） */
interface ActiveRun {
  streamSessionId: string;
  settle: (outcome: 'completed' | 'cancelled') => void;
  fail: (error: unknown) => void;
}

/**
 * 作文批改流式管理 Hook
 */
export function useEssayGradingStream() {
  const { t } = useTranslation(['essay_grading']);
  const [state, setState] = useState<GradingStreamState>({
    isGrading: false,
    gradingResult: '',
    error: null,
    streamSessionId: null,
    charCount: 0,
    currentRoundId: null,
    canRetry: false,
    isPartialResult: false,
    finalScore: null,
    finalParsedScore: null,
    errorKind: null,
    errorRetryable: null,
  });

  // 卸载后 setState 防护：所有异步路径统一走 safeSetState
  const isMountedRef = useRef<boolean>(true);
  const safeSetState = useCallback((updater: SetStateAction<GradingStreamState>) => {
    if (!isMountedRef.current) return;
    setState(updater);
  }, []);

  // 保存最后一次请求，用于重试
  const lastRequestRef = useRef<GradingRequest | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const isStartingRef = useRef<boolean>(false);
  const isActiveRef = useRef<boolean>(false);
  const settledRef = useRef<boolean>(false);
  /** 滑动超时计时器引用 */
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 保存当前 streamSessionId 用于取消/卸载 */
  const currentStreamSessionIdRef = useRef<string | null>(null);
  /** 当前运行的结算句柄；settle/fail 生效后自动清空 */
  const activeRunRef = useRef<ActiveRun | null>(null);

  /**
   * 清理监听器、超时计时器与活跃标志。
   *
   * 注意：cleanup 不复位 settledRef——结算屏障归 startGrading 生命周期所有，
   * 只在下一次 startGrading 开始时复位。取消路径先 settle 再 cleanup，
   * 迟到的后端事件靠 settledRef 屏蔽。
   */
  const cleanup = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    isStartingRef.current = false;
    isActiveRef.current = false;
  }, []);

  /**
   * 启动批改
   */
  const startGrading = useCallback((request: GradingRequest) => {
    return new Promise<'completed' | 'cancelled'>((resolve, reject) => {
      void (async () => {
      // 防止重复调用
      if (isStartingRef.current || isActiveRef.current) {
        console.warn('[EssayGrading] 批改已在进行中');
        reject(new Error(t('essay_grading:toast.grading_already')));
        return;
      }

      // 清理旧监听器和状态
      cleanup();

      // 设置标志。settledRef 只在此处复位（运行开始），cleanup 不会碰它。
      isStartingRef.current = true;
      isActiveRef.current = true;
      settledRef.current = false;

      // 保存当前 streamSessionId 用于取消/卸载
      currentStreamSessionIdRef.current = request.stream_session_id;

      // 保存请求用于重试
      lastRequestRef.current = request;

      // 重置状态
      safeSetState({
        isGrading: true,
        gradingResult: '',
        error: null,
        streamSessionId: request.stream_session_id,
        charCount: 0,
        currentRoundId: null,
        canRetry: false,
        isPartialResult: false,
        finalScore: null,
        finalParsedScore: null,
        errorKind: null,
        errorRetryable: null,
      });

      // ── 结算原语：settle/fail 共享同一道"恰好一次"屏障 ──
      let settled = false;
      const finishOnce = (action: () => void): boolean => {
        if (settled || settledRef.current) return false;
        settled = true;
        settledRef.current = true;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        // 释放本运行的结算句柄（防止取消路径误结算下一次运行）
        if (activeRunRef.current?.streamSessionId === request.stream_session_id) {
          activeRunRef.current = null;
        }
        action();
        return true;
      };
      const settle = (outcome: 'completed' | 'cancelled') => {
        finishOnce(() => resolve(outcome));
      };
      const fail = (error: unknown) => {
        finishOnce(() => reject(error));
      };

      // 暴露给 cancelGrading / resetState / 卸载路径做本地结算
      activeRunRef.current = {
        streamSessionId: request.stream_session_id,
        settle,
        fail,
      };

      // 滑动超时：每收到流事件重置计时，距上一次事件超过 GRADING_TIMEOUT_MS 判死
      const resetTimeout = () => {
        if (settled || settledRef.current || !isActiveRef.current) return;
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          if (settled || settledRef.current || !isActiveRef.current) return;
          console.warn(`[EssayGrading] 批改超时，${GRADING_TIMEOUT_MS / 1000}秒内无流事件`);
          // 先结算（reject），再更新 UI、卸 listener、通知后端停流
          fail(new Error(t('essay_grading:errors.timeout')));
          safeSetState((prev) => ({
            ...prev,
            isGrading: false,
            error: t('essay_grading:errors.timeout'),
            streamSessionId: null,
            canRetry: true,
            isPartialResult: prev.gradingResult.length > 0,
            errorKind: 'timeout',
            errorRetryable: true,
          }));
          cleanup();
          currentStreamSessionIdRef.current = null;
          const streamEventName = `essay_grading_stream_${request.stream_session_id}`;
          invoke('cancel_stream', { streamEventName }).catch(console.warn);
        }, GRADING_TIMEOUT_MS);
      };

      // 启动初始超时计时器
      resetTimeout();

      try {
        const unlisten = await listen<GradingStreamEvent>(
          `essay_grading_stream_${request.stream_session_id}`,
          (event) => {
            const payload = event.payload;

            if (payload.type === 'data') {
              // 活跃/结算守卫：防止取消或超时后迟到的 data 事件导致状态闪烁
              if (!isActiveRef.current || settledRef.current) return;
              // 收到数据重置滑动超时
              resetTimeout();
              // A6-11: 后端只回传增量 chunk，前端自行累加（startGrading 已把 gradingResult 重置为空）
              safeSetState((prev) => {
                const chunk = payload.chunk ?? '';
                // 重复事件防御：char_count 为累计值且严格递增；
                // 累计值未前进且尾部与 chunk 一致时判定为重复投递，直接丢弃
                if (
                  chunk &&
                  typeof payload.char_count === 'number' &&
                  payload.char_count === prev.charCount &&
                  prev.gradingResult.endsWith(chunk)
                ) {
                  return prev;
                }
                return {
                  ...prev,
                  gradingResult: prev.gradingResult + chunk,
                  charCount: payload.char_count ?? prev.charCount,
                };
              });
              return;
            }

            if (payload.type === 'complete') {
              if (!isActiveRef.current || settledRef.current) {
                console.warn('[EssayGrading] 收到 complete 事件但批改已结束，忽略');
                return;
              }

              settle('completed');
              safeSetState((prev) => ({
                ...prev,
                isGrading: false,
                gradingResult: payload.grading_result || prev.gradingResult,
                streamSessionId: null,
                currentRoundId: payload.round_id || null,
                isPartialResult: false,
                finalScore: payload.overall_score ?? null,
                finalParsedScore: payload.parsed_score ?? null,
                errorKind: null,
                errorRetryable: null,
              }));
              cleanup();
              currentStreamSessionIdRef.current = null;
              return;
            }

            if (payload.type === 'error') {
              if (!isActiveRef.current || settledRef.current) {
                console.warn('[EssayGrading] 收到 error 事件但批改已结束，忽略');
                return;
              }
              const message = payload.message || t('essay_grading:errors.grading_failed');
              const classification = classifyGradingError(message);
              fail(new Error(message));
              safeSetState((prev) => ({
                ...prev,
                isGrading: false,
                error: message,
                streamSessionId: null,
                canRetry: true, // 错误后允许重试
                isPartialResult: prev.gradingResult.length > 0, // ★ M-048: 标记部分结果
                errorKind: classification.kind,
                errorRetryable: classification.retryable,
              }));
              cleanup();
              currentStreamSessionIdRef.current = null;
              return;
            }

            if (payload.type === 'cancelled') {
              // 本地取消路径已提前结算时，后端 cancelled 事件在此被守卫忽略
              if (!isActiveRef.current || settledRef.current) return;
              settle('cancelled');
              safeSetState((prev) => ({
                ...prev,
                isGrading: false,
                streamSessionId: null,
                isPartialResult: prev.gradingResult.length > 0,
              }));
              cleanup();
              currentStreamSessionIdRef.current = null;
            }
          }
        );

        // 取消/重置/超时可能发生在 listen 注册挂起期间：
        // 此时运行已结算，立即卸载刚建立的监听器并放弃启动后端命令，防止泄漏
        if (settled || settledRef.current || !isActiveRef.current) {
          unlisten();
          return;
        }

        unlistenRef.current = unlisten;

        // 标记启动完成
        isStartingRef.current = false;

        const response = await invoke<GradingCommandResponse | null>(
          'essay_grading_stream',
          { request }
        );

        // 兜底结算：命令已成功返回但 complete/cancelled 事件尚未（或不会）到达时，
        // 直接用命令返回值结算，避免事件丢失导致 Promise 悬挂。
        // 事件先到达时 settledRef 已置位，此分支自动跳过。
        if (!settled && !settledRef.current) {
          if (response) {
            settle('completed');
            safeSetState((prev) => ({
              ...prev,
              isGrading: false,
              gradingResult: response.grading_result || prev.gradingResult,
              streamSessionId: null,
              currentRoundId: response.round_id || null,
              isPartialResult: false,
              finalScore: response.overall_score ?? null,
              finalParsedScore: response.dimension_scores_json ?? null,
              errorKind: null,
              errorRetryable: null,
            }));
          } else {
            // 后端返回 null 表示流被取消
            settle('cancelled');
            safeSetState((prev) => ({
              ...prev,
              isGrading: false,
              streamSessionId: null,
              isPartialResult: prev.gradingResult.length > 0,
            }));
          }
          cleanup();
          currentStreamSessionIdRef.current = null;
        }
      } catch (error: unknown) {
        // invoke reject（或 listen 失败）。若已被取消/超时结算，忽略迟到的错误，
        // 避免覆盖已定格的 UI 状态。
        if (settled || settledRef.current) {
          console.warn('[EssayGrading] 批改已结算，忽略迟到的命令错误:', error);
          return;
        }
        const classification = classifyGradingError(error);
        fail(error);
        safeSetState((prev) => ({
          ...prev,
          isGrading: false,
          error: getErrorMessage(error),
          streamSessionId: null,
          canRetry: true, // 错误后允许重试
          isPartialResult: prev.gradingResult.length > 0, // ★ M-048: 标记部分结果
          errorKind: classification.kind,
          errorRetryable: classification.retryable,
        }));
        cleanup();
        currentStreamSessionIdRef.current = null;
      }
      })().catch(reject);
    });
  }, [cleanup, t, safeSetState]);

  /**
   * 取消批改
   *
   * 本地优先结算：先立即以 'cancelled' resolve 主 Promise，再卸 listener、
   * 通知后端停流。这样调用方 await 不依赖后端 cancelled 事件是否送达；
   * 事件若迟到，会被 settledRef 守卫忽略。
   */
  const cancelGrading = useCallback(async () => {
    // 使用 ref 而非 state，避免 React 异步更新导致的竞态条件
    const currentStreamSessionId = currentStreamSessionIdRef.current;
    if (!currentStreamSessionId) {
      return;
    }

    // 立即清除 ref 防止重复取消
    currentStreamSessionIdRef.current = null;

    // 1. 本地结算主 Promise（settle 在前，cleanup 在后）
    activeRunRef.current?.settle('cancelled');

    // 2. 更新 UI 状态
    safeSetState((prev) => ({
      ...prev,
      isGrading: false,
      streamSessionId: null,
      isPartialResult: prev.gradingResult.length > 0,
    }));

    // 3. 卸载监听器与计时器（settledRef 保持置位，迟到事件被忽略）
    cleanup();

    // 4. 通知后端停流（结果不影响前端结算）
    const streamEventName = `essay_grading_stream_${currentStreamSessionId}`;
    try {
      await invoke('cancel_stream', { streamEventName });
    } catch (error: unknown) {
      console.warn('[EssayGrading] 取消流失败:', error);
    }
  }, [cleanup, safeSetState]);

  /**
   * 手动设置批改结果
   */
  const setGradingResult = useCallback((text: string) => {
    safeSetState((prev) => ({
      ...prev,
      gradingResult: text,
    }));
  }, [safeSetState]);

  /**
   * 重试批改（使用上次的请求参数，但生成新的 stream_session_id）
   */
  const retryGrading = useCallback(() => {
    if (!lastRequestRef.current) {
      console.warn('[EssayGrading] 没有可重试的请求');
      return Promise.reject(new Error('No request to retry'));
    }

    // 生成新的 stream_session_id
    const newStreamSessionId = `retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const retryRequest: GradingRequest = {
      ...lastRequestRef.current,
      stream_session_id: newStreamSessionId,
    };

    return startGrading(retryRequest);
  }, [startGrading]);

  /**
   * 重置状态
   *
   * 若批改仍在进行，先本地结算为 'cancelled' 并通知后端停流，
   * 避免调用方 await 的 Promise 因 listener 被卸载而永久悬挂。
   */
  const resetState = useCallback(() => {
    const streamSessionId = currentStreamSessionIdRef.current;
    if (streamSessionId && isActiveRef.current) {
      activeRunRef.current?.settle('cancelled');
      const streamEventName = `essay_grading_stream_${streamSessionId}`;
      invoke('cancel_stream', { streamEventName }).catch(console.warn);
    }
    currentStreamSessionIdRef.current = null;
    cleanup();
    lastRequestRef.current = null;
    safeSetState({
      isGrading: false,
      gradingResult: '',
      error: null,
      streamSessionId: null,
      charCount: 0,
      currentRoundId: null,
      canRetry: false,
      isPartialResult: false,
      finalScore: null,
      finalParsedScore: null,
      errorKind: null,
      errorRetryable: null,
    });
  }, [cleanup, safeSetState]);

  // 组件卸载时清理
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const streamSessionId = currentStreamSessionIdRef.current;
      if (streamSessionId && isActiveRef.current) {
        // 先本地结算，保证外部 await 不悬挂（卸载后不再 setState）
        activeRunRef.current?.settle('cancelled');
        const streamEventName = `essay_grading_stream_${streamSessionId}`;
        invoke('cancel_stream', { streamEventName }).catch((err) => {
          console.warn('[EssayGrading] 组件卸载时取消流失败:', err);
        });
      }
      cleanup();
      currentStreamSessionIdRef.current = null;
    };
  }, [cleanup]);

  return {
    ...state,
    startGrading,
    cancelGrading,
    retryGrading,
    resetState,
    setGradingResult,
  };
}
