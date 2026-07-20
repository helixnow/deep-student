/**
 * TranslationPopover - 聊天里选中文字翻译的内联卡片（P0-3 去 Portal / 去 dialog 改造）
 *
 * 当用户在 SelectionToolbar 点击"翻译"后，toolbar 消失，
 * 在选中消息下方展开此翻译卡片。
 *
 * 布局契约：
 * - 非 Portal / 非 fixed / 非 dialog：卡片挂在消息 DOM 流内（消息下方），
 *   随消息一起滚动；不再需要选区定位 / 箭头 / 滚动关闭 / 外点关闭
 * - 可折叠：头部（语言选择 + 模型名 + 折叠/关闭）常显，正文经 .chat-collapse 过渡
 * - 入场复用 .chat-msg-enter；动效走 --chat-motion-* token，自带 reduced-motion 降级
 *
 * 功能要点（与浮层版一致）：
 * - 自动检测语言方向（假名/谚文优先于汉字，避免日文被误判为中文），可手动切换 + 一键对调
 * - 双显示模式（在系统设置 → 模型 中切换）：
 *   - aligned：短语对照，流式 JSON 对象增量渲染（兼容跨行/美化 JSON），hover 同步高亮
 *   - streaming：纯译文单栏，token 流式涌入
 * - 模型来自系统设置的"翻译模型"（fallback 为对话模型 model2）
 * - 上下文消歧（前后各 200 字符传入 prompt，不参与翻译）
 * - LRU 缓存（同一段文字 + 同上下文 + 同模型 + 同语言对 = 即时命中）
 * - 取消语义：关闭卡片 / 切换语言 / 卡片卸载 都会取消尚未完成的请求
 *
 * 流式协议（与 chat_popover.rs 对齐）：
 * - chunk 事件优先消费增量 `delta`（新协议只发 delta，省 IPC）；
 *   `delta` 缺失时退回旧协议的全量 `accumulated`
 * - 整体 `complete` 事件到达才解除 loading；流式中底栏操作禁用并标注"翻译中"
 * - 90s 无新 chunk 视为超时：取消后端流并显示错误 + 重试
 *
 * 取消与竞态：
 * - 每次新发起的请求 reqIdRef 自增；旧回调通过 id 比对自我作废
 * - 调用 invoke('cancel_stream', { streamEventName }) 通知后端中止 SSE
 * - unlisten 移除 Tauri 事件监听
 *
 * 性能：chunk → UI 更新经 requestAnimationFrame 批处理（每帧至多一次 setState）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, Copy, Check, ChatDots, X, ArrowsClockwise, ArrowsLeftRight } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';
import { cn } from '@/utils/cn';
import { IconSwap } from '@/components/ui/IconSwap';
import { NotionButton } from '@/components/ui/NotionButton';
import { PulseDot } from '@/components/ui/PulseDot';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { AppSelect } from '@/components/ui/app-menu/AppSelect';
import type { ApiConfig, ModelAssignments } from '@/types';
import type {
  AlignedSegment,
  ChatTranslationEventPayload,
  ChatTranslationRequestPayload,
  TranslationDisplayMode,
} from './translationTypes';
import { createNdjsonParser, parseAlignedFallback } from './translationNdjsonParser';
import { buildCacheKey, readCache, writeCache } from './translationCache';

// ============================================================================
// 类型
// ============================================================================

export interface TranslationPopoverProps {
  /** 要翻译的原文 */
  sourceText: string;
  /** 是否显示 */
  isVisible: boolean;
  /** 选区前的上下文（用于 prompt 消歧；不会参与翻译） */
  contextBefore?: string;
  /** 选区后的上下文 */
  contextAfter?: string;
  /** 关闭回调 */
  onClose: () => void;
  /** 添加到聊天输入框回调（不发送） */
  onAddToInput?: (text: string) => void;
}

// ============================================================================
// 常量
// ============================================================================

/** 流式兜底超时：超过该时长没有收到任何新 chunk 视为失败 */
const STREAM_STALL_TIMEOUT_MS = 90_000;

