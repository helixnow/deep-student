/**
 * 翻译流式管理 Hook
 *
 * 职责：
 * - 管理翻译流式会话状态
 * - 监听 Tauri 流式事件并批处理更新状态
 * - 提供翻译触发与取消接口
 *
 * 关键保证：
 * - startTranslation 返回的 Promise 在任何路径（完成/错误/取消/超时/卸载）都会 settle
 * - data chunk 通过 requestAnimationFrame 合并，避免每个 token 触发整树重渲染
 * - 权威译文以 accumulatedTextRef 同步维护，complete/cancel 结果随 Promise 返回，
 *   调用方无需依赖「state → ref 晚一帧」的同步
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getErrorMessage } from '../utils/errorUtils';
import { useTranslationStreamBridge, type TranslationStreamPhase } from './translationStreamBridge';

// 翻译空闲超时时间（毫秒）- 2分钟无任何事件视为超时
const TRANSLATION_TIMEOUT_MS = 120000;
// invoke 正常返回后等待终态事件的宽限期（毫秒）：
// 事件与 invoke 返回值可能乱序到达，宽限期兜底保证 Promise 必定 settle
const POST_INVOKE_GRACE_MS = 3000;

/** 组件卸载导致的 Promise 终止哨兵，调用方可据此静默忽略 */
export const TRANSLATION_STREAM_UNMOUNTED_ERROR = 'TRANSLATION_STREAM_UNMOUNTED';

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
  domain?: string;
}

/**
 * startTranslation 的 settle 结果：携带权威最终文本，避免调用方读取竞态 ref
 */
export type TranslationOutcome =
  | { outcome: 'completed'; translatedText: string; translationId: string | null }
  | { outcome: 'cancelled'; translatedText: string };

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
  /** 后端回报的检测语言（协议扩展点，后端未实现时恒为 null） */
  detectedLang: string | null;
  /** 译文是否为取消/出错后残留的部分结果 */
  isPartialResult: boolean;
}

/**
 * 流式事件负载类型
 *
 * 后端协议约定「只增字段不改名」，新增可选字段一律做防御性读取。
 */
interface TranslationStreamEvent {
  type: 'data' | 'complete' | 'error' | 'cancelled';
  chunk?: string;
  char_count?: number;
  word_count?: number;
  id?: string;
  translated_text?: string;
  created_at?: string;
  message?: string;
  /** 协议扩展点：后端检测到的源语言（当前后端尚未发射，两种命名都兼容） */
  detected_lang?: string;
  detected_language?: string;
}

// 模块级会话计数器：与时间戳、随机后缀共同保证多实例/同毫秒不冲突
let translationSessionCounter = 0;

// 流桥所有权 token 计数器：每个 hook 实例一个稳定 token，
// 同 key 双实例（分屏同一资源）时先卸载的一方不清掉后发布者的快照
let streamBridgeOwnerCounter = 0;

function createTranslationSessionId(): string {
  translationSessionCounter += 1;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `translate_${Date.now()}_${translationSessionCounter}_${rand}`;
}

const INITIAL_STATE: TranslationStreamState = {
  isTranslating: false,
  translatedText: '',
  error: null,
  sessionId: null,
  charCount: 0,
  wordCount: 0,
  currentTranslationId: null,
  detectedLang: null,
  isPartialResult: false,
};

/**
 * 翻译流式管理 Hook
 */
export interface UseTranslationStreamOptions {
  /** DSTU resourceId — 发布快照到 translationStreamBridge 供外部订阅 */
  publishKey?: string | null;
}

