/**
 * TranslationPopover - 聊天里选中文字翻译的弹出卡片（SOTA 版）
 *
 * 当用户在 SelectionToolbar 点击"翻译"后，toolbar 消失，
 * 原位替换为此翻译卡片。
 *
 * 功能要点：
 * - 自动检测语言方向（中→英 / 其他→中），可手动切换
 * - 双显示模式（在系统设置 → 模型 中切换）：
 *   - aligned：短语对照，NDJSON 流式增量渲染，hover 同步高亮
 *   - streaming：纯译文单栏，token 流式涌入
 * - 模型来自系统设置的"翻译模型"（fallback 为对话模型 model2）
 * - 显示当前使用的模型名（只读 label，hover tooltip 提示去 settings 修改）
 * - 上下文消歧（前后各 200 字符传入 prompt，不参与翻译）
 * - LRU 缓存（同一段文字 + 同上下文 + 同模型 + 同语言对 = 即时命中）
 * - 取消语义：关闭弹窗 / 切换语言 / popover 卸载 都会取消尚未完成的请求
 *
 * 取消与竞态：
 * - 每次新发起的请求 reqIdRef 自增；旧回调通过 id 比对自我作废
 * - 调用 invoke('cancel_stream', { streamEventName }) 通知后端中止 SSE
 * - unlisten 移除 Tauri 事件监听
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, ChatDots, X, ArrowsClockwise, ArrowRight } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';
import { cn } from '@/utils/cn';
import { IconSwap } from '@/components/ui/IconSwap';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { AppSelect } from '@/components/ui/app-menu/AppSelect';
import { OverlayLayerProvider } from '@/components/shared/OverlayLayer';
import { Z_INDEX } from '@/config/zIndex';
import { useViewStore } from '@/stores/viewStore';
import type { ApiConfig, ModelAssignments } from '@/types';
import type { SelectionRect } from '../hooks/useTextSelection';
import type { AlignedSegment, TranslationDisplayMode } from './translationTypes';
import { createNdjsonParser, parseAlignedFallback } from './translationNdjsonParser';
import { buildCacheKey, readCache, writeCache } from './translationCache';

// ============================================================================
// 类型
// ============================================================================

export interface TranslationPopoverProps {
  /** 要翻译的原文 */
  sourceText: string;
  /** 选区位置（视口坐标） */
  selectionRect: SelectionRect | null;
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

// 后端事件 payload（与 chat_popover.rs 保持一致）
type ChatTranslationEvent =
  | { type: 'chunk'; delta: string; accumulated: string }
  | { type: 'complete' }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

// ============================================================================
// 常量
// ============================================================================

const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 12;

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
  if (isPrimarilyChinese(text)) return 'zh-CN';
  if (isPrimarilyJapanese(text)) return 'ja';
  if (isPrimarilyKorean(text)) return 'ko';
  return 'auto';
}

function getDefaultTargetLang(srcLang: string): string {
  return srcLang === 'zh-CN' ? 'en' : 'zh-CN';
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
// 加载动画
// ============================================================================

const TranslatingIndicator: React.FC<{ label?: string }> = ({ label }) => (
  <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block w-1.5 h-1.5 rounded-full bg-primary/50"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            delay: i * 0.15,
            ease: 'easeInOut',
          }}
        />
      ))}
    </span>
    <span>{label ?? '翻译中...'}</span>
  </div>
);

// ============================================================================
// 组件
// ============================================================================