const SOURCE_LANGUAGES = [
  { code: 'auto', label: 'translation:languages.auto' },
  { code: 'zh-CN', label: 'translation:languages.zh-CN' },
  { code: 'en', label: 'translation:languages.en' },
  { code: 'ja', label: 'translation:languages.ja' },
  { code: 'ko', label: 'translation:languages.ko' },
  { code: 'fr', label: 'translation:languages.fr' },
  { code: 'de', label: 'translation:languages.de' },
  { code: 'es', label: 'translation:languages.es' },
  { code: 'ru', label: 'translation:languages.ru' },
  { code: 'pt', label: 'translation:languages.pt' },
  { code: 'it', label: 'translation:languages.it' },
  { code: 'vi', label: 'translation:languages.vi' },
  { code: 'th', label: 'translation:languages.th' },
];

const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter((l) => l.code !== 'auto');

const HIGHLIGHT_ACTIVE = { bg: 'bg-primary/10', text: 'text-primary' };

// ============================================================================
// 语言检测辅助
// ============================================================================

function isPrimarilyChinese(text: string): boolean {
  const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (!chineseChars) return false;
  return chineseChars.length / text.length > 0.3;
}

function isPrimarilyJapanese(text: string): boolean {
  const jpChars = text.match(/[\u3040-\u309f\u30a0-\u30ff]/g);
  if (!jpChars) return false;
  return jpChars.length / text.length > 0.15;
}

function isPrimarilyKorean(text: string): boolean {
  const krChars = text.match(/[\uac00-\ud7af\u1100-\u11ff]/g);
  if (!krChars) return false;
  return krChars.length / text.length > 0.15;
}

function detectSourceLang(text: string): string {
  // 先查假名/谚文再查汉字：日文句子常含大量汉字，
  // 若先按汉字占比判断会把日文误判为中文
  if (isPrimarilyJapanese(text)) return 'ja';
  if (isPrimarilyKorean(text)) return 'ko';
  if (isPrimarilyChinese(text)) return 'zh-CN';
  return 'auto';
}

function getDefaultTargetLang(srcLang: string): string {
  return srcLang === 'zh-CN' ? 'en' : 'zh-CN';
}

// ============================================================================
// 错误消息辅助
// ============================================================================

/**
 * 把 invoke 拒绝值转成可读文案，避免 String(err) 产生
 * "[object Object]" 或冗长序列化串覆盖事件通道里的友好错误。
 */
function toErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m;
  }
  return fallback;
}

// ============================================================================
// 设置加载（model id + 显示名 + 显示模式）
// ============================================================================

interface ResolvedTranslationSettings {
  modelId: string;
  modelDisplayName: string;
  mode: TranslationDisplayMode;
}

async function loadTranslationSettings(): Promise<ResolvedTranslationSettings> {
  const fallback: ResolvedTranslationSettings = {
    modelId: '',
    modelDisplayName: '',
    mode: 'aligned',
  };
  try {
    const [assignments, apis] = await Promise.all([
      invoke<ModelAssignments | null>('get_model_assignments').catch(() => null),
      invoke<ApiConfig[]>('get_api_configurations').catch(() => [] as ApiConfig[]),
    ]);

    const mode: TranslationDisplayMode =
      assignments?.translation_display_mode === 'streaming' ? 'streaming' : 'aligned';

    // 解析模型：优先翻译模型，回退 model2
    const translationId = assignments?.translation_model_config_id || '';
    const model2Id = assignments?.model2_config_id || '';
    const resolvedId = translationId || model2Id;

    let displayName = '';
    if (resolvedId && Array.isArray(apis)) {
      const api = apis.find((a) => a.id === resolvedId);
      if (api) {
        // 偏好显示纯模型名；如果 name 已经是 "Vendor - Model" 形式则原样使用
        displayName = api.model || api.name || '';
      }
    }

    return {
      modelId: resolvedId,
      modelDisplayName: displayName,
      mode,
    };
  } catch {
    return fallback;
  }
}

// ============================================================================
// 加载骨架
// ============================================================================

const TranslationLoading: React.FC<{ label: string }> = ({ label }) => (
  <div className="px-3 py-3" role="status" aria-label={label}>
    <div className="space-y-2" aria-hidden>
      <div className="chat-shimmer h-3 w-[92%]" />
      <div className="chat-shimmer h-3 w-[74%]" style={{ animationDelay: '0.15s' }} />
      <div className="chat-shimmer h-3 w-[55%]" style={{ animationDelay: '0.3s' }} />
    </div>
    <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <PulseDot className="h-1.5 w-1.5 text-primary/70" />
      <span>{label}</span>
    </div>
  </div>
);

