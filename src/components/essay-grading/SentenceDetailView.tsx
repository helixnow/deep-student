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
import { Warning, ArrowRight, Trash, Pen, Sparkle, Copy, Check, ListChecks } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface SentenceDetailViewProps {
  markers: StreamingMarker[];
  className?: string;
  /** 当前选中标注的原始下标（markers 数组下标），null 表示无选中 */
  activeMarkerIndex?: number | null;
  /** 选中/取消选中标注（传原始下标，取消传 null） */
  onMarkerSelect?: (index: number | null) => void;
  markerIndexOffset?: never;
}

/** 语义色徽章 — 与行内批注色系一致：错误 destructive、建议 primary、亮点 warning/amber */
const BADGE_DESTRUCTIVE = 'bg-destructive/10 text-destructive border-destructive/20';
const BADGE_PRIMARY = 'bg-primary/10 text-primary border-primary/20';
const BADGE_HIGHLIGHT = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';

/** err 子类型全部归入错误色系（destructive），含解析器新增的中文类型 */
const ERROR_TYPES_AS_SUGGESTION = new Set(['word_choice', 'expression', 'rhetoric']);

const getErrBadgeStyle = (errorType?: string): string =>
  errorType && ERROR_TYPES_AS_SUGGESTION.has(errorType) ? BADGE_PRIMARY : BADGE_DESTRUCTIVE;

/** 非 err 标记类型 → badge 配置 */
const MARKER_BADGE_CONFIG: Partial<Record<StreamingMarker['type'], { icon: Icon; i18nKey: string; style: string }>> = {
  del: { icon: Trash, i18nKey: 'essay_grading:markers.delete', style: BADGE_DESTRUCTIVE },
  replace: { icon: Pen, i18nKey: 'essay_grading:markers.replace', style: BADGE_PRIMARY },
  ins: { icon: Sparkle, i18nKey: 'essay_grading:markers.insert', style: BADGE_PRIMARY },
  note: { icon: Warning, i18nKey: 'essay_grading:markers.note', style: BADGE_PRIMARY },
  good: { icon: Sparkle, i18nKey: 'essay_grading:markers.good', style: BADGE_HIGHLIGHT },
};

type GroupId = 'errors' | 'suggestions' | 'highlights';

const GROUP_OF_TYPE: Partial<Record<StreamingMarker['type'], GroupId>> = {
  del: 'errors',
  err: 'errors',
  replace: 'suggestions',
  ins: 'suggestions',
  note: 'suggestions',
  good: 'highlights',
};

const GROUP_ORDER: GroupId[] = ['errors', 'suggestions', 'highlights'];

