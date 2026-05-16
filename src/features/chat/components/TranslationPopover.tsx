/**
 * TranslationPopover - 轻量翻译弹出卡片（词组对齐版）
 *
 * 当用户在 SelectionToolbar 点击"翻译"后，toolbar 消失，
 * 原位替换为此翻译卡片。
 *
 * 交互：
 * - 自动检测语言方向（中→英 / 其他→中），可手动切换
 * - 左右对照：按词组/短语分段对齐，hover 时双侧高亮
 * - 语言方向标签（可选择）
 * - 提供：复制、添加到聊天输入框 操作
 * - 点击外部或 Escape 关闭
 *
 * 实现：
 * - 使用 call_llm_for_boundary 获取结构化 JSON（分段对齐）
 * - 非流式（等完整结果后渲染）
 * - 复用项目毛玻璃卡片风格 + AppSelect + Z_INDEX.popover
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check, ChatDots, X, ArrowsClockwise, ArrowRight } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/utils/cn';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { AppSelect } from '@/components/ui/app-menu/AppSelect';
import { Z_INDEX } from '@/config/zIndex';
import type { SelectionRect } from '../hooks/useTextSelection';

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
  /** 关闭回调 */
  onClose: () => void;
  /** 添加到聊天输入框回调（不发送） */
  onAddToInput?: (text: string) => void;
}

/** 对齐分段 */
interface AlignedSegment {
  src: string;
  tgt: string;
}

// ============================================================================
// 常量
// ============================================================================

const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 12;

/** 语言列表 */
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

const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter(l => l.code !== 'auto');

/** 语言全称映射（用于 prompt） */
const LANG_FULL_NAMES: Record<string, string> = {
  'auto': 'the source language (auto-detect)',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'en': 'English',
  'ja': 'Japanese',
  'ko': 'Korean',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'ru': 'Russian',
  'pt': 'Portuguese',
  'it': 'Italian',
  'vi': 'Vietnamese',
  'th': 'Thai',
};

/** Hover 高亮：固定语义色 */
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
// Prompt 构建
// ============================================================================

function buildAlignedTranslationPrompt(text: string, srcLang: string, tgtLang: string): string {
  const srcName = LANG_FULL_NAMES[srcLang] || srcLang;
  const tgtName = LANG_FULL_NAMES[tgtLang] || tgtLang;

  return `You are a professional translator. Translate the following text from ${srcName} to ${tgtName}.

Return ONLY a JSON object with a "segments" array. Each segment pairs a source phrase with its translation. Break the text into natural phrase-level chunks (noun phrases, verb phrases, clauses) — not word-by-word, not sentence-by-sentence. Aim for 3-8 segments depending on text length.

Rules:
- Every character of the source text must appear in exactly one segment's "src" field
- Concatenating all "src" fields must reproduce the original text exactly (including spaces/punctuation)
- Each "tgt" field is the natural translation of its corresponding "src"
- Do NOT add explanations, notes, or markdown — output pure JSON only

Example output format:
{"segments":[{"src":"改革开放","tgt":"Reform and Opening Up"},{"src":"是1978年开始的","tgt":"began in 1978"}]}

Text to translate:
${text}`;
}

/** 解析 LLM 返回的 JSON */
function parseSegments(raw: string): AlignedSegment[] | null {
  try {
    // 尝试直接解析
    const parsed = JSON.parse(raw);
    if (parsed.segments && Array.isArray(parsed.segments)) {
      return parsed.segments;
    }
  } catch {
    // 尝试从 markdown code block 中提取
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (parsed.segments && Array.isArray(parsed.segments)) {
          return parsed.segments;
        }
      } catch { /* ignore */ }
    }
    // 尝试找到第一个 { 到最后一个 }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (parsed.segments && Array.isArray(parsed.segments)) {
          return parsed.segments;
        }
      } catch { /* ignore */ }
    }
  }
  return null;
}

// ============================================================================
// 加载动画
// ============================================================================

const TranslatingIndicator: React.FC = () => (
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
    <span>翻译中...</span>
  </div>
);

// ============================================================================
// 组件
// ============================================================================

