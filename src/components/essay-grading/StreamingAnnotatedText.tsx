/**
 * 流式批注文本渲染组件 - 简洁风格设计
 *
 * 交互模型（行内批注高亮）：
 * - hover 批注 → 轻量 Tooltip 提示（类型 + 简要说明）
 * - 点击批注 → 选中高亮，并在其所在段落下方展开内联批注详情卡
 *   （文档流内，非 portal / 浮层），再次点击或点其他批注收起/切换
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  parseStreamingContent,
  hasScoreMarker,
  type StreamingMarker,
  type StreamingParseResult,
} from '@/essay-grading/streamingMarkerParser';
import { ScoreCard } from './ScoreCard';
import {
  ArrowRight,
  CaretLeft,
  CaretRight,
  ChatCircleText,
  Check,
  Copy,
  Plus,
  Sparkle,
  Trash,
  Warning,
  ArrowsLeftRight,
  X,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface StreamingAnnotatedTextProps {
  text: string;
  isStreaming: boolean;
  className?: string;
  showScore?: boolean;
  markerFilter?: 'all' | 'errors' | 'suggestions' | 'highlights';
  /** 父组件已解析的结果，传入后跳过内部重复解析 */
  preParsedResult?: StreamingParseResult;
  /** 当前选中的批注（parseStreamingContent().markers 原始下标），受控 */
  activeMarkerIndex?: number | null;
  /** 批注选中回调；点击已选中批注传 null（收起） */
  onMarkerSelect?: (index: number | null) => void;
  /** 应用批注中的修改建议到输入区（replace/del 可用） */
  onApplySuggestion?: (change: { original: string; replacement: string }) => void;
}

type TFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * 获取错误类型的翻译键
 */
const getErrorTypeKey = (type?: string): string => {
  if (type) return `essay_grading:markers.error.${type}`;
  return 'essay_grading:markers.error.grammar';
};

const ANNOTATED_TYPES = new Set<StreamingMarker['type']>(['del', 'ins', 'replace', 'note', 'good', 'err']);
const isAnnotated = (type: StreamingMarker['type']) => ANNOTATED_TYPES.has(type);

/**
 * err 子类型中偏「建议」性质的类型（用词/表达/修辞），
 * 行内配色与筛选分组归入建议系而非错误系。
 * SentenceDetailView / GradingStreamRenderer 共用此判定保持三视图一致。
 */
export const ERR_SUGGESTION_TYPES: ReadonlySet<string> = new Set(['word_choice', 'expression', 'rhetoric']);

export const isSuggestionErr = (marker: StreamingMarker): boolean =>
  marker.type === 'err' && !!marker.errorType && ERR_SUGGESTION_TYPES.has(marker.errorType);

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * pending 片段的降级展示：剥掉已到达的标签头/闭合标签与末尾未完成的标签片段，
 * 只留正文文字，避免流式中原始 <del ...> 等协议文本闪现。
 */
function sanitizePendingText(raw: string): string {
  return raw
    .replace(/<\/?[a-zA-Z][a-zA-Z-]*(?:\s[^>]*)?>/g, '')
    .replace(/<\/?[a-zA-Z][a-zA-Z-]*(?:\s[^>]*)?$/, '')
    .replace(/<\/?$/, '');
}

// ---------------------------------------------------------------------------
// 已完成 marker 的引用稳定化：流式重解析时复用上一轮内容一致的对象，
// 配合 React.memo 避免已完成前缀在每个 chunk 到达时重复渲染/闪烁。
// ---------------------------------------------------------------------------

function markersEqual(a: StreamingMarker, b: StreamingMarker): boolean {
  return (
    a.type === b.type &&
    a.content === b.content &&
    a.isComplete === b.isComplete &&
    a.reason === b.reason &&
    a.oldText === b.oldText &&
    a.newText === b.newText &&
    a.comment === b.comment &&
    a.errorType === b.errorType &&
    a.explanation === b.explanation
  );
}

function useStableMarkers(markers: StreamingMarker[]): StreamingMarker[] {
  const prevRef = useRef<StreamingMarker[]>([]);
  return useMemo(() => {
    const prev = prevRef.current;
    let changed = markers.length !== prev.length;
    const next = markers.map((marker, i) => {
      if (i < prev.length && markersEqual(prev[i], marker)) return prev[i];
      changed = true;
      return marker;
    });
    const result = changed ? next : prev;
    prevRef.current = result;
    return result;
  }, [markers]);
}

