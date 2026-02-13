/**
 * 翻译流式管理 Hook
 * 
 * 职责：
 * - 管理翻译流式会话状态
 * - 监听 SSE 事件并更新状态
 * - 提供翻译触发与取消接口
 * 
 * 与聊天模块的关系：
 * - 完全独立的状态管理，不依赖聊天相关 Hook
 * - 仅复用底层 Tauri API 调用机制
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getErrorMessage } from '../utils/errorUtils';

// 翻译超时时间（毫秒）- 2分钟
const TRANSLATION_TIMEOUT_MS = 120000;

/**
 * 翻译请求参数
 */
export interface TranslationRequest {
  text: string;
  src_lang: string;
  tgt_lang: string;
  prompt_override?: string;
  formality?: 'formal' | 'casual' | 'auto' | null;
  glossary?: Array<[string, string]>;
}

/**
 * 翻译流式状态
 */
export interface TranslationStreamState {
  isTranslating: boolean;
  translatedText: string;
  error: string | null;
  sessionId: string | null;
  charCount: number;
  wordCount: number;
  currentTranslationId: string | null; // 当前翻译记录的ID
}

/**
 * SSE 事件负载类型
 */
interface TranslationStreamEvent {
  type: 'data' | 'complete' | 'error' | 'cancelled';
  chunk?: string;
  accumulated?: string;
  char_count?: number;
  word_count?: number;
  id?: string;
  translated_text?: string;
  created_at?: string;
  message?: string;
}

/**
 * 翻译流式管理 Hook
 */