export const TranslationPopover: React.FC<TranslationPopoverProps> = ({
  sourceText,
  selectionRect,
  isVisible,
  onClose,
  onAddToInput,
}) => {
  const { t } = useTranslation(['translation', 'chatV2']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [segments, setSegments] = useState<AlignedSegment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const abortRef = useRef(false);

  // 固定位置：打开时计算一次，之后不再变动
  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number } | null>(null);

  // 语言选择状态
  const [srcLang, setSrcLang] = useState('auto');
  const [tgtLang, setTgtLang] = useState('zh-CN');

  // 执行翻译
  const doTranslate = useCallback(async (src: string, tgt: string) => {
    abortRef.current = false;
    setIsLoading(true);
    setError(null);
    setSegments(null);
    setHoveredIndex(null);

    const prompt = buildAlignedTranslationPrompt(sourceText, src, tgt);

    try {
      const result = await invoke<{ assistant_message: string; input_tokens: number; output_tokens: number }>(
        'call_llm_for_boundary',
        { prompt }
      );

      if (abortRef.current) return;

      const parsed = parseSegments(result.assistant_message);
      if (parsed && parsed.length > 0) {
        setSegments(parsed);
      } else {
        // 解析失败，回退为单段显示
        setSegments([{ src: sourceText, tgt: result.assistant_message }]);
      }
    } catch (err) {
      if (abortRef.current) return;
      setError(String(err));
    } finally {
      if (!abortRef.current) setIsLoading(false);
    }
  }, [sourceText]);

  // 自动触发翻译
  useEffect(() => {
    if (!isVisible || !sourceText || segments || isLoading) return;

    const detectedSrc = detectSourceLang(sourceText);
    const defaultTgt = getDefaultTargetLang(detectedSrc);
    setSrcLang(detectedSrc);
    setTgtLang(defaultTgt);

    doTranslate(detectedSrc, defaultTgt);
  }, [isVisible, sourceText, segments, isLoading, doTranslate]);

  // 关闭时重置
  useEffect(() => {
    if (!isVisible) {
      abortRef.current = true;
      setSegments(null);
      setError(null);
      setIsLoading(false);
      setCopied(false);
      setHoveredIndex(null);
      setFixedPosition(null);
    }
  }, [isVisible]);

  // 打开时固定位置（只计算一次）
  useEffect(() => {
    if (isVisible && selectionRect && !fixedPosition) {
      const popoverWidth = 520;
      const popoverHeight = 180;

      // 默认在选区上方（不遮挡下方未读内容）
      let top = selectionRect.top - popoverHeight - POPOVER_GAP;

      // 上方空间不足时翻转到下方
      if (top < VIEWPORT_PADDING) {
        top = selectionRect.bottom + POPOVER_GAP;
      }

      let left = selectionRect.left + selectionRect.width / 2 - popoverWidth / 2;
      const maxLeft = window.innerWidth - popoverWidth - VIEWPORT_PADDING;
      left = Math.max(VIEWPORT_PADDING, Math.min(left, maxLeft));

      setFixedPosition({ top, left });
    }
  }, [isVisible, selectionRect, fixedPosition]);

  // 手动切换语言后重新翻译
  const handleSrcLangChange = useCallback((value: string) => {
    setSrcLang(value);
    doTranslate(value, tgtLang);
  }, [tgtLang, doTranslate]);

  const handleTgtLangChange = useCallback((value: string) => {
    setTgtLang(value);
    doTranslate(srcLang, value);
  }, [srcLang, doTranslate]);

  // Escape 关闭
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isVisible, onClose]);

  // 复制完整译文
  const handleCopy = useCallback(async () => {
    if (!segments) return;
    const fullTranslation = segments.map(s => s.tgt).join('');
    await copyTextToClipboard(fullTranslation);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [segments]);

  // 添加到聊天输入框
  const handleAddToInput = useCallback(() => {
    if (!segments || !onAddToInput) return;
    const fullTranslation = segments.map(s => s.tgt).join('');
    onAddToInput(fullTranslation);
    onClose();
  }, [segments, onAddToInput, onClose]);

  // 重试
  const handleRetry = useCallback(() => {
    doTranslate(srcLang, tgtLang);
  }, [srcLang, tgtLang, doTranslate]);

  // 语言选项
  const srcOptions = SOURCE_LANGUAGES.map(l => ({ value: l.code, label: t(l.label) }));
  const tgtOptions = TARGET_LANGUAGES.map(l => ({ value: l.code, label: t(l.label) }));

  return createPortal(
    <AnimatePresence>
      {isVisible && selectionRect && (
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
            'overflow-hidden',
          )}
          style={{ top: fixedPosition?.top ?? 0, left: fixedPosition?.left ?? 0, zIndex: Z_INDEX.popover }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* 头部：语言选择 + 关闭按钮 */}
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-border/30">
            <div className="flex items-center gap-1.5">
              <AppSelect
                value={srcLang}
                onValueChange={handleSrcLangChange}
                options={srcOptions}
                variant="ghost"
                size="sm"
                width={90}
                className="text-xs font-medium"
              />
              <ArrowRight size={11} className="text-muted-foreground/50 shrink-0" />
              <AppSelect
                value={tgtLang}
                onValueChange={handleTgtLangChange}
                options={tgtOptions}
                variant="ghost"
                size="sm"
                width={90}
                className="text-xs font-medium"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md hover:bg-accent/60 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          {/* 内容区域 */}
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
            ) : isLoading ? (
              <TranslatingIndicator />
            ) : segments ? (
              <div className="flex gap-0 mx-2 my-2 rounded-lg overflow-hidden border border-border/30">
                {/* 左侧：原文分段 */}
                <div className="flex-1 border-r border-border/30">
                  {segments.map((seg, i) => (
                    <span
                      key={`src-${i}`}
                      className={cn(
                        'inline px-0.5 py-0.5 rounded-sm cursor-default transition-colors duration-150',
                        hoveredIndex === i && HIGHLIGHT_ACTIVE.bg,
                        hoveredIndex === i && HIGHLIGHT_ACTIVE.text,
                      )}
                      onMouseEnter={() => setHoveredIndex(i)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    >
                      {seg.src}
                    </span>
                  ))}
                </div>

                {/* 右侧：译文分段 */}
                <div className="flex-1">
                  {segments.map((seg, i) => (
                    <span
                      key={`tgt-${i}`}
                      className={cn(
                        'inline px-0.5 py-0.5 rounded-sm cursor-default transition-colors duration-150',
                        hoveredIndex === i && HIGHLIGHT_ACTIVE.bg,
                        hoveredIndex === i && HIGHLIGHT_ACTIVE.text,
                      )}
                      onMouseEnter={() => setHoveredIndex(i)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    >
                      {seg.tgt}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* 底部操作栏 */}
          {segments && !isLoading && (
            <div className="flex items-center gap-1 px-2.5 pb-2 border-t border-border/30 pt-1.5">
              <ActionButton
                onClick={handleCopy}
                icon={copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                label={copied ? t('chatV2:selectionToolbar.copied', '已复制') : t('chatV2:selectionToolbar.copy', '复制')}
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
      'transition-colors duration-100',
    )}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export default TranslationPopover;