// ---------------------------------------------------------------------------
// 行内批注 span（memo：已完成 marker 引用稳定时跳过重渲染）
// ---------------------------------------------------------------------------

interface MarkerSpanProps {
  marker: StreamingMarker;
  index: number;
  isActive: boolean;
  /** 流式期间新确认的批注淡入浮现（历史回看不触发） */
  animateIn: boolean;
  onSelect: (index: number | null) => void;
  t: TFn;
}

const TooltipBody: React.FC<{ title: React.ReactNode; description?: string; hint: string }> = ({ title, description, hint }) => (
  <div className="text-xs">
    <div className="font-medium mb-0.5">{title}</div>
    {description && <div className="text-muted-foreground leading-relaxed">{description}</div>}
    <div className="text-muted-foreground/60 mt-1">{hint}</div>
  </div>
);

const MarkerSpanImpl: React.FC<MarkerSpanProps> = ({ marker, index, isActive, animateIn, onSelect, t }) => {
  if (marker.type === 'text') {
    return <span>{marker.content}</span>;
  }
  if (marker.type === 'pending') {
    const visible = sanitizePendingText(marker.content);
    if (!visible) return null;
    return (
      <span className="text-muted-foreground/60 animate-pulse motion-reduce:animate-none">
        {visible}
      </span>
    );
  }

  const handleClick = () => onSelect(isActive ? null : index);
  const interactiveProps = {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': isActive,
    'data-marker-index': index,
    onClick: handleClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
  };
  const clickHint = t('essay_grading:annotation_card.click_hint');
  const baseInteractive = cn(
    'cursor-pointer rounded-sm transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
    animateIn && 'motion-safe:animate-chat-fade-in'
  );

  switch (marker.type) {
    case 'del':
      return (
        <CommonTooltip
          content={<TooltipBody title={<span className="text-red-500/90">{t('essay_grading:markers.delete')}</span>} description={marker.reason} hint={clickHint} />}
          position="top"
          maxWidth={320}
        >
          <span
            {...interactiveProps}
            className={cn(
              'inline text-red-600/80 dark:text-red-400/80',
              'line-through decoration-red-400/60 decoration-1',
              baseInteractive,
              isActive
                ? 'bg-red-100/80 dark:bg-red-900/40 ring-1 ring-red-400/60'
                : 'hover:bg-red-50/50 dark:hover:bg-red-950/30'
            )}
          >
            {marker.content}
          </span>
        </CommonTooltip>
      );

    case 'ins':
      return (
        <CommonTooltip
          content={<TooltipBody title={<span className="text-amber-500/90">{t('essay_grading:markers.insert')}</span>} hint={clickHint} />}
          position="top"
          maxWidth={320}
        >
          <span
            {...interactiveProps}
            className={cn(
              'inline text-amber-700 dark:text-amber-400',
              'underline decoration-amber-400/60 decoration-1 underline-offset-2',
              baseInteractive,
              isActive
                ? 'bg-amber-100/80 dark:bg-amber-900/40 ring-1 ring-amber-400/60'
                : 'hover:bg-amber-50/60 dark:hover:bg-amber-950/30'
            )}
          >
            {marker.content}
          </span>
        </CommonTooltip>
      );

    case 'replace':
      return (
        <CommonTooltip
          content={<TooltipBody title={<span className="text-amber-500/90">{t('essay_grading:markers.replace')}</span>} description={marker.reason} hint={clickHint} />}
          position="top"
          maxWidth={320}
        >
          <span
            {...interactiveProps}
            className={cn(
              'inline-flex items-baseline gap-1 px-0.5',
              baseInteractive,
              isActive
                ? 'bg-amber-100/80 dark:bg-amber-900/40 ring-1 ring-amber-400/60'
                : 'hover:bg-amber-50/60 dark:hover:bg-amber-950/30'
            )}
          >
            <span className="text-muted-foreground/70 line-through decoration-1">{marker.oldText}</span>
            <span className="text-muted-foreground/50 text-xs">→</span>
            <span className="text-amber-700 dark:text-amber-400 font-medium">{marker.newText}</span>
          </span>
        </CommonTooltip>
      );

    case 'note':
      return (
        <CommonTooltip
          content={<TooltipBody title={<span className="text-amber-500/90">{t('essay_grading:markers.note')}</span>} description={marker.comment} hint={clickHint} />}
          position="top"
          maxWidth={320}
        >
          <span
            {...interactiveProps}
            className={cn(
              'inline text-amber-700 dark:text-amber-400',
              'border-b border-dashed border-amber-400/70',
              baseInteractive,
              isActive
                ? 'bg-amber-100/80 dark:bg-amber-900/40 ring-1 ring-amber-400/60'
                : 'hover:bg-amber-50/60 dark:hover:bg-amber-950/30'
            )}
          >
            {marker.content}
          </span>
        </CommonTooltip>
      );

    case 'good':
      return (
        <CommonTooltip
          content={
            <TooltipBody
              title={
                <span className="inline-flex items-center gap-1 text-emerald-500/90">
                  <Sparkle size={12} weight="fill" />
                  {t('essay_grading:markers.good')}
                </span>
              }
              hint={clickHint}
            />
          }
          position="top"
          maxWidth={320}
        >
          <span
            {...interactiveProps}
            className={cn(
              'inline text-emerald-700 dark:text-emerald-300',
              'bg-emerald-100/50 dark:bg-emerald-400/10',
              'border-l-2 border-emerald-400/80 rounded-l-none rounded-r-sm pl-1 pr-0.5',
              baseInteractive,
              isActive
                ? 'bg-emerald-100 dark:bg-emerald-400/20 ring-1 ring-emerald-400/60'
                : 'hover:bg-emerald-100/80 dark:hover:bg-emerald-400/15'
            )}
          >
            {marker.content}
          </span>
        </CommonTooltip>
      );

    case 'err': {
      const asSuggestion = isSuggestionErr(marker);
      return (
        <CommonTooltip
          content={
            <TooltipBody
              title={
                <span className={asSuggestion ? 'text-amber-500/90' : 'text-red-500/90'}>
                  {t(getErrorTypeKey(marker.errorType))}
                </span>
              }
              description={marker.explanation}
              hint={clickHint}
            />
          }
          position="top"
          maxWidth={320}
        >
          <span
            {...interactiveProps}
            className={cn(
              'decoration-wavy underline underline-offset-4',
              baseInteractive,
              asSuggestion
                ? cn(
                    'inline text-amber-700 dark:text-amber-400 decoration-amber-400/60',
                    isActive
                      ? 'bg-amber-100/80 dark:bg-amber-900/40 ring-1 ring-amber-400/60'
                      : 'hover:bg-amber-50/60 dark:hover:bg-amber-950/30'
                  )
                : cn(
                    'inline text-red-600/90 dark:text-red-400/90 decoration-red-400/50',
                    isActive
                      ? 'bg-red-100/80 dark:bg-red-900/40 ring-1 ring-red-400/60'
                      : 'hover:bg-red-50/50 dark:hover:bg-red-950/30'
                  )
            )}
          >
            {marker.content}
          </span>
        </CommonTooltip>
      );
    }

    default:
      return <span>{marker.content}</span>;
  }
};

