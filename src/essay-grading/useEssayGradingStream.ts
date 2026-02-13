/**
 * 作文批改流式管理 Hook
 *
 * 职责：
 * - 管理批改流式会话状态
 * - 监听 SSE 事件并更新状态
 * - 提供批改触发与取消接口
 *
 * 与翻译模块的关系：
 * - 参考翻译模块的设计模式
 * - 完全独立的状态管理
 *
 * ★ 2026-02-02 边缘状态修复：
 * - F-5: 取消操作状态清理完整
 * - F-6: 添加超时机制（120秒无数据则超时）
 * - E-3: 组件卸载时取消后端流
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getErrorMessage } from '../utils/errorUtils';

/** 批改超时时间（毫秒）- 120秒无数据则超时 */
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
}

/**
 * SSE 事件负载类型
 */
interface GradingStreamEvent {
  type: 'data' | 'complete' | 'error' | 'cancelled';
  chunk?: string;
  accumulated?: string;
  char_count?: number;
  round_id?: string;
  grading_result?: string;
  overall_score?: number | null;
  created_at?: string;
  message?: string;
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
  });

  // 保存最后一次请求，用于重试
  const lastRequestRef = useRef<GradingRequest | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const isStartingRef = useRef<boolean>(false);
  const isActiveRef = useRef<boolean>(false);
  const settledRef = useRef<boolean>(false);
  /** ★ F-6: 超时计时器引用 */
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** ★ E-3: 保存当前 streamSessionId 用于卸载时取消 */
  const currentStreamSessionIdRef = useRef<string | null>(null);

  /**
   * 清理监听器和超时计时器
   * ★ F-5/F-6 修复：完整清理所有状态
   */
  const cleanup = useCallback(() => {
    // 清理事件监听器
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    // ★ F-6: 清理超时计时器
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    isStartingRef.current = false;
    isActiveRef.current = false;
    settledRef.current = false;
  }, []);

  /**
   * 启动批改
   * ★ F-6 修复：添加超时机制
   */
  const startGrading = useCallback((request: GradingRequest) => {
    return new Promise<'completed' | 'cancelled'>(async (resolve, reject) => {
      // 防止重复调用
      if (isStartingRef.current || isActiveRef.current) {
        console.warn('[EssayGrading] 批改已在进行中');
        reject(new Error(t('essay_grading:toast.grading_already')));
        return;
      }

      // 清理旧监听器和状态
      cleanup();

      // 设置标志
      isStartingRef.current = true;
      isActiveRef.current = true;
      settledRef.current = false;

      // ★ E-3: 保存当前 streamSessionId 用于卸载时取消
      currentStreamSessionIdRef.current = request.stream_session_id;

      // 保存请求用于重试
      lastRequestRef.current = request;

      // 重置状态
      setState({
        isGrading: true,
        gradingResult: '',
        error: null,
        streamSessionId: request.stream_session_id,
        charCount: 0,
        currentRoundId: null,
        canRetry: false,
        isPartialResult: false,
      });

      let settled = false;
      const settle = (outcome: 'completed' | 'cancelled') => {
        if (settled || settledRef.current) return;
        settled = true;
        settledRef.current = true;
        // ★ F-6: 清理超时计时器
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        resolve(outcome);
      };
      const fail = (error: unknown) => {
        if (settled || settledRef.current) return;
        settled = true;
        settledRef.current = true;
        // ★ F-6: 清理超时计时器
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        reject(error);
      };

      // ★ F-6: 重置超时计时器的函数
      const resetTimeout = () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          if (!settled && !settledRef.current && isActiveRef.current) {
            console.warn('[EssayGrading] 批改超时，120秒内无数据响应');
            setState((prev) => ({
              ...prev,
              isGrading: false,
              error: t('essay_grading:errors.timeout'),
              streamSessionId: null,
              canRetry: true,
              isPartialResult: prev.gradingResult.length > 0,
            }));
            cleanup();
            // 尝试取消后端流
            const streamEventName = `essay_grading_stream_${request.stream_session_id}`;
            invoke('cancel_stream', { streamEventName }).catch(console.warn);
            fail(new Error(t('essay_grading:errors.timeout')));
          }
        }, GRADING_TIMEOUT_MS);
      };

      // ★ F-6: 启动初始超时计时器
      resetTimeout();

      try {
        const unlisten = await listen<GradingStreamEvent>(
          `essay_grading_stream_${request.stream_session_id}`,
          (event) => {
            const payload = event.payload;

            // ★ F-6: 收到任何事件都重置超时计时器
            resetTimeout();

            if (payload.type === 'data') {
              // ★ 二轮修复：添加活跃状态检查，防止超时后收到延迟事件导致状态闪烁
              if (!isActiveRef.current || settledRef.current) return;
              setState((prev) => ({
                ...prev,
                gradingResult: payload.accumulated || prev.gradingResult,
                charCount: payload.char_count ?? prev.charCount,
              }));
              return;
            }

            if (payload.type === 'complete') {
              if (!isActiveRef.current || settledRef.current) {
                console.warn('[EssayGrading] 收到 complete 事件但批改已结束，忽略');
                return;
              }

              setState((prev) => ({
                ...prev,
                isGrading: false,
                gradingResult: payload.grading_result || prev.gradingResult,
                streamSessionId: null,
                currentRoundId: payload.round_id || null,
                isPartialResult: false,
              }));
              cleanup();
              currentStreamSessionIdRef.current = null;
              settle('completed');
              return;
            }

            if (payload.type === 'error') {
              const message = payload.message || 'Unknown error';
              setState((prev) => ({
                ...prev,
                isGrading: false,
                error: message,
                streamSessionId: null,
                canRetry: true, // 错误后允许重试
                isPartialResult: prev.gradingResult.length > 0, // ★ M-048: 标记部分结果
              }));
              cleanup();
              currentStreamSessionIdRef.current = null;
              fail(new Error(message));
              return;
            }

            if (payload.type === 'cancelled') {
              setState((prev) => ({
                ...prev,
                isGrading: false,
                streamSessionId: null,
              }));
              cleanup();
              currentStreamSessionIdRef.current = null;
              settle('cancelled');
            }
          }
        );

        unlistenRef.current = unlisten;

        // 标记启动完成
        isStartingRef.current = false;

        await invoke('essay_grading_stream', { request });
      } catch (error: unknown) {
        setState((prev) => ({
          ...prev,
          isGrading: false,
          error: getErrorMessage(error),
          streamSessionId: null,
          canRetry: true, // 错误后允许重试
          isPartialResult: prev.gradingResult.length > 0, // ★ M-048: 标记部分结果
        }));
        cleanup();
        currentStreamSessionIdRef.current = null;
        fail(error);
      }
    });
  }, [cleanup, t]);

  /**
   * 取消批改
   * ★ F-5 修复：完整清理状态和监听器
   * ★ 二轮修复：使用 ref 而非 state 避免竞态条件
   */
  const cancelGrading = useCallback(async () => {
    // ★ 使用 ref 而非 state，避免 React 异步更新导致的竞态条件
    const currentStreamSessionId = currentStreamSessionIdRef.current;
    if (!currentStreamSessionId) {
      return;
    }

    // ★ 立即清除 ref 防止重复取消
    currentStreamSessionIdRef.current = null;

    // ★ F-5: 立即清理监听器和超时计时器
    cleanup();

    setState((prev) => ({
      ...prev,
      isGrading: false,
      streamSessionId: null,
      isPartialResult: prev.gradingResult.length > 0,
    }));

    const streamEventName = `essay_grading_stream_${currentStreamSessionId}`;
    try {
      await invoke('cancel_stream', { streamEventName });
    } catch (error: unknown) {
      console.warn('[EssayGrading] 取消流失败:', error);
    }
  }, [cleanup]); // ★ 移除 state.streamSessionId 依赖

  /**
   * 手动设置批改结果
   */
  const setGradingResult = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      gradingResult: text,
    }));
  }, []);

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
   */
  const resetState = useCallback(() => {
    cleanup();
    lastRequestRef.current = null;
    setState({
      isGrading: false,
      gradingResult: '',
      error: null,
      streamSessionId: null,
      charCount: 0,
      currentRoundId: null,
      canRetry: false,
      isPartialResult: false,
    });
  }, [cleanup]);

  // 组件卸载时清理
  // ★ E-3 修复：卸载时同时取消后端流
  useEffect(() => {
    return () => {
      // ★ E-3: 如果正在批改，先取消后端流
      const streamSessionId = currentStreamSessionIdRef.current;
      if (streamSessionId && isActiveRef.current) {
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