export function useTranslationStream() {
  const { t } = useTranslation(['translation']);
  const [state, setState] = useState<TranslationStreamState>({
    isTranslating: false,
    translatedText: '',
    error: null,
    sessionId: null,
    charCount: 0,
    wordCount: 0,
    currentTranslationId: null,
  });

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onCompleteCallbackRef = useRef<((result: { id: string; translatedText: string; createdAt: string }) => void) | null>(null);
  const isStartingRef = useRef<boolean>(false); // 防止重复调用
  const isActiveRef = useRef<boolean>(false); // 跟踪是否有活跃的翻译会话
  const settledRef = useRef<boolean>(false); // 防止重复 settle
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 超时定时器
  const isMountedRef = useRef<boolean>(true); // 跟踪组件挂载状态

  /**
   * 清理监听器和定时器
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
    onCompleteCallbackRef.current = null;
    isStartingRef.current = false;
    isActiveRef.current = false;
    settledRef.current = false;
  }, []);

  /**
   * 启动翻译
   *
   * @param request 翻译请求参数
   */
  const startTranslation = useCallback((request: TranslationRequest) => {
    return new Promise<'completed' | 'cancelled'>(async (resolve, reject) => {
      // 防止重复调用
      if (isStartingRef.current || isActiveRef.current) {
        console.warn(t('translation:toast.translating_already'));
        reject(new Error(t('translation:toast.translating_already')));
        return;
      }

      // 清理旧监听器和状态
      cleanup();
      
      // 设置标志
      isStartingRef.current = true;
      isActiveRef.current = true;
      settledRef.current = false;

      // 生成会话 ID
      const sessionId = `translate_${Date.now()}`;

      // 重置状态
      setState({
        isTranslating: true,
        translatedText: '',
        error: null,
        sessionId,
        charCount: 0,
        wordCount: 0,
        currentTranslationId: null,
      });

      let settled = false;
      const settle = (outcome: 'completed' | 'cancelled') => {
        if (settled || settledRef.current) return;
        settled = true;
        settledRef.current = true;
        resolve(outcome);
      };
      const fail = (error: unknown) => {
        if (settled || settledRef.current) return;
        settled = true;
        settledRef.current = true;
        reject(error);
      };

      try {
        const unlisten = await listen<TranslationStreamEvent>(
          `translation_stream_${sessionId}`,
          (event) => {
            const payload = event.payload;

            // 收到任何事件都重置超时定时器（表示连接正常）
            if (timeoutRef.current) {
              clearTimeout(timeoutRef.current);
            }

            if (payload.type === 'data') {
              // 收到数据，重新设置超时定时器（流式传输中每个 chunk 都会重置）
              timeoutRef.current = setTimeout(() => {
                // 检查组件挂载状态，避免在卸载后调用 setState
                if (!isMountedRef.current) return;
                if (isActiveRef.current && !settledRef.current) {
                  console.error('[TranslationStream] Translation timed out');
                  setState((prev) => ({
                    ...prev,
                    isTranslating: false,
                    error: t('translation:errors.timeout'),
                    sessionId: null,
                  }));
                  cleanup();
                  fail(new Error(t('translation:errors.timeout')));
                }
              }, TRANSLATION_TIMEOUT_MS);

              setState((prev) => ({
                ...prev,
                translatedText: payload.accumulated || prev.translatedText,
                charCount: payload.char_count ?? prev.charCount,
                wordCount: payload.word_count ?? prev.wordCount,
              }));
              return;
            }

            if (payload.type === 'complete') {
              // 防止重复处理 complete 事件
              if (!isActiveRef.current || settledRef.current) {
                console.warn('[TranslationStream] Received complete event but translation already ended, ignoring');
                return;
              }
              
              setState((prev) => ({
                ...prev,
                isTranslating: false,
                translatedText: payload.translated_text || prev.translatedText,
                sessionId: null,
                currentTranslationId: payload.id || null,
              }));
              cleanup();
              settle('completed');
              return;
            }

            if (payload.type === 'error') {
              const message = payload.message || 'Unknown error';
              setState((prev) => ({
                ...prev,
                isTranslating: false,
                error: message,
                sessionId: null,
              }));
              cleanup();
              fail(new Error(message));
              return;
            }

            if (payload.type === 'cancelled') {
              setState((prev) => ({
                ...prev,
                isTranslating: false,
                sessionId: null,
              }));
              cleanup();
              settle('cancelled');
            }
          }
        );

        unlistenRef.current = unlisten;

        // 标记启动完成
        isStartingRef.current = false;

        // 设置初始超时定时器（等待第一个响应）
        timeoutRef.current = setTimeout(() => {
          // 检查组件挂载状态，避免在卸载后调用 setState
          if (!isMountedRef.current) return;
          if (isActiveRef.current && !settledRef.current) {
            console.error('[TranslationStream] Translation timed out (no response)');
            setState((prev) => ({
              ...prev,
              isTranslating: false,
              error: t('translation:errors.timeout'),
              sessionId: null,
            }));
            cleanup();
            fail(new Error(t('translation:errors.timeout')));
          }
        }, TRANSLATION_TIMEOUT_MS);

        await invoke('translate_text_stream', {
          request: {
            text: request.text,
            src_lang: request.src_lang,
            tgt_lang: request.tgt_lang,
            prompt_override: request.prompt_override || null,
            session_id: sessionId,
            formality: request.formality || null,
            glossary: request.glossary || null,
          },
        });
      } catch (error: unknown) {
        setState((prev) => ({
          ...prev,
          isTranslating: false,
          error: getErrorMessage(error),
          sessionId: null,
        }));
        cleanup();
        fail(error);
      }
    });
  }, [cleanup]);

  /**
   * 取消翻译（清理状态）
   */
  const cancelTranslation = useCallback(async () => {
    const currentSessionId = state.sessionId;
    if (!currentSessionId) {
      return;
    }

    setState((prev) => ({
      ...prev,
      isTranslating: false,
    }));

    const streamEventName = `translation_stream_${currentSessionId}`;
    try {
      await invoke('cancel_stream', { streamEventName });
    } catch (error: unknown) {
      console.warn('[TranslationStream] Failed to cancel stream:', error);
    }

    // M-086: 确保清理监听器和重置 ref，防止后端 SSE cancelled 事件丢失时永久阻塞后续翻译
    cleanup();
  }, [state.sessionId, cleanup]);

  /**
   * 手动设置翻译文本（用于编辑后的保存）
   */
  const setTranslatedText = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      translatedText: text,
    }));
  }, []);

  /**
   * 重置状态
   */
  const resetState = useCallback(() => {
    cleanup();
    setState({
      isTranslating: false,
      translatedText: '',
      error: null,
      sessionId: null,
      charCount: 0,
      wordCount: 0,
      currentTranslationId: null,
    });
  }, [cleanup]);

  // 组件卸载时清理
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  return {
    ...state,
    startTranslation,
    cancelTranslation,
    resetState,
    setTranslatedText,
  };
}