const MarkerSpan = React.memo(MarkerSpanImpl);

// ---------------------------------------------------------------------------
// 内联批注详情卡（文档流内，展开在批注所在段落下方）
// ---------------------------------------------------------------------------

const BADGE_ERROR_CLASS = 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800';
const BADGE_SUGGESTION_CLASS = 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800';
const BADGE_HIGHLIGHT_CLASS = 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';

const CARD_BADGES: Partial<Record<StreamingMarker['type'], { icon: Icon; i18nKey: string; className: string }>> = {
  del: { icon: Trash, i18nKey: 'essay_grading:markers.delete', className: BADGE_ERROR_CLASS },
  ins: { icon: Plus, i18nKey: 'essay_grading:markers.insert', className: BADGE_SUGGESTION_CLASS },
  replace: { icon: ArrowsLeftRight, i18nKey: 'essay_grading:markers.replace', className: BADGE_SUGGESTION_CLASS },
  note: { icon: ChatCircleText, i18nKey: 'essay_grading:markers.note', className: BADGE_SUGGESTION_CLASS },
  good: { icon: Sparkle, i18nKey: 'essay_grading:markers.good', className: BADGE_HIGHLIGHT_CLASS },
  err: { icon: Warning, i18nKey: 'essay_grading:markers.error.grammar', className: BADGE_ERROR_CLASS },
};