export const TranslationPopover: React.FC<TranslationPopoverProps> = ({
  sourceText,
  selectionRect,
  isVisible,
  contextBefore = '',
  contextAfter = '',
  onClose,
  onAddToInput,
}) => {
  const { t } = useTranslation(['translation', 'chatV2']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [copiedSource, setCopiedSource] = useState(false);
  const [copiedTranslation, setCopiedTranslation] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [segments, setSegments] = useState<AlignedSegment[] | null>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number } | null>(null);

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

  // 取消当前正在进行的请求（如果有）
  const cancelActiveStream = useCallback(async () => {
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
  }, []);

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

      const requestId = nanoid();
      const eventName = `chat_translation_${requestId}`;
      activeStreamEventRef.current = eventName;

      const ndjsonParser = params.mode === 'aligned' ? createNdjsonParser() : null;
      let alignedSegments: AlignedSegment[] = [];
      let streamingAccumulated = ''; // 原始累积文本：plain 模式直接显示；aligned 模式做 fallback 解析

      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<ChatTranslationEvent>(eventName, (event) => {
          if (myId !== reqIdRef.current) return;
          const payload = event.payload;
          switch (payload.type) {
            case 'chunk': {
              streamingAccumulated = payload.accumulated;
              if (params.mode === 'aligned' && ndjsonParser) {
                const { segments: newSegs } = ndjsonParser.push(payload.delta);
                if (newSegs.length > 0) {
                  alignedSegments = [...alignedSegments, ...newSegs];
                  setSegments(alignedSegments.slice());
                  setIsLoading(false);
                }
              } else {
                setStreamingText(streamingAccumulated);
                setIsLoading(false);
              }
              break;
            }
            case 'complete': {
              if (myId !== reqIdRef.current) return;
              if (params.mode === 'aligned' && ndjsonParser) {
                const tail = ndjsonParser.flush();
                if (tail.segments.length > 0) {
                  alignedSegments = [...alignedSegments, ...tail.segments];
                  setSegments(alignedSegments.slice());
                }
                if (alignedSegments.length === 0) {
                  // 模型完全没遵守 NDJSON 格式 — 兜底：把纯流式累加文本当成单段，
                  // 并尝试整体解析（处理 LLM 可能输出 {"segments":[...]} 的旧格式）
                  const fallback = parseAlignedFallback(streamingAccumulated);
                  if (fallback && fallback.length > 0) {
                    alignedSegments = fallback;
                    setSegments(alignedSegments.slice());
                  } else {
                    setSegments([{ src: sourceText, tgt: streamingAccumulated || '(empty)' }]);
                  }
                }
                // 写入缓存
                buildCacheKey({
                  mode: 'aligned',
                  modelId: params.modelId,
                  srcLang: params.src,
                  tgtLang: params.tgt,
                  source: sourceText,
                  contextBefore,
                  contextAfter,
                })
                  .then((key) => writeCache(key, { mode: 'aligned', segments: alignedSegments }))
                  .catch(() => {});
              } else {
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
              }
              setIsLoading(false);
              if (activeUnlistenRef.current) {
                try {
                  activeUnlistenRef.current();
                } catch {
                  /* ignore */
                }
                activeUnlistenRef.current = null;
              }
              activeStreamEventRef.current = null;
              break;
            }
            case 'error': {
              if (myId !== reqIdRef.current) return;
              setError(payload.message || t('translation:popover.unknown_error', '翻译失败'));
              setIsLoading(false);
              if (activeUnlistenRef.current) {
                try {
                  activeUnlistenRef.current();
                } catch {
                  /* ignore */
                }
                activeUnlistenRef.current = null;
              }
              activeStreamEventRef.current = null;
              break;
            }
            case 'cancelled': {
              if (myId !== reqIdRef.current) return;
              setIsLoading(false);
              if (activeUnlistenRef.current) {
                try {
                  activeUnlistenRef.current();
                } catch {
                  /* ignore */
                }
                activeUnlistenRef.current = null;
              }
              activeStreamEventRef.current = null;
              break;
            }
          }
        });
        activeUnlistenRef.current = unlisten;
      } catch (err) {
        if (myId === reqIdRef.current) {
          setError(String(err));
          setIsLoading(false);
        }
        return;
      }

      // 发起 invoke（命令名按 mode 选择；后端 prompts 不同）
      const command =
        params.mode === 'aligned'
          ? 'stream_chat_translation_aligned'
          : 'stream_chat_translation_plain';

      try {
        await invoke(command, {
          request: {
            request_id: requestId,
            source: sourceText,
            src_lang: params.src,
            tgt_lang: params.tgt,
            context_before: contextBefore || null,
            context_after: contextAfter || null,
          },
        });
      } catch (err) {
        if (myId === reqIdRef.current) {
          setError(String(err));
          setIsLoading(false);
        }
        if (activeUnlistenRef.current) {
          try {
            activeUnlistenRef.current();
          } catch {
            /* ignore */
          }
          activeUnlistenRef.current = null;
        }
        activeStreamEventRef.current = null;
      }
    },
    [sourceText, contextBefore, contextAfter, cancelActiveStream, t]
  );

  // 自动触发：popover 打开 + 拿到 settings 后开译
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

  // 关闭/卸载时清理：取消请求 + 清空状态
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
      setFixedPosition(null);
    }
  }, [isVisible, cancelActiveStream]);

  // 卸载时彻底清理（避免内存泄漏）
  useEffect(() => {
    return () => {
      reqIdRef.current++;
      cancelActiveStream();
    };
  }, [cancelActiveStream]);

  // 全局视图切换离开 chat-v2 时，强制关闭弹窗
  const currentView = useViewStore((s) => s.currentView);
  useEffect(() => {
    if (isVisible && currentView !== 'chat-v2') {
      onClose();
    }
  }, [isVisible, currentView, onClose]);

  // 打开时固定位置（只计算一次）
  useEffect(() => {
    if (isVisible && selectionRect && !fixedPosition) {
      const popoverWidth = 520;
      const popoverHeight = 180;

      let top = selectionRect.top - popoverHeight - POPOVER_GAP;
      if (top < VIEWPORT_PADDING) {
        top = selectionRect.bottom + POPOVER_GAP;
      }

      let left = selectionRect.left + selectionRect.width / 2 - popoverWidth / 2;
      const maxLeft = window.innerWidth - popoverWidth - VIEWPORT_PADDING;
      left = Math.max(VIEWPORT_PADDING, Math.min(left, maxLeft));

      setFixedPosition({ top, left });
    }
  }, [isVisible, selectionRect, fixedPosition]);

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

  // Escape 关闭
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, onClose]);

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
    await copyTextToClipboard(fullSource);
    setCopiedSource(true);
    setTimeout(() => setCopiedSource(false), 1500);
  }, [fullSource]);

  const handleCopyTranslation = useCallback(async () => {
    if (!fullTranslation) return;
    await copyTextToClipboard(fullTranslation);
    setCopiedTranslation(true);
    setTimeout(() => setCopiedTranslation(false), 1500);
  }, [fullTranslation]);

  const handleAddToInput = useCallback(() => {
    if (!fullTranslation || !onAddToInput) return;
    onAddToInput(fullTranslation);
    onClose();
  }, [fullTranslation, onAddToInput, onClose]);

  const handleRetry = useCallback(() => {
    doTranslate({ src: srcLang, tgt: tgtLang, mode: settings.mode, modelId: settings.modelId });
  }, [srcLang, tgtLang, settings.mode, settings.modelId, doTranslate]);

  const srcOptions = SOURCE_LANGUAGES.map((l) => ({ value: l.code, label: t(l.label) }));
  const tgtOptions = TARGET_LANGUAGES.map((l) => ({ value: l.code, label: t(l.label) }));

  const hasContent =
    settings.mode === 'aligned' ? segments !== null && segments.length > 0 : streamingText.length > 0;

  return createPortal(
    <AnimatePresence>
      {isVisible && selectionRect && (
        // OverlayLayerProvider：声明 popover 是 Z_INDEX.popover 档；其内部任何使用
        // useNestedOverlayZ() 的下拉/菜单（如 AppSelect 的语言列表）会自动抬升一档，
        // 不再需要在调用点手写 z-index。
        <OverlayLayerProvider baseZ={Z_INDEX.popover}>
          <motion.div
            ref={popoverRef}
            data-translation-popover
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className={cn(
              'fixed w-[520px] max-w-[calc(100vw-24px)]',
              'rounded-2xl border border-border/50',
              'bg-popover/80 backdrop-blur-xl backdrop-saturate-150',
              'shadow-lg ring-1 ring-border/40',
              'overflow-hidden'
            )}
            style={{ top: fixedPosition?.top ?? 0, left: fixedPosition?.left ?? 0, zIndex: Z_INDEX.popover }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {/* 头部：语言选择 + 模型名（只读） + 关闭 */}
            <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5 border-b border-border/30">
              <div className="flex items-center gap-1.5 min-w-0">
                <AppSelect
                  value={srcLang}
                  onValueChange={handleSrcLangChange}
                  options={srcOptions}
                  variant="ghost"
                  size="sm"
                  width={120}
                  className="text-xs font-medium"
                />
                <ArrowRight size={11} className="text-muted-foreground/50 shrink-0" />
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
                  className="text-[10.5px] text-muted-foreground/70 truncate max-w-[140px]"
                  title={t(
                    'translation:popover.model_hint',
                    '当前翻译模型（在系统设置 → 模型 中修改）：{{name}}',
                    { name: settings.modelDisplayName }
                  )}
                >
                  {settings.modelDisplayName}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-md hover:bg-accent/60 text-muted-foreground/50 hover:text-foreground transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* 内容区 */}
          <div className="max-h-[280px] overflow-y-auto">
            {error ? (
              <div className="flex items-center gap-2 px-3 py-3">
                <p className="text-xs text-destructive flex-1">{error}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="shrink-0 p-1 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowsClockwise size={14} />
                </button>
              </div>
            ) : settings.mode === 'aligned' ? (
              segments && segments.length > 0 ? (
                <div className="flex gap-0 mx-2 my-2 rounded-lg overflow-hidden border border-border/30">
                  {/* 左：原文分段 */}
                  <div className="flex-1 border-r border-border/30">
                    {segments.map((seg, i) => (
                      <span
                        key={`src-${i}`}
                        className={cn(
                          'inline px-0.5 py-0.5 rounded-sm cursor-default transition-colors duration-150',
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
                  {/* 右：译文分段 */}
                  <div className="flex-1">
                    {segments.map((seg, i) => (
                      <span
                        key={`tgt-${i}`}
                        className={cn(
                          'inline px-0.5 py-0.5 rounded-sm cursor-default transition-colors duration-150',
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
              ) : isLoading ? (
                <TranslatingIndicator label={t('translation:popover.translating', '翻译中...')} />
              ) : null
            ) : (
              // streaming 单栏
              streamingText ? (
                <div className="px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                  {streamingText}
                  {isLoading && (
                    <motion.span
                      className="inline-block w-[2px] h-3.5 ml-0.5 bg-primary/60 align-middle"
                      animate={{ opacity: [1, 0.2, 1] }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                    />
                  )}
                </div>
              ) : isLoading ? (
                <TranslatingIndicator label={t('translation:popover.translating', '翻译中...')} />
              ) : null
            )}
          </div>

          {/* 底部操作栏 */}
          {hasContent && !isLoading && !error && (
            <div className="flex items-center gap-1 px-2.5 pb-2 border-t border-border/30 pt-1.5">
              <ActionButton
                onClick={handleCopySource}
                icon={
                  <IconSwap
                    active={copiedSource}
                    a={<Copy size={13} />}
                    b={<Check size={13} className="text-green-500" />}
                  />
                }
                label={
                  copiedSource
                    ? t('translation:popover.copied', '已复制')
                    : t('translation:popover.copy_source', '复制原文')
                }
              />
              <ActionButton
                onClick={handleCopyTranslation}
                icon={
                  <IconSwap
                    active={copiedTranslation}
                    a={<Copy size={13} />}
                    b={<Check size={13} className="text-green-500" />}
                  />
                }
                label={
                  copiedTranslation
                    ? t('translation:popover.copied', '已复制')
                    : t('translation:popover.copy_translation', '复制译文')
                }
              />
              {onAddToInput && (
                <ActionButton
                  onClick={handleAddToInput}
                  icon={<ChatDots size={13} />}
                  label={t('chatV2:selectionToolbar.addToChat', '添加到聊天')}
                />
              )}
            </div>
          )}
          </motion.div>
        </OverlayLayerProvider>
      )}
    </AnimatePresence>,
    document.body
  );
};

// ============================================================================
// 子组件
// ============================================================================

interface ActionButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({ onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'flex items-center gap-1.5 px-2 py-1 rounded-md',
      'text-xs text-muted-foreground',
      'hover:bg-accent/60 hover:text-foreground',
      'transition-colors duration-100'
    )}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export default TranslationPopover;