const GROUP_DOT_CLASS: Record<GroupId, string> = {
  errors: 'bg-destructive',
  suggestions: 'bg-primary',
  highlights: 'bg-amber-500',
};

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

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyTextToClipboard(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <NotionButton
      variant="ghost"
      size="sm"
      aria-label={copied ? copiedLabel : label}
      onClick={handleCopy}
      className={cn(
        'h-6 px-1.5 ml-auto shrink-0 gap-1 text-xs transition-colors duration-200 motion-reduce:transition-none',
        copied
          ? 'text-success hover:text-success'
          : 'text-muted-foreground/50 hover:text-foreground'
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? copiedLabel : label}</span>
    </NotionButton>
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
        <div className="flex items-start gap-2 text-sm">
          <span className="text-red-500/80 line-through">{marker.oldText}</span>
          <ArrowRight size={16} className="text-muted-foreground/40 shrink-0 mt-0.5" />
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{marker.newText}</span>
          {marker.newText && (
            <InlineCopyButton text={marker.newText} label={copyLabel} copiedLabel={copiedLabel} />
          )}
        </div>
      );
    case 'del':
      return <div className="text-sm text-red-500/80 line-through">{marker.content}</div>;
    case 'ins':
      return (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-emerald-600 dark:text-emerald-400">{marker.content}</span>
          <InlineCopyButton text={marker.content} label={copyLabel} copiedLabel={copiedLabel} />
        </div>
      );
    case 'err':
      return (
        <div className="text-sm">
          <span className="text-red-500/80 underline decoration-wavy decoration-red-400/50 underline-offset-4">
            {marker.content}
          </span>
        </div>
      );
    case 'note':
      return (
        <div className="text-sm text-blue-600 dark:text-blue-400 border-b border-dashed border-blue-400/60 inline">
          {marker.content}
        </div>
      );
    case 'good':
      return (
        <div className="text-sm">
          <span className="text-amber-600 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/20 rounded-sm px-0.5">
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
}) => {
  const { t } = useTranslation(['essay_grading']);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const groupRefs = useRef(new Map<GroupId, HTMLDivElement>());

  // 保留原始下标作为身份（跨代理契约），亮点（good）也纳入展示
  const grouped = useMemo(() => {
    const indexed: IndexedMarker[] = markers
      .map((marker, originalIndex) => ({ marker, originalIndex }))
      .filter(({ marker }) => marker.type !== 'text' && marker.type !== 'pending');

    const byGroup = new Map<GroupId, IndexedMarker[]>();
    for (const item of indexed) {
      const group = GROUP_OF_TYPE[item.marker.type];
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
    cardRefs.current.get(activeMarkerIndex)?.scrollIntoView({ block: 'nearest' });
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
                'transition-colors duration-150 motion-reduce:transition-none'
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full', GROUP_DOT_CLASS[group])} />
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
              <span className={cn('w-1.5 h-1.5 rounded-full', GROUP_DOT_CLASS[group])} />
              <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                {t(`essay_grading:legend.filter_${group}`)}
              </span>
              <span className="text-xs text-muted-foreground/40 tabular-nums">{items.length}</span>
            </div>

            {items.map(({ marker, originalIndex }) => {
              displayNumber += 1;
              const isActive = activeMarkerIndex === originalIndex;
              const number = displayNumber;
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
                    'rounded-xl border bg-card/50 overflow-hidden scroll-mt-12',
                    'transition-[box-shadow,border-color,background-color] duration-150 motion-reduce:transition-none',
                    isActive
                      ? 'ring-1 ring-primary bg-primary/5 border-primary/30'
                      : 'border-border/40',
                    onMarkerSelect && !isActive && 'cursor-pointer hover:border-border/70',
                    onMarkerSelect && isActive && 'cursor-pointer'
                  )}
                >
                  {/* 卡片头部：序号 + 分类标签 */}
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-border/20 bg-muted/10">
                    <span className="text-xs text-muted-foreground/50 font-mono tabular-nums w-5">
                      {number}
                    </span>
                    {marker.type === 'err' ? (
                      <span className={cn(
                        'px-2 py-0.5 text-xs font-medium rounded border',
                        getErrBadgeStyle(marker.errorType)
                      )}>
                        {t(`essay_grading:markers.error.${marker.errorType ?? 'grammar'}`, {
                          defaultValue: marker.errorType ?? 'grammar',
                        })}
                      </span>
                    ) : MARKER_BADGE_CONFIG[marker.type] ? (() => {
                      const cfg = MARKER_BADGE_CONFIG[marker.type]!;
                      const BadgeIcon = cfg.icon;
                      return (
                        <span className={cn('flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded border', cfg.style)}>
                          <BadgeIcon size={12} />
                          {t(cfg.i18nKey)}
                        </span>
                      );
                    })() : null}
                  </div>

                  {/* 卡片内容 */}
                  <div className="px-4 py-3 space-y-2">
                    <MarkerContent marker={marker} />

                    {/* 详细解释 */}
                    {(marker.explanation || marker.reason || marker.comment) && (
                      <div className="text-xs text-muted-foreground/70 leading-relaxed bg-muted/20 rounded px-3 py-2 mt-1">
                        {marker.explanation || marker.reason || marker.comment}
                      </div>
                    )}
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
