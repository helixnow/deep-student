/**
 * 逐句详解视图 — 将行内标注展开为卡片式详解
 * 每个错误/替换/删除/亮点标注显示：分类标签 + 原文 → 修改 + 详细解释
 *
 * 交互契约（与 GradingStreamRenderer 联动）：
 * - marker 身份 = 完整 markers 数组的原始下标
 * - 点击卡片 onMarkerSelect(原始下标)，再次点击取消（null）
 * - activeMarkerIndex 匹配时卡片高亮并 scrollIntoView({ block: 'nearest' })
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { StreamingMarker } from '@/essay-grading/streamingMarkerParser';
import { buildSuggestionChange, type SuggestionChange } from '@/essay-grading/suggestionAnchors';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { isSuggestionErr } from './StreamingAnnotatedText';
import {
  Warning,
  ArrowRight,
  Trash,
  Pen,
  Plus,
  Copy,
  Check,
  ListChecks,
  ArrowCounterClockwise,
  ChatCircleText,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor24 } from '@/components/ui/coarseHit';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface SentenceDetailViewProps {
  markers: StreamingMarker[];
  className?: string;
  /** 当前选中标注的原始下标（markers 数组下标），null 表示无选中 */
  activeMarkerIndex?: number | null;
  /** 选中/取消选中标注（传原始下标，取消传 null） */
  onMarkerSelect?: (index: number | null) => void;
  /** 采纳单条修改建议（落回原文） */
  onApplySuggestion?: (change: SuggestionChange) => void;
  /** 撤销已采纳的单条修改建议 */
  onUndoSuggestion?: (change: SuggestionChange) => void;
  /** 当前轮已采纳建议的 key 集合 */
  appliedSuggestionKeys?: ReadonlySet<string>;
  markerIndexOffset?: never;
}

/** 语义色徽章 — 与行内批注色系一致：错误 destructive、建议 warning、亮点 success */
const BADGE_ERROR = 'bg-destructive/10 text-destructive border-destructive/20';
const BADGE_SUGGESTION = 'bg-warning/10 text-warning border-warning/20';
const BADGE_HIGHLIGHT = 'bg-success/10 text-success border-success/20';

const getErrBadgeStyle = (marker: StreamingMarker): string =>
  isSuggestionErr(marker) ? BADGE_SUGGESTION : BADGE_ERROR;

/** 非 err 标记类型 → badge 配置 */
const MARKER_BADGE_CONFIG: Partial<Record<StreamingMarker['type'], { icon: Icon; i18nKey: string; style: string }>> = {
  del: { icon: Trash, i18nKey: 'essay_grading:markers.delete', style: BADGE_ERROR },
  replace: { icon: Pen, i18nKey: 'essay_grading:markers.replace', style: BADGE_SUGGESTION },
  ins: { icon: Plus, i18nKey: 'essay_grading:markers.insert', style: BADGE_SUGGESTION },
  note: { icon: Warning, i18nKey: 'essay_grading:markers.note', style: BADGE_SUGGESTION },
  good: { icon: Check, i18nKey: 'essay_grading:markers.good', style: BADGE_HIGHLIGHT },
};

type GroupId = 'errors' | 'suggestions' | 'highlights';

/** 与 StreamingAnnotatedText 筛选语义一致：偏建议的 err 子类型归入建议组 */
const groupOfMarker = (marker: StreamingMarker): GroupId | null => {
  switch (marker.type) {
    case 'del':
      return 'errors';
    case 'err':
      return isSuggestionErr(marker) ? 'suggestions' : 'errors';
    case 'replace':
    case 'ins':
    case 'note':
      return 'suggestions';
    case 'good':
      return 'highlights';
    default:
      return null;
  }
};

const GROUP_ORDER: GroupId[] = ['errors', 'suggestions', 'highlights'];

interface IndexedMarker {
  marker: StreamingMarker;
  /** markers 数组的原始下标（跨代理身份契约） */
  originalIndex: number;
}