// ============================================================================
// 组件
// ============================================================================

export const TranslationPopover: React.FC<TranslationPopoverProps> = ({
  sourceText,
  isVisible,
  contextBefore = '',
  contextAfter = '',
  onClose,
  onAddToInput,
}) => {
  const { t } = useTranslation(['translation', 'chatV2']);
  const rootRef = useRef<HTMLDivElement>(null);
  const [copiedSource, setCopiedSource] = useState(false);
  const [copiedTranslation, setCopiedTranslation] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [segments, setSegments] = useState<AlignedSegment[] | null>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // aligned 模式最终走了"整段译文当单段"的降级路径 → UI 明示，不静默丢对照结构
  const [usedFallback, setUsedFallback] = useState(false);
  // 可折叠：头部常显，正文经 .chat-collapse 过渡
  const [collapsed, setCollapsed] = useState(false);

  const [srcLang, setSrcLang] = useState('auto');
  const [tgtLang, setTgtLang] = useState('zh-CN');
  const [settings, setSettings] = useState<ResolvedTranslationSettings>({
    modelId: '',
    modelDisplayName: '',
    mode: 'aligned',
  });

  // 取消与竞态控制
  const reqIdRef = useRef(0);
  const activeStreamEventRef = useRef<string | null>(null);
  const activeUnlistenRef = useRef<UnlistenFn | null>(null);
  // 流式超时兜底
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 复制成功反馈定时器（卸载时清理，避免卸载后 setState）
  const copiedSourceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTranslationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current !== null) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  // 取消当前正在进行的请求（如果有）
  const cancelActiveStream = useCallback(async () => {
    clearStallTimer();
    const eventName = activeStreamEventRef.current;
    activeStreamEventRef.current = null;
    if (activeUnlistenRef.current) {
      try {
        activeUnlistenRef.current();
      } catch {
        /* ignore */
      }
      activeUnlistenRef.current = null;
    }
    if (eventName) {
      try {
        await invoke('cancel_stream', { streamEventName: eventName });
      } catch {
        /* 后端可能已经结束，忽略 */
      }
    }
  }, [clearStallTimer]);

  // 核心：发起一次翻译
  const doTranslate = useCallback(
    async (params: {
      src: string;
      tgt: string;
      mode: TranslationDisplayMode;
      modelId: string;
    }) => {
      const myId = ++reqIdRef.current;
      // 取消上一次（如果还在跑）
      await cancelActiveStream();
      if (myId !== reqIdRef.current) return; // 已被更新的请求顶替

      // 缓存命中
      try {
        const key = await buildCacheKey({
          mode: params.mode,
          modelId: params.modelId,
          srcLang: params.src,
          tgtLang: params.tgt,
          source: sourceText,
          contextBefore,
          contextAfter,
        });
        const cached = readCache(key);
        if (cached && myId === reqIdRef.current) {
          setError(null);
          setIsLoading(false);
          setUsedFallback(false);
          if (cached.mode === 'aligned') {
            setSegments(cached.segments);
            setStreamingText('');
          } else {
            setStreamingText(cached.text);
            setSegments(null);
          }
          return;
        }
      } catch {
        /* hash 失败时跳过缓存逻辑 */
      }

      // 发起 streaming 请求
      setIsLoading(true);
      setError(null);
      setSegments(null);
      setStreamingText('');
      setHoveredIndex(null);
      setUsedFallback(false);

      const requestId = nanoid();
      const eventName = `chat_translation_${requestId}`;
      activeStreamEventRef.current = eventName;

      const ndjsonParser = params.mode === 'aligned' ? createNdjsonParser() : null;
      let alignedSegments: AlignedSegment[] = [];
      let streamingAccumulated = ''; // 前端自行拼接的全量文本（新协议只收 delta）
      // 错误单通道：事件通道已给出友好错误后，invoke 拒绝值不再覆盖
      let sawTerminalEvent = false;

      // rAF 批处理：每帧至多一次 setState，避免高频 chunk 打爆渲染
      let pendingFrame: number | null = null;
      const cancelPendingFrame = () => {
        if (pendingFrame !== null) {
          cancelAnimationFrame(pendingFrame);
          pendingFrame = null;
        }
      };
      const scheduleUiFlush = () => {
        if (pendingFrame !== null) return;
        pendingFrame = requestAnimationFrame(() => {
          pendingFrame = null;
          if (myId !== reqIdRef.current) return;
          if (params.mode === 'aligned') {
            setSegments(alignedSegments.slice());
          } else {
            setStreamingText(streamingAccumulated);
          }
        });
      };

      // 流式兜底超时：每个 chunk 重置；到点视为失败（取消后端流 + 报错可重试）
      const armStallTimer = () => {
        if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
        stallTimerRef.current = setTimeout(() => {
          stallTimerRef.current = null;
          if (myId !== reqIdRef.current) return;
          sawTerminalEvent = true;
          cancelPendingFrame();
          void cancelActiveStream();
          setSegments(null);
          setStreamingText('');
          setUsedFallback(false);
          setError(t('translation:chat_popover.timeout'));
          setIsLoading(false);
        }, STREAM_STALL_TIMEOUT_MS);
      };

      const teardownListener = () => {
        if (activeUnlistenRef.current) {
          try {
            activeUnlistenRef.current();
          } catch {
            /* ignore */
          }
          activeUnlistenRef.current = null;
        }
        activeStreamEventRef.current = null;
      };

      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<ChatTranslationEventPayload>(eventName, (event) => {
          if (myId !== reqIdRef.current) return;
          const payload = event.payload;
          switch (payload.type) {
            case 'chunk': {
              armStallTimer();
              // 新协议：优先增量 delta；旧协议（无 delta 字段）退回全量 accumulated 差分
              let delta = '';
              if (typeof payload.delta === 'string' && payload.delta.length > 0) {
                delta = payload.delta;
              } else if (typeof payload.accumulated === 'string') {
                delta = payload.accumulated.slice(streamingAccumulated.length);
              }
              if (!delta) break;
              streamingAccumulated += delta;
              if (params.mode === 'aligned' && ndjsonParser) {
                const { segments: newSegs } = ndjsonParser.push(delta);
                if (newSegs.length > 0) {
                  alignedSegments = [...alignedSegments, ...newSegs];
                  scheduleUiFlush();
                }
              } else {
                scheduleUiFlush();
              }
              // 注意：不在此处解除 loading —— 完成语义以整体 complete 事件为准
              break;
            }
            case 'complete': {
              clearStallTimer();
              cancelPendingFrame();
              sawTerminalEvent = true;
              if (params.mode === 'aligned' && ndjsonParser) {
                const tail = ndjsonParser.flush();
                if (tail.segments.length > 0) {
                  alignedSegments = [...alignedSegments, ...tail.segments];
                }
                let degraded = false;
                if (alignedSegments.length === 0) {
                  // 模型完全没遵守 NDJSON 格式 — 兜底：先尝试整体解析
                  //（对象边界扫描 + 旧 {"segments":[...]} 格式），
                  // 再把纯流式累加文本当成单段（并向用户明示降级）
                  const fallback = parseAlignedFallback(streamingAccumulated);
                  if (fallback && fallback.length > 0) {
                    alignedSegments = fallback;
                  } else if (streamingAccumulated.trim()) {
                    alignedSegments = [{ src: sourceText, tgt: streamingAccumulated }];
                    degraded = true;
                  }
                }
                if (alignedSegments.length > 0) {
                  setSegments(alignedSegments.slice());
                  setUsedFallback(degraded);
                  // 写入缓存（空结果不缓存，避免缓存命中后永远空白）
                  const segmentsToCache = alignedSegments;
                  buildCacheKey({
                    mode: 'aligned',
                    modelId: params.modelId,
                    srcLang: params.src,
                    tgtLang: params.tgt,
                    source: sourceText,
                    contextBefore,
                    contextAfter,
                  })
                    .then((key) => writeCache(key, { mode: 'aligned', segments: segmentsToCache }))
                    .catch(() => {});
                } else {
                  setError(t('translation:popover.empty_result'));
                }
              } else if (streamingAccumulated.trim()) {
                setStreamingText(streamingAccumulated);
                buildCacheKey({
                  mode: 'streaming',
                  modelId: params.modelId,
                  srcLang: params.src,
                  tgtLang: params.tgt,
                  source: sourceText,
                  contextBefore,
                  contextAfter,
                })
                  .then((key) => writeCache(key, { mode: 'streaming', text: streamingAccumulated }))
                  .catch(() => {});
              } else {
                setError(t('translation:popover.empty_result'));
              }
              setIsLoading(false);
              teardownListener();
              break;
            }
            case 'error': {
              clearStallTimer();
              cancelPendingFrame();
              sawTerminalEvent = true;
              // 状态机干净：出错时不保留半成品对照/译文
              setSegments(null);
              setStreamingText('');
              setUsedFallback(false);
              setError(payload.message || t('translation:popover.unknown_error'));
              setIsLoading(false);
              teardownListener();
              break;
            }
            case 'cancelled': {
              clearStallTimer();
              cancelPendingFrame();
              sawTerminalEvent = true;
              setIsLoading(false);
              teardownListener();
              break;
            }
          }
        });
        // 等待 listen 期间可能已被新请求顶替：此时不能覆盖新请求的监听器，
        // 也不能再发起后端 invoke（否则产生无人消费、无法取消的孤儿流）
        if (myId !== reqIdRef.current) {
          try {
            unlisten();
          } catch {
            /* ignore */
          }
          return;
        }
        activeUnlistenRef.current = unlisten;
      } catch (err) {
        if (myId === reqIdRef.current) {
          setError(toErrorMessage(err, t('translation:popover.unknown_error')));
          setIsLoading(false);
        }
        // 只清理仍属于本次请求的事件名，避免误伤已顶替的新请求
        if (activeStreamEventRef.current === eventName) {
          activeStreamEventRef.current = null;
        }
        return;
      }

      // 发起 invoke（命令名按 mode 选择；后端 prompts 不同）
      const command =
        params.mode === 'aligned'
          ? 'stream_chat_translation_aligned'
          : 'stream_chat_translation_plain';

      const request: ChatTranslationRequestPayload = {
        request_id: requestId,
        source: sourceText,
        src_lang: params.src,
        tgt_lang: params.tgt,
        context_before: contextBefore || null,
        context_after: contextAfter || null,
      };

      armStallTimer();
      try {
        await invoke(command, { request });
      } catch (err) {
        cancelPendingFrame();
        if (myId === reqIdRef.current) {
          clearStallTimer();
          if (!sawTerminalEvent) {
            // 事件通道未给出错误时才由 invoke 拒绝值兜底；
            // 若事件错误已先到，以先到的可读错误为准，不被序列化串覆盖
            const friendly = toErrorMessage(err, t('translation:popover.unknown_error'));
            setError((prev) => prev ?? friendly);
            setIsLoading(false);
          }
          // 只有仍是当前请求时才动共享 refs，避免误清已顶替的新请求的监听器
          teardownListener();
        }
      }
    },
    [sourceText, contextBefore, contextAfter, cancelActiveStream, clearStallTimer, t]
  );

  // 自动触发：卡片打开 + 拿到 settings 后开译
  useEffect(() => {
    if (!isVisible || !sourceText) return;

    let cancelled = false;
    (async () => {
      const resolved = await loadTranslationSettings();
      if (cancelled) return;
      setSettings(resolved);

      const detectedSrc = detectSourceLang(sourceText);
      const defaultTgt = getDefaultTargetLang(detectedSrc);
      setSrcLang(detectedSrc);
      setTgtLang(defaultTgt);

      doTranslate({
        src: detectedSrc,
        tgt: defaultTgt,
        mode: resolved.mode,
        modelId: resolved.modelId,
      });
    })();

    return () => {
      cancelled = true;
    };
    // 依赖 isVisible/sourceText：每次重新打开都重新跑（不依赖 doTranslate 引用变更）
  }, [isVisible, sourceText]);

  // 关闭时清理：取消请求 + 清空状态
  useEffect(() => {
    if (!isVisible) {
      reqIdRef.current++;
      cancelActiveStream();
      setSegments(null);
      setStreamingText('');
      setError(null);
      setIsLoading(false);
      setCopiedSource(false);
      setCopiedTranslation(false);
      setHoveredIndex(null);
      setUsedFallback(false);
      setCollapsed(false);
    }
  }, [isVisible, cancelActiveStream]);

  // 卸载时彻底清理（避免内存泄漏 / 卸载后 setState）
  useEffect(() => {
    return () => {
      reqIdRef.current++;
      cancelActiveStream();
      if (copiedSourceTimerRef.current) clearTimeout(copiedSourceTimerRef.current);
      if (copiedTranslationTimerRef.current) clearTimeout(copiedTranslationTimerRef.current);
    };
  }, [cancelActiveStream]);

  // ===== 焦点管理：打开时聚焦卡片（读屏/键盘可达） =====
  useEffect(() => {
    if (!isVisible) return;
    const raf = requestAnimationFrame(() => {
      rootRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [isVisible]);

  // Escape 关闭（仅当焦点在卡片内：内联卡片不劫持全局键盘）
  const handleRootKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  // ===== 语言切换 =====

  const handleSrcLangChange = useCallback(
    (value: string) => {
      setSrcLang(value);
      doTranslate({ src: value, tgt: tgtLang, mode: settings.mode, modelId: settings.modelId });
    },
    [tgtLang, settings.mode, settings.modelId, doTranslate]
  );

  const handleTgtLangChange = useCallback(
    (value: string) => {
      setTgtLang(value);
      doTranslate({ src: srcLang, tgt: value, mode: settings.mode, modelId: settings.modelId });
    },
    [srcLang, settings.mode, settings.modelId, doTranslate]
  );

  const handleSwapLanguages = useCallback(() => {
    if (srcLang === 'auto') return;
    const nextSrc = tgtLang;
    const nextTgt = srcLang;
    setSrcLang(nextSrc);
    setTgtLang(nextTgt);
    doTranslate({ src: nextSrc, tgt: nextTgt, mode: settings.mode, modelId: settings.modelId });
  }, [srcLang, tgtLang, settings.mode, settings.modelId, doTranslate]);

  // ===== 派生内容 =====

  // 完整原文文本（aligned 模式优先用拼接的分段以与译文对齐；否则回退到 sourceText）
  const fullSource = useMemo(() => {
    if (segments && segments.length > 0) {
      const joined = segments.map((s) => s.src).join('');
      if (joined) return joined;
    }
    return sourceText;
  }, [segments, sourceText]);

  // 完整译文文本（统一两种模式）
  const fullTranslation = useMemo(() => {
    if (segments) return segments.map((s) => s.tgt).join('');
    return streamingText;
  }, [segments, streamingText]);

  const handleCopySource = useCallback(async () => {
    if (!fullSource) return;
    try {
      await copyTextToClipboard(fullSource);
    } catch (err) {
      console.error('[TranslationPopover] Copy source failed:', err);
      return;
    }
    setCopiedSource(true);
    if (copiedSourceTimerRef.current) clearTimeout(copiedSourceTimerRef.current);
    copiedSourceTimerRef.current = setTimeout(() => setCopiedSource(false), 1500);
  }, [fullSource]);

  const handleCopyTranslation = useCallback(async () => {
    if (!fullTranslation) return;
    try {
      await copyTextToClipboard(fullTranslation);
    } catch (err) {
      console.error('[TranslationPopover] Copy translation failed:', err);
      return;
    }
    setCopiedTranslation(true);
    if (copiedTranslationTimerRef.current) clearTimeout(copiedTranslationTimerRef.current);
    copiedTranslationTimerRef.current = setTimeout(() => setCopiedTranslation(false), 1500);
  }, [fullTranslation]);

  const handleAddToInput = useCallback(() => {
    if (!fullTranslation || !onAddToInput) return;
    onAddToInput(fullTranslation);
    onClose();
  }, [fullTranslation, onAddToInput, onClose]);

  const handleRetry = useCallback(() => {
    doTranslate({ src: srcLang, tgt: tgtLang, mode: settings.mode, modelId: settings.modelId });
  }, [srcLang, tgtLang, settings.mode, settings.modelId, doTranslate]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const srcOptions = SOURCE_LANGUAGES.map((l) => ({ value: l.code, label: t(l.label) }));
  const tgtOptions = TARGET_LANGUAGES.map((l) => ({ value: l.code, label: t(l.label) }));

  const hasContent =
    settings.mode === 'aligned' ? segments !== null && segments.length > 0 : streamingText.length > 0;

  const canSwap = srcLang !== 'auto';

  if (!isVisible) return null;

  return (
    <div
      ref={rootRef}
      data-translation-popover
      role="group"
      aria-label={t('chatV2:selectionToolbar.translate')}
      tabIndex={-1}
      onKeyDown={handleRootKeyDown}
      className={cn(
        'chat-msg-enter mt-2 w-full',
        'rounded-[var(--chat-radius-md,12px)] border border-border/50',
        'bg-muted/30',
        'outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
      )}
    >
      {/* 头部：语言选择（含对调） + 模型名（只读） + 折叠 + 关闭 */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1 min-w-0">
          <AppSelect
            value={srcLang}
            onValueChange={handleSrcLangChange}
            options={srcOptions}
            variant="ghost"
            size="sm"
            width={120}
            className="text-xs font-medium"
          />
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            disabled={!canSwap}
            onClick={handleSwapLanguages}
            aria-label={t('translation:chat_popover.swap_languages')}
            title={
              canSwap
                ? t('translation:chat_popover.swap_languages')
                : t('translation:chat_popover.cannot_swap_auto')
            }
            className="!h-6 !w-6 shrink-0 text-muted-foreground/60 hover:text-foreground"
          >
            <ArrowsLeftRight size={12} />
          </NotionButton>
          <AppSelect
            value={tgtLang}
            onValueChange={handleTgtLangChange}
            options={tgtOptions}
            variant="ghost"
            size="sm"
            width={120}
            className="text-xs font-medium"
          />
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          {settings.modelDisplayName && (
            <span
              className="text-xs text-muted-foreground/70 truncate max-w-[140px]"
              title={t('translation:popover.model_hint', { name: settings.modelDisplayName })}
            >
              {settings.modelDisplayName}
            </span>
          )}
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
            title={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
            // ★ 低-11：24px 视觉不变，触屏伪元素扩命中区到 ≥44px（与 ExplainPopover 一致）
            className="!h-6 !w-6 shrink-0 text-muted-foreground/50 hover:text-foreground relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']"
          >
            <CaretDown
              size={13}
              className={cn(
                'transition-transform duration-[var(--chat-motion-base,200ms)]',
                collapsed && '-rotate-90'
              )}
            />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onClose}
            aria-label={t('common:actions.close')}
            className="!h-6 !w-6 shrink-0 text-muted-foreground/50 hover:text-foreground relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']"
          >
            <X size={13} />
          </NotionButton>
        </div>
      </div>

      {/* 正文（可折叠） */}
      <div className="chat-collapse" data-open={collapsed ? 'false' : 'true'}>
        <div className={cn(collapsed && 'pointer-events-none')} aria-hidden={collapsed}>
          {/* 内容区 */}
          <div className="max-h-[min(360px,50vh)] overflow-y-auto border-t border-border/30">
            {error ? (
              <div className="flex items-center gap-2 px-3 py-3">
                <p className="text-xs text-destructive flex-1">{error}</p>
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={handleRetry}
                  aria-label={t('common:actions.retry')}
                  title={t('common:actions.retry')}
                  className="!h-6 !w-6 shrink-0"
                >
                  <ArrowsClockwise size={14} />
                </NotionButton>
              </div>
            ) : settings.mode === 'aligned' ? (
              segments && segments.length > 0 ? (
                <>
                  <div className="flex gap-0 mx-2 my-2 rounded-lg overflow-hidden border border-border/30">
                    {/* 左：原文分段 */}
                    <div className="flex-1 border-r border-border/30 px-1.5 py-1 text-sm leading-relaxed">
                      {segments.map((seg, i) => (
                        <span
                          key={`src-${i}`}
                          className={cn(
                            'chat-fade-in inline px-0.5 py-0.5 rounded-sm cursor-default transition-colors duration-150',
                            hoveredIndex === i && HIGHLIGHT_ACTIVE.bg,
                            hoveredIndex === i && HIGHLIGHT_ACTIVE.text
                          )}
                          onMouseEnter={() => setHoveredIndex(i)}
                          onMouseLeave={() => setHoveredIndex(null)}
                        >
                          {seg.src}
                        </span>
                      ))}
                    </div>
                    {/* 右：译文分段（逐段渐入） */}
                    <div className="flex-1 px-1.5 py-1 text-sm leading-relaxed">
                      {segments.map((seg, i) => (
                        <span
                          key={`tgt-${i}`}
                          className={cn(
                            'chat-fade-in inline px-0.5 py-0.5 rounded-sm cursor-default transition-colors duration-150',
                            hoveredIndex === i && HIGHLIGHT_ACTIVE.bg,
                            hoveredIndex === i && HIGHLIGHT_ACTIVE.text
                          )}
                          onMouseEnter={() => setHoveredIndex(i)}
                          onMouseLeave={() => setHoveredIndex(null)}
                        >
                          {seg.tgt}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* aligned 流式进行中：段计数进度（避免中段空白像卡死） */}
                  {isLoading && (
                    <div className="flex items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground">
                      <PulseDot className="h-1.5 w-1.5 text-primary/70" />
                      <span>
                        {t('translation:chat_popover.segments_progress', { n: segments.length })}
                      </span>
                    </div>
                  )}
                  {/* 降级明示：未拿到短语对照，展示的是整段译文 */}
                  {!isLoading && usedFallback && (
                    <div className="px-3 pb-2 text-xs text-muted-foreground/80">
                      {t('translation:chat_popover.fallback_notice')}
                    </div>
                  )}
                </>
              ) : isLoading ? (
                <TranslationLoading label={t('translation:popover.translating')} />
              ) : null
            ) : (
              // streaming 单栏
              streamingText ? (
                <div className="px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                  {streamingText}
                  {isLoading && (
                    <span
                      aria-hidden="true"
                      className="inline-block w-[2px] h-3.5 ml-0.5 bg-primary/60 align-middle animate-pulse motion-reduce:animate-none"
                    />
                  )}
                </div>
              ) : isLoading ? (
                <TranslationLoading label={t('translation:popover.translating')} />
              ) : null
            )}
          </div>

          {/* 底部操作栏：流式中可见但禁用（明确"翻译中"），完成后可交互 */}
          {hasContent && !error && (
            <div className="flex items-center gap-1 px-2.5 pb-2 border-t border-border/30 pt-1.5">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleCopySource}
                disabled={isLoading}
                title={isLoading ? t('translation:chat_popover.copy_streaming_hint') : undefined}
                className="gap-1.5 !px-2 text-xs"
              >
                <IconSwap
                  active={copiedSource}
                  a={<Copy size={13} />}
                  b={<Check size={13} className="text-success" />}
                />
                <span>
                  {copiedSource
                    ? t('translation:popover.copied')
                    : t('translation:popover.copy_source')}
                </span>
              </NotionButton>
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleCopyTranslation}
                disabled={isLoading}
                title={isLoading ? t('translation:chat_popover.copy_streaming_hint') : undefined}
                className="gap-1.5 !px-2 text-xs"
              >
                <IconSwap
                  active={copiedTranslation}
                  a={<Copy size={13} />}
                  b={<Check size={13} className="text-success" />}
                />
                <span>
                  {copiedTranslation
                    ? t('translation:popover.copied')
                    : t('translation:popover.copy_translation')}
                </span>
              </NotionButton>
              {onAddToInput && (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={handleAddToInput}
                  disabled={isLoading}
                  title={isLoading ? t('translation:chat_popover.add_streaming_hint') : undefined}
                  className="gap-1.5 !px-2 text-xs"
                >
                  <ChatDots size={13} />
                  <span>{t('chatV2:selectionToolbar.addToChat')}</span>
                </NotionButton>
              )}
              {isLoading && (
                <span className="ml-auto inline-flex items-center gap-1.5 pr-1 text-xs text-muted-foreground">
                  <PulseDot className="h-1.5 w-1.5 text-primary/70" />
                  {t('translation:chat_popover.streaming')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TranslationPopover;