export function useTranslationStream(options?: UseTranslationStreamOptions) {
  const publishKey = options?.publishKey ?? null;
  const { t } = useTranslation(['translation']);
  const [state, setState] = useState<TranslationStreamState>(INITIAL_STATE);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const isStartingRef = useRef<boolean>(false); // listen→invoke 窗口内防重入
  const isActiveRef = useRef<boolean>(false); // 跟踪是否有活跃的翻译会话
  const isMountedRef = useRef<boolean>(true); // 跟踪组件挂载状态
  const currentSessionIdRef = useRef<string | null>(null); // 取消/卸载用，避免闭包过期 state

  // 权威累计译文（同步更新，flush 与终态都从这里取值）
  const accumulatedTextRef = useRef<string>('');
  // chunk 批处理：是否有待 flush 的增量 + rAF 句柄
  const hasPendingChunkRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  // 最近一次事件携带的统计与检测语言（flush 时一并写入 state）
  const latestCountsRef = useRef<{ charCount: number; wordCount: number }>({ charCount: 0, wordCount: 0 });
  // 重复/乱序 chunk 防御：后端 char_count 为累计值、严格单调递增，
  // 收到不增反降（或持平）的 data 事件即为重复投递，丢弃防止译文重复拼接
  const lastSeenCharCountRef = useRef<number>(-1);
  const detectedLangRef = useRef<string | null>(null);
  // 滑动超时：单一定时器 + 最后活动时间戳，避免每个 chunk 重建定时器
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityAtRef = useRef<number>(0);
  // invoke 返回后的兜底定时器
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 当前会话的 settle/fail（供 cancelTranslation / 卸载路径主动结束 Promise）
  const settleRef = useRef<{
    settle: (outcome: TranslationOutcome) => void;
    fail: (error: unknown) => void;
  } | null>(null);

  const safeSetState = useCallback(
    (updater: (prev: TranslationStreamState) => TranslationStreamState) => {
      if (!isMountedRef.current) return;
      setState(updater);
    },
    []
  );

  /**
   * 卸掉监听器 / 定时器 / rAF（不触碰会话标志）
   */
  const teardownTransport = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    hasPendingChunkRef.current = false;
  }, []);

  /**
   * 结束当前会话：卸传输 + 重置会话标志。
   * 注意：不重置「已 settle」语义 —— settle/fail 闭包自带一次性保护。
   */
  const finishSession = useCallback(() => {
    teardownTransport();
    isStartingRef.current = false;
    isActiveRef.current = false;
    settleRef.current = null;
  }, [teardownTransport]);

  /**
   * 将累计译文批量写入 state（每帧最多一次）
   */
  const flushPendingChunks = useCallback(() => {
    rafRef.current = null;
    if (!hasPendingChunkRef.current) return;
    hasPendingChunkRef.current = false;
    safeSetState((prev) => ({
      ...prev,
      translatedText: accumulatedTextRef.current,
      charCount: latestCountsRef.current.charCount,
      wordCount: latestCountsRef.current.wordCount,
      detectedLang: detectedLangRef.current ?? prev.detectedLang,
    }));
  }, [safeSetState]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      rafRef.current = requestAnimationFrame(flushPendingChunks);
    } else {
      // 极端环境兜底（如测试环境无 rAF）
      flushPendingChunks();
    }
  }, [flushPendingChunks]);

  /**
   * 启动翻译
   *
   * @param request 翻译请求参数
   * @returns Promise，在完成/取消时 resolve（携带最终文本），错误/超时/卸载时 reject
   */
  const startTranslation = useCallback(
    (request: TranslationRequest): Promise<TranslationOutcome> => {
      return new Promise<TranslationOutcome>((resolve, reject) => {
        void (async () => {
          // 防止重复调用
          if (isStartingRef.current || isActiveRef.current) {
            console.warn(t('translation:toast.translating_already'));
            reject(new Error(t('translation:toast.translating_already')));
            return;
          }

          // 清理上一个会话可能残留的传输资源
          finishSession();

          isStartingRef.current = true;
          isActiveRef.current = true;

          const sessionId = createTranslationSessionId();
          currentSessionIdRef.current = sessionId;
          accumulatedTextRef.current = '';
          latestCountsRef.current = { charCount: 0, wordCount: 0 };
          lastSeenCharCountRef.current = -1;
          detectedLangRef.current = null;
          lastActivityAtRef.current = Date.now();

          let settled = false;
          const settle = (outcome: TranslationOutcome) => {
            if (settled) return;
            settled = true;
            resolve(outcome);
          };
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          settleRef.current = { settle, fail };

          // 重置状态
          safeSetState(() => ({
            ...INITIAL_STATE,
            isTranslating: true,
            sessionId,
          }));

          // 滑动超时：单一定时器，到点检查最后活动时间
          const armIdleTimeout = (delay: number) => {
            timeoutRef.current = setTimeout(() => {
              timeoutRef.current = null;
              if (settled || !isActiveRef.current || currentSessionIdRef.current !== sessionId) return;
              const idle = Date.now() - lastActivityAtRef.current;
              if (idle < TRANSLATION_TIMEOUT_MS) {
                armIdleTimeout(TRANSLATION_TIMEOUT_MS - idle);
                return;
              }
              console.error('[TranslationStream] Translation timed out');
              const message = t('translation:errors.timeout');
              finishSession();
              safeSetState((prev) => ({
                ...prev,
                isTranslating: false,
                translatedText: accumulatedTextRef.current,
                error: message,
                sessionId: null,
                isPartialResult: accumulatedTextRef.current.length > 0,
              }));
              fail(new Error(message));
            }, delay);
          };

          try {
            const unlisten = await listen<TranslationStreamEvent>(
              `translation_stream_${sessionId}`,
              (event) => {
                const payload = event.payload;
                // 迟到事件保护：会话已结束/已被新会话替换时忽略
                if (settled || !isActiveRef.current || currentSessionIdRef.current !== sessionId) {
                  return;
                }

                lastActivityAtRef.current = Date.now();
                // 协议扩展点：任何事件都可能携带检测语言
                const detected = payload.detected_lang ?? payload.detected_language ?? null;
                if (detected) {
                  detectedLangRef.current = detected;
                }

                if (payload.type === 'data') {
                  // A6-11: 后端只回传增量 chunk，前端自行累加；rAF 批处理写入 state
                  if (payload.char_count != null) {
                    if (payload.char_count <= lastSeenCharCountRef.current) {
                      console.warn('[TranslationStream] Dropping duplicate/out-of-order chunk (char_count regressed)');
                      return;
                    }
                    lastSeenCharCountRef.current = payload.char_count;
                    latestCountsRef.current.charCount = payload.char_count;
                  }
                  accumulatedTextRef.current += payload.chunk ?? '';
                  if (payload.word_count != null) latestCountsRef.current.wordCount = payload.word_count;
                  hasPendingChunkRef.current = true;
                  scheduleFlush();
                  return;
                }

                if (payload.type === 'complete') {
                  // complete 事件携带的全量文本为权威结果
                  const finalText = payload.translated_text ?? accumulatedTextRef.current;
                  accumulatedTextRef.current = finalText;
                  const translationId = payload.id ?? null;
                  finishSession();
                  safeSetState((prev) => ({
                    ...prev,
                    isTranslating: false,
                    translatedText: finalText,
                    sessionId: null,
                    currentTranslationId: translationId,
                    detectedLang: detected ?? detectedLangRef.current ?? prev.detectedLang,
                    isPartialResult: false,
                  }));
                  settle({ outcome: 'completed', translatedText: finalText, translationId });
                  return;
                }

                if (payload.type === 'error') {
                  const message = payload.message || t('translation:errors.translate_failed');
                  finishSession();
                  safeSetState((prev) => ({
                    ...prev,
                    isTranslating: false,
                    translatedText: accumulatedTextRef.current,
                    error: message,
                    sessionId: null,
                    isPartialResult: accumulatedTextRef.current.length > 0,
                  }));
                  fail(new Error(message));
                  return;
                }

                if (payload.type === 'cancelled') {
                  const partialText = accumulatedTextRef.current;
                  finishSession();
                  safeSetState((prev) => ({
                    ...prev,
                    isTranslating: false,
                    translatedText: partialText,
                    sessionId: null,
                    isPartialResult: partialText.length > 0,
                  }));
                  settle({ outcome: 'cancelled', translatedText: partialText });
                }
              }
            );

            // listen() 等待期间组件可能已卸载或会话已被取消，
            // 此时必须立即释放监听器，否则监听器永久泄漏
            if (!isMountedRef.current || settled || currentSessionIdRef.current !== sessionId) {
              unlisten();
              if (!settled) {
                finishSession();
                fail(new Error(TRANSLATION_STREAM_UNMOUNTED_ERROR));
              }
              return;
            }

            unlistenRef.current = unlisten;
            isStartingRef.current = false;
            armIdleTimeout(TRANSLATION_TIMEOUT_MS);

            await invoke('translate_text_stream', {
              request: {
                text: request.text,
                src_lang: request.src_lang,
                tgt_lang: request.tgt_lang,
                prompt_override: request.prompt_override || null,
                session_id: sessionId,
                formality: request.formality || null,
                glossary: request.glossary || null,
                domain: request.domain || null,
              },
            });

            // invoke 正常返回但终态事件尚未到达（事件投递与 invoke 返回可能乱序）：
            // 宽限期后以累计文本作为完成结果兜底，保证 Promise 必定 settle。
            // 宽限期内仍有 chunk 到达说明流尚未排空，顺延而非中途误判完成
            if (!settled && isActiveRef.current && currentSessionIdRef.current === sessionId) {
              const armGraceTimer = (delay: number) => {
                graceTimerRef.current = setTimeout(() => {
                  graceTimerRef.current = null;
                  if (settled || !isActiveRef.current || currentSessionIdRef.current !== sessionId) return;
                  const sinceLastEvent = Date.now() - lastActivityAtRef.current;
                  if (sinceLastEvent < POST_INVOKE_GRACE_MS) {
                    armGraceTimer(POST_INVOKE_GRACE_MS - sinceLastEvent);
                    return;
                  }
                  console.warn('[TranslationStream] invoke resolved without terminal event, settling with accumulated text');
                  const finalText = accumulatedTextRef.current;
                  finishSession();
                  safeSetState((prev) => ({
                    ...prev,
                    isTranslating: false,
                    translatedText: finalText,
                    sessionId: null,
                    isPartialResult: false,
                  }));
                  settle({ outcome: 'completed', translatedText: finalText, translationId: null });
                }, delay);
              };
              armGraceTimer(POST_INVOKE_GRACE_MS);
            }
          } catch (error: unknown) {
            // invoke reject（当前后端错误主通道）或 listen 失败
            if (!settled) {
              finishSession();
              safeSetState((prev) => ({
                ...prev,
                isTranslating: false,
                translatedText: accumulatedTextRef.current,
                error: getErrorMessage(error),
                sessionId: null,
                isPartialResult: accumulatedTextRef.current.length > 0,
              }));
              fail(error);
            }
          }
        })().catch(reject);
      });
    },
    [finishSession, safeSetState, scheduleFlush, t]
  );

  /**
   * 取消翻译
   *
   * 先在本地 settle（保证 startTranslation 的 await 立即结束、UI 即时反馈），
   * 再通知后端停止流；后端 cancelled 事件是否到达都不影响前端状态一致性。
   */
  const cancelTranslation = useCallback(async () => {
    const currentSessionId = currentSessionIdRef.current;
    if (!currentSessionId || !isActiveRef.current) {
      return;
    }

    const partialText = accumulatedTextRef.current;
    const settleFn = settleRef.current?.settle;
    finishSession();
    safeSetState((prev) => ({
      ...prev,
      isTranslating: false,
      translatedText: partialText,
      sessionId: null,
      isPartialResult: partialText.length > 0,
    }));
    settleFn?.({ outcome: 'cancelled', translatedText: partialText });

    const streamEventName = `translation_stream_${currentSessionId}`;
    try {
      await invoke('cancel_stream', { streamEventName });
    } catch (error: unknown) {
      console.warn('[TranslationStream] Failed to cancel stream:', error);
    }
  }, [finishSession, safeSetState]);

  /**
   * 手动设置翻译文本（用于编辑后的保存 / 交换语言 / 清空）
   * 同步更新权威 ref，并清除「部分结果」标记
   */
  const setTranslatedText = useCallback((text: string) => {
    accumulatedTextRef.current = text;
    safeSetState((prev) => ({
      ...prev,
      translatedText: text,
      isPartialResult: false,
    }));
  }, [safeSetState]);

  /**
   * 用户确认已知晓「部分结果」提示（仅清除标记，保留文本）
   */
  const acknowledgePartialResult = useCallback(() => {
    safeSetState((prev) => (prev.isPartialResult ? { ...prev, isPartialResult: false } : prev));
  }, [safeSetState]);

  /**
   * 重置状态
   *
   * 若重置时仍有活跃会话，同时通知后端停止流：
   * 监听器已卸载，放任后端继续生成只会白耗资源
   */
  const resetState = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    const wasActive = isActiveRef.current;
    const settleFn = settleRef.current?.settle;
    finishSession();
    settleFn?.({ outcome: 'cancelled', translatedText: accumulatedTextRef.current });
    if (sessionId && wasActive) {
      invoke('cancel_stream', { streamEventName: `translation_stream_${sessionId}` }).catch((err) => {
        console.warn('[TranslationStream] Failed to cancel stream on reset:', err);
      });
    }
    currentSessionIdRef.current = null;
    accumulatedTextRef.current = '';
    latestCountsRef.current = { charCount: 0, wordCount: 0 };
    detectedLangRef.current = null;
    safeSetState(() => ({ ...INITIAL_STATE }));
  }, [finishSession, safeSetState]);

  // 组件卸载时清理：取消后端流 + 终止挂起 Promise（哨兵错误，调用方静默忽略）
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const sessionId = currentSessionIdRef.current;
      if (sessionId && isActiveRef.current) {
        const streamEventName = `translation_stream_${sessionId}`;
        invoke('cancel_stream', { streamEventName }).catch((err) => {
          console.warn('[TranslationStream] 组件卸载时取消流失败:', err);
        });
      }
      const failFn = settleRef.current?.fail;
      finishSession();
      failFn?.(new Error(TRANSLATION_STREAM_UNMOUNTED_ERROR));
      currentSessionIdRef.current = null;
    };
  }, [finishSession]);

  // 流桥所有权 token（实例级、惰性初始化，整个生命周期稳定）
  const bridgeOwnerTokenRef = useRef<string | null>(null);
  if (bridgeOwnerTokenRef.current === null) {
    streamBridgeOwnerCounter += 1;
    bridgeOwnerTokenRef.current = `translation_stream_owner_${streamBridgeOwnerCounter}`;
  }

  useEffect(() => {
    if (!publishKey) return;
    // 阶段语义：error 终态 > 流式中 > 有结果的终态 > 初始空闲
    const phase: TranslationStreamPhase = state.error
      ? 'error'
      : state.isTranslating
        ? 'streaming'
        : state.translatedText || state.currentTranslationId
          ? 'done'
          : 'idle';
    useTranslationStreamBridge.getState().actions.publish(
      publishKey,
      {
        isTranslating: state.isTranslating,
        translatedText: state.translatedText,
        charCount: state.charCount,
        wordCount: state.wordCount,
        detectedLang: state.detectedLang,
        isPartialResult: state.isPartialResult,
        phase,
      },
      bridgeOwnerTokenRef.current ?? undefined,
    );
  }, [publishKey, state]);

  useEffect(() => {
    if (!publishKey) return;
    const ownerToken = bridgeOwnerTokenRef.current ?? undefined;
    return () => {
      // 带所有权清理：同 key 的另一实例已后发布（接管所有权）时此清理为 no-op
      useTranslationStreamBridge.getState().actions.clear(publishKey, ownerToken);
    };
  }, [publishKey]);

  return {
    ...state,
    startTranslation,
    cancelTranslation,
    resetState,
    setTranslatedText,
    acknowledgePartialResult,
  };
}