/** 常显复制按钮 + 就地"已复制"反馈 */
const InlineCopyButton: React.FC<{ text: string; label: string; copiedLabel: string }> = ({
  text,
  label,
  copiedLabel,
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyTextToClipboard(text);
      if (!mountedRef.current) return;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (error: unknown) {
      showGlobalNotification('error', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <DsButton
      variant="ghost"
      size="sm"
      aria-label={copied ? copiedLabel : label}
      onClick={(e) => { void handleCopy(e); }}
      className={cn(
        coarseHitClassFor24,
        'h-6 px-1.5 ml-auto shrink-0 gap-1 text-xs transition-colors duration-200 motion-reduce:transition-none',
        copied
          ? 'text-success hover:text-success'
          : 'text-muted-foreground/50 hover:text-foreground'
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? copiedLabel : label}</span>
    </DsButton>
  );
};

/** 渲染标记卡片的内容区 */
const MarkerContent: React.FC<{ marker: StreamingMarker }> = ({ marker }) => {
  const { t } = useTranslation(['common', 'essay_grading']);
  const copyLabel = t('common:copy');
  const copiedLabel = t('essay_grading:sections.copied');

  switch (marker.type) {
    case 'replace':
      return (
        <div className="flex flex-wrap items-start gap-2 text-sm">
          <span className="max-w-full break-words text-destructive/80 line-through decoration-destructive/50 bg-destructive/[0.05] px-1 rounded-sm">{marker.oldText}</span>
          <ArrowRight size={15} className="text-muted-foreground/40 shrink-0 mt-0.5" />
          <span className="max-w-full break-words text-warning font-medium bg-warning/[0.08] px-1 rounded-sm">{marker.newText}</span>
          {marker.newText && (
            <InlineCopyButton text={marker.newText} label={copyLabel} copiedLabel={copiedLabel} />
          )}
        </div>
      );
    case 'del':
      return (
        <div className="text-sm break-words">
          <span className="text-destructive/80 line-through decoration-destructive/50 bg-destructive/[0.05] px-1 rounded-sm">{marker.content}</span>
        </div>
      );
    case 'ins':
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="max-w-full break-words text-warning bg-warning/[0.08] px-1 rounded-sm">{marker.content}</span>
          <InlineCopyButton text={marker.content} label={copyLabel} copiedLabel={copiedLabel} />
        </div>
      );
    case 'err':
      return (
        <div className="text-sm">
          <span
            className={cn(
              'underline decoration-wavy underline-offset-4',
              isSuggestionErr(marker)
                ? 'text-warning decoration-warning/60'
                : 'text-destructive/85 decoration-destructive/50'
            )}
          >
            {marker.content}
          </span>
        </div>
      );
    case 'note':
      return (
        <div className="text-sm text-warning border-b border-dashed border-warning/70 inline">
          {marker.content}
        </div>
      );
    case 'good':
      return (
        <div className="text-sm">
          <span className="text-success bg-success/[0.08] rounded-sm px-1">
            {marker.content}
          </span>
        </div>
      );
    default:
      return null;
  }
};

export const SentenceDetailView: React.FC<SentenceDetailViewProps> = ({
  markers,
  className,
  activeMarkerIndex,
  onMarkerSelect,
  onApplySuggestion,
  onUndoSuggestion,
  appliedSuggestionKeys,
}) => {
  const { t } = useTranslation(['essay_grading']);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const groupRefs = useRef(new Map<GroupId, HTMLDivElement>());

  // 保留原始下标作为身份（跨代理契约），过滤空标记（避免空亮点/空批注卡片）
  const grouped = useMemo(() => {
    const indexed: IndexedMarker[] = markers
      .map((marker, originalIndex) => ({ marker, originalIndex }))
      .filter(({ marker }) => {
        if (marker.type === 'text' || marker.type === 'pending') return false;
        if (marker.type === 'replace') {
          return Boolean(marker.oldText?.trim() || marker.newText?.trim());
        }
        return Boolean(marker.content?.trim());
      });

    const byGroup = new Map<GroupId, IndexedMarker[]>();
    for (const item of indexed) {
      const group = groupOfMarker(item.marker);
      if (!group) continue;
      const list = byGroup.get(group) ?? [];
      list.push(item);
      byGroup.set(group, list);
    }
    return { indexed, byGroup };
  }, [markers]);

  // 选中项变化时滚动到可见区域
  useEffect(() => {
    if (activeMarkerIndex == null) return;
    const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    cardRefs.current.get(activeMarkerIndex)?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [activeMarkerIndex]);

  if (grouped.indexed.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-16 gap-2 select-none', className)}>
        <ListChecks size={28} className="text-muted-foreground/30" />
        <div className="text-sm font-medium text-muted-foreground/70">
          {t('essay_grading:sections.no_corrections')}
        </div>
        <div className="text-xs text-muted-foreground/45">
          {t('essay_grading:sections.no_corrections_desc')}
        </div>
      </div>
    );
  }

  const scrollToGroup = (group: GroupId) => {
    groupRefs.current.get(group)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const handleCardClick = (originalIndex: number) => {
    if (!onMarkerSelect) return;
    onMarkerSelect(activeMarkerIndex === originalIndex ? null : originalIndex);
  };

  // 全局序号（跨分组连续）
  let displayNumber = 0;

  return (
    <div className={cn('space-y-4', className)}>
      {/* 分组摘要头：点击滚动定位 */}
      <div data-wb-blur-surface className="flex items-center gap-1.5 flex-wrap sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur-sm">
        {GROUP_ORDER.map((group) => {
          const items = grouped.byGroup.get(group);
          if (!items || items.length === 0) return null;
          return (
            <button
              key={group}
              type="button"
              onClick={() => scrollToGroup(group)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-border/40',
                'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]',
                'transition-colors duration-150 motion-reduce:transition-none',
                '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3'
              )}
            >
              <span>{t(`essay_grading:legend.filter_${group}`)}</span>
              <span className="tabular-nums font-medium">{items.length}</span>
            </button>
          );
        })}
      </div>

      {GROUP_ORDER.map((group) => {
        const items = grouped.byGroup.get(group);
        if (!items || items.length === 0) return null;
        return (
          <div
            key={group}
            ref={(el) => {
              if (el) groupRefs.current.set(group, el);
              else groupRefs.current.delete(group);
            }}
            className="space-y-2 scroll-mt-10"
          >
            {/* 分组标题 */}
            <div className="flex items-center gap-2 px-1 pt-1">
              <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                {t(`essay_grading:legend.filter_${group}`)}
              </span>
              <span className="text-xs text-muted-foreground/40 tabular-nums">{items.length}</span>
            </div>

            {items.map(({ marker, originalIndex }) => {
              displayNumber += 1;
              const isActive = activeMarkerIndex === originalIndex;
              const number = displayNumber;
              const applyChange = buildSuggestionChange(markers, originalIndex);
              const isApplied = Boolean(applyChange?.key && appliedSuggestionKeys?.has(applyChange.key));
              const originalText = marker.type === 'replace' ? marker.oldText : marker.content;
              const suggestionText =
                marker.type === 'replace'
                  ? marker.newText
                  : marker.type === 'err'
                    ? (marker.newText ?? applyChange?.replacement)
                    : undefined;
              const explanation = marker.explanation || marker.reason || marker.comment;
              const badgeLabel = marker.type === 'err'
                ? t(`essay_grading:markers.error.${marker.errorType ?? 'grammar'}`, {
                    defaultValue: marker.errorType ?? 'grammar',
                  })
                : MARKER_BADGE_CONFIG[marker.type]
                  ? t(MARKER_BADGE_CONFIG[marker.type]!.i18nKey)
                  : '';
              const handleAskAi = (e: React.MouseEvent) => {
                e.stopPropagation();
                const parts: string[] = [];
                if (badgeLabel) parts.push(`【${badgeLabel}】`);
                if (originalText) parts.push(`原文：「${originalText}」`);
                if (suggestionText) parts.push(`建议：「${suggestionText}」`);
                if (explanation) parts.push(`批注说明：${explanation}`);
                const prompt = t('essay_grading:annotation_card.ask_ai_prompt', {
                  context: parts.join('\n'),
                  defaultValue: `请帮我深入讲解这处作文批注，并给出 2 个地道替换例句：\n${parts.join('\n')}`,
                });
                dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
                  content: prompt,
                  autoSend: false,
                });
                dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'chat-v2' });
              };
              return (
                <div
                  key={originalIndex}
                  ref={(el) => {
                    if (el) cardRefs.current.set(originalIndex, el);
                    else cardRefs.current.delete(originalIndex);
                  }}
                  role={onMarkerSelect ? 'button' : undefined}
                  tabIndex={onMarkerSelect ? 0 : undefined}
                  aria-pressed={onMarkerSelect ? isActive : undefined}
                  onClick={() => handleCardClick(originalIndex)}
                  onKeyDown={(e) => {
                    if (onMarkerSelect && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      handleCardClick(originalIndex);
                    }
                  }}
                  className={cn(
                    'rounded-xl border bg-foreground/[0.015] overflow-hidden scroll-mt-12',
                    'transition-[box-shadow,border-color,background-color] duration-150 motion-reduce:transition-none',
                    isActive
                      ? 'ring-1 ring-primary/40 bg-primary/[0.05] border-primary/30'
                      : 'border-border/35',
                    onMarkerSelect && !isActive && 'cursor-pointer hover:bg-foreground/[0.03] hover:border-border/60',
                    onMarkerSelect && isActive && 'cursor-pointer'
                  )}
                >
                  {/* 卡片头部：序号 + 分类标签 */}
                  <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
                    <span className="text-xs text-muted-foreground/50 font-mono tabular-nums w-5">
                      {number}
                    </span>
                    {marker.type === 'err' ? (
                      <span className={cn(
                        'px-2 py-0.5 text-xs font-medium rounded border',
                        getErrBadgeStyle(marker)
                      )}>
                        {badgeLabel}
                      </span>
                    ) : MARKER_BADGE_CONFIG[marker.type] ? (() => {
                      const cfg = MARKER_BADGE_CONFIG[marker.type]!;
                      const BadgeIcon = cfg.icon;
                      return (
                        <span className={cn('flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded border', cfg.style)}>
                          <BadgeIcon size={12} />
                          {badgeLabel}
                        </span>
                      );
                    })() : null}
                  </div>

                  {/* 卡片内容 */}
                  <div className="px-4 pb-3 pt-1 space-y-2">
                    <MarkerContent marker={marker} />
                    {marker.type === 'err' && suggestionText && (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground/60">{t('essay_grading:annotation_card.suggestion')}</span>
                        <ArrowRight size={12} className="text-muted-foreground/40 shrink-0" />
                        <span className="font-medium text-warning bg-warning/[0.08] px-1.5 py-0.5 rounded-sm">
                          {suggestionText}
                        </span>
                      </div>
                    )}

                    {/* 详细解释 */}
                    {explanation && (
                      <div className="text-xs text-muted-foreground/75 leading-relaxed pt-1.5 border-t border-border/25">
                        {explanation}
                      </div>
                    )}

                    {/* 操作栏：与批注总览卡片保持一致（应用修改 / 已采纳 / 撤销 / 追问 AI） */}
                    <div
                      className="flex flex-wrap items-center justify-end gap-1 pt-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {applyChange && onApplySuggestion && (
                        isApplied ? (
                          <>
                            <span className="inline-flex items-center gap-1 px-2 text-xs text-success select-none">
                              <Check size={12} weight="bold" />
                              {t('essay_grading:markers.applied')}
                            </span>
                            {onUndoSuggestion && (
                              <DsButton
                                variant="ghost"
                                size="sm"
                                onClick={() => onUndoSuggestion(applyChange)}
                                className="!h-6 gap-1 px-2 text-xs text-muted-foreground/65 hover:text-foreground hover:bg-[var(--interactive-hover)]"
                              >
                                <ArrowCounterClockwise size={12} />
                                {t('essay_grading:markers.undo')}
                              </DsButton>
                            )}
                          </>
                        ) : (
                          <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={() => onApplySuggestion(applyChange)}
                            className="!h-6 gap-1 px-2 text-xs text-primary/85 hover:text-primary hover:bg-primary/10"
                          >
                            <Check size={12} />
                            {t('essay_grading:markers.apply')}
                          </DsButton>
                        )
                      )}
                      <DsButton
                        variant="ghost"
                        size="sm"
                        data-testid="annotation-ask-ai"
                        onClick={handleAskAi}
                        className="!h-6 gap-1 px-2 text-xs text-muted-foreground/70 hover:text-primary hover:bg-primary/10"
                      >
                        <ChatCircleText size={12} />
                        {t('essay_grading:annotation_card.ask_ai', { defaultValue: '追问 AI' })}
                      </DsButton>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