interface MarkerCardNav {
  position: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

const MarkerDetailCard: React.FC<{
  marker: StreamingMarker;
  t: TFn;
  nav?: MarkerCardNav;
  onApplySuggestion?: (change: { original: string; replacement: string }) => void;
}> = ({ marker, t, nav, onApplySuggestion }) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const suggestionText = marker.type === 'replace' ? marker.newText : marker.type === 'ins' ? marker.content : undefined;
  const originalText = marker.type === 'replace' ? marker.oldText : marker.type === 'ins' ? undefined : marker.content;
  const explanation = marker.explanation || marker.reason || marker.comment;

  // 可直接落到原文的修改：替换（old→new）与删除（content→空）
  const applyChange = marker.type === 'replace' && marker.oldText && marker.newText
    ? { original: marker.oldText, replacement: marker.newText }
    : marker.type === 'del' && marker.content
      ? { original: marker.content, replacement: '' }
      : null;

  const handleCopy = () => {
    if (!suggestionText) return;
    void copyTextToClipboard(suggestionText);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const badge = CARD_BADGES[marker.type];
  const badgeLabel = marker.type === 'err'
    ? t(getErrorTypeKey(marker.errorType))
    : badge
      ? t(badge.i18nKey)
      : '';
  const badgeClassName = isSuggestionErr(marker) ? BADGE_SUGGESTION_CLASS : badge?.className;
  const BadgeIcon = badge?.icon;

  return (
    <div className="mt-2 rounded-md border border-border/40 bg-card/60 px-3.5 py-3 text-sm">
      {/* 类型徽章 + 批注导航 */}
      {(badge && BadgeIcon) || nav ? (
        <div className="flex items-center gap-2 mb-2">
          {badge && BadgeIcon && (
            <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded border', badgeClassName)}>
              <BadgeIcon size={12} weight={marker.type === 'good' ? 'fill' : 'regular'} />
              {badgeLabel}
            </span>
          )}
          {nav && (
            <div className="ml-auto flex items-center gap-0.5">
              <span className="text-xs text-muted-foreground/50 tabular-nums mr-1">
                {nav.position}/{nav.total}
              </span>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                aria-label={t('essay_grading:result_ui.annotation_prev')}
                onClick={nav.onPrev}
                disabled={nav.total <= 1}
                className="!h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)]"
              >
                <CaretLeft size={11} />
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                aria-label={t('essay_grading:result_ui.annotation_next')}
                onClick={nav.onNext}
                disabled={nav.total <= 1}
                className="!h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)]"
              >
                <CaretRight size={11} />
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                aria-label={t('essay_grading:result_ui.annotation_close')}
                onClick={nav.onClose}
                className="!h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)]"
              >
                <X size={11} />
              </DsButton>
            </div>
          )}
        </div>
      ) : null}

      {/* 原文 → 建议 */}
      <div className="space-y-1.5">
        {originalText && (
          <div className="flex items-start gap-2">
            <span className="shrink-0 text-xs text-muted-foreground/50 mt-0.5 w-8">
              {t('essay_grading:annotation_card.original')}
            </span>
            <span
              className={cn(
                marker.type === 'del' && 'text-red-500/80 line-through',
                marker.type === 'replace' && 'text-muted-foreground/80 line-through',
                marker.type === 'err' && (isSuggestionErr(marker)
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-red-600/90 dark:text-red-400/90'),
                marker.type === 'good' && 'text-emerald-700 dark:text-emerald-300',
                marker.type === 'note' && 'text-foreground/85'
              )}
            >
              {originalText}
            </span>
          </div>
        )}
        {suggestionText && (
          <div className="flex items-start gap-2">
            <span className="shrink-0 text-xs text-muted-foreground/50 mt-0.5 w-8">
              {t('essay_grading:annotation_card.suggestion')}
            </span>
            <span className="inline-flex items-baseline gap-2 min-w-0">
              {marker.type === 'replace' && <ArrowRight size={12} className="shrink-0 self-center text-muted-foreground/40" />}
              <span className="font-medium text-amber-700 dark:text-amber-400">
                {suggestionText}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* 原因 / 解释 */}
      {explanation && (
        <div className="mt-2 rounded bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground/80 leading-relaxed">
          {explanation}
        </div>
      )}

      {/* 应用修改 / 复制建议 */}
      {(suggestionText || (applyChange && onApplySuggestion)) && (
        <div className="mt-2 flex items-center justify-end gap-1">
          {applyChange && onApplySuggestion && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => onApplySuggestion(applyChange)}
              className="!h-6 gap-1 px-2 text-xs text-primary/80 hover:text-primary hover:bg-primary/10"
            >
              <Check size={12} />
              {t('essay_grading:markers.apply')}
            </DsButton>
          )}
          {suggestionText && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="!h-6 gap-1 px-2 text-xs text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]"
            >
              {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              {copied ? t('essay_grading:annotation_card.copied') : t('essay_grading:annotation_card.copy_suggestion')}
            </DsButton>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 段落拆分：把扁平 marker 流按换行拆成段落块，便于把详情卡内联锚定在段落下方
// ---------------------------------------------------------------------------

interface RenderItem {
  key: string;
  marker: StreamingMarker;
  /** parseStreamingContent().markers 原始下标（跨组件的 marker 身份） */
  index: number;
}

interface ParagraphBlock {
  key: string;
  items: RenderItem[];
}

function buildParagraphs(markers: StreamingMarker[]): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let current: RenderItem[] = [];
  const flush = () => {
    if (current.length > 0) {
      blocks.push({ key: `p-${blocks.length}`, items: current });
      current = [];
    }
  };
  markers.forEach((marker, index) => {
    if (marker.type === 'text' || marker.type === 'pending') {
      const parts = marker.content.split(/\n+/);
      parts.forEach((part, segIdx) => {
        if (segIdx > 0) flush();
        if (!part) return;
        // 未拆分时复用原对象，保持 memo 引用稳定
        const segMarker = parts.length === 1 ? marker : { ...marker, content: part };
        current.push({ key: `${marker.type}-${index}-${segIdx}`, marker: segMarker, index });
      });
    } else {
      current.push({ key: `${marker.type}-${index}`, marker, index });
    }
  });
  flush();
  return blocks;
}

/**
 * 流式批注文本组件 - 简洁风格
 */
export const StreamingAnnotatedText: React.FC<StreamingAnnotatedTextProps> = ({
  text,
  isStreaming,
  className,
  showScore = true,
  markerFilter,
  preParsedResult,
  activeMarkerIndex,
  onMarkerSelect,
  onApplySuggestion,
}) => {
  const { t } = useTranslation(['essay_grading']);

  const internalParseResult = useMemo(
    () => preParsedResult ? null : parseStreamingContent(text, !isStreaming),
    [text, isStreaming, preParsedResult]
  );

  const { markers: rawMarkers, score } = preParsedResult ?? internalParseResult!;
  const markers = useStableMarkers(rawMarkers);

  // 未受控时退化为内部选中态（组件独立使用时交互仍可用）
  const [internalActive, setInternalActive] = useState<number | null>(null);
  const activeIndex = activeMarkerIndex !== undefined ? activeMarkerIndex : internalActive;
  const handleSelect = useCallback((index: number | null) => {
    if (onMarkerSelect) {
      onMarkerSelect(index);
    } else {
      setInternalActive(index);
    }
  }, [onMarkerSelect]);

  // A6-30: 文本含 <score> 标签但解析失败（畸形标签）且流已结束时，给一条降级提示，
  // 避免评分区静默缺失。无 score 标签的作文不触发。
  const scoreParseFailed = useMemo(
    () => showScore && !isStreaming && !score && hasScoreMarker(text),
    [showScore, isStreaming, score, text]
  );

  const filteredMarkers = useMemo(() => {
    if (!markerFilter || markerFilter === 'all') return markers;
    return markers.map(marker => {
      if (marker.type === 'text' || marker.type === 'pending') return marker;
      // 被筛选隐藏的批注退化为作文原文：replace 取 oldText（content 是 "old → new" 组合串）
      const plainContent = marker.type === 'replace'
        ? (marker.oldText ?? marker.content)
        : (marker.content || marker.oldText || '');
      // 与 SentenceDetailView.groupOfMarker 一致：偏建议的 err 子类型归入建议组
      const matchesFilter =
        markerFilter === 'errors'
          ? marker.type === 'del' || (marker.type === 'err' && !isSuggestionErr(marker))
          : markerFilter === 'suggestions'
            ? ['ins', 'replace', 'note'].includes(marker.type) || isSuggestionErr(marker)
            : marker.type === 'good';
      return matchesFilter ? marker : { ...marker, type: 'text' as const, content: plainContent };
    });
  }, [markers, markerFilter]);

  const paragraphs = useMemo(() => buildParagraphs(filteredMarkers), [filteredMarkers]);

  // 当前筛选视图下可见批注的原始下标序列（详情卡上一条/下一条导航用）
  const annotatedIndices = useMemo(() => {
    const list: number[] = [];
    filteredMarkers.forEach((marker, i) => {
      if (isAnnotated(marker.type)) list.push(i);
    });
    return list;
  }, [filteredMarkers]);

  // 收起动画期间保留最近一次选中的卡片内容（grid-rows 过渡需要内容仍在文档流中）
  const lastSelectedRef = useRef<number | null>(null);
  if (activeIndex != null) lastSelectedRef.current = activeIndex;
  const cardIndex = lastSelectedRef.current;
  const cardMarker = cardIndex != null && cardIndex < filteredMarkers.length && isAnnotated(filteredMarkers[cardIndex].type)
    ? filteredMarkers[cardIndex]
    : null;
  const isCardOpen = activeIndex != null && activeIndex === cardIndex && !!cardMarker;

  const cardNav = useMemo<MarkerCardNav | undefined>(() => {
    if (cardIndex == null) return undefined;
    const pos = annotatedIndices.indexOf(cardIndex);
    if (pos === -1) return undefined;
    const total = annotatedIndices.length;
    return {
      position: pos + 1,
      total,
      onPrev: () => handleSelect(annotatedIndices[(pos - 1 + total) % total]),
      onNext: () => handleSelect(annotatedIndices[(pos + 1) % total]),
      onClose: () => handleSelect(null),
    };
  }, [cardIndex, annotatedIndices, handleSelect]);

  // 选中批注（含通过卡片导航切换）时把行内批注滚动到可见区域
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeIndex == null) return;
    const el = rootRef.current?.querySelector(`[data-marker-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [activeIndex]);

  const streamingCursor = (
    <span className="inline-block w-0.5 h-[1.1em] bg-foreground/40 animate-pulse motion-reduce:animate-none ml-0.5 align-middle" />
  );

  return (
    <div ref={rootRef} className={cn('space-y-6', className)}>
      {/* 评分卡片 */}
      {showScore && score && <ScoreCard score={score} />}
      {scoreParseFailed && (
        <div className="px-4 py-3 rounded-lg border border-border/30 bg-muted/20 text-sm text-muted-foreground">
          {t('essay_grading:score.parse_failed')}
        </div>
      )}

      {/* 批注文本 - 段落化排版，详情卡内联锚定在所属段落下方 */}
      <div className="text-[15px] leading-[1.8] text-foreground/85 max-w-none space-y-3">
        {paragraphs.map((para, pi) => {
          const hasCard = cardMarker != null && para.items.some(item => item.index === cardIndex);
          return (
            <div key={para.key}>
              <div className="whitespace-pre-wrap">
                {para.items.map(item => (
                  <MarkerSpan
                    key={item.key}
                    marker={item.marker}
                    index={item.index}
                    isActive={activeIndex === item.index}
                    animateIn={isStreaming}
                    onSelect={handleSelect}
                    t={t}
                  />
                ))}
                {isStreaming && pi === paragraphs.length - 1 && streamingCursor}
              </div>
              {hasCard && (
                <div
                  className={cn(
                    'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
                    isCardOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <MarkerDetailCard marker={cardMarker!} t={t} nav={cardNav} onApplySuggestion={onApplySuggestion} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {isStreaming && paragraphs.length === 0 && <div>{streamingCursor}</div>}
      </div>
    </div>
  );
};

export default StreamingAnnotatedText;
