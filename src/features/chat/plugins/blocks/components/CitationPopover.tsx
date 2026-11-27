/**
 * Chat V2 - 引用徽章与悬浮预览（Perplexity 式）
 *
 * - CitationBadge：正文中的 [N] 徽章
 * - CitationPopover：锚定在徽章上的轻量 portal 浮层
 *   （非 Dialog：无全屏 backdrop、无 aria-modal，Escape/点击外部/滚动关闭）
 * - CitationBadgeWithPopover：hover/focus 约 150ms 延迟出预览，
 *   点击徽章仍走 citationEvents 滚动高亮来源面板
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor24 } from '@/components/ui/coarseHit';
import {
  FileText,
  Globe,
  Brain,
  Image as ImageIcon,
  ArrowSquareOut,
  ArrowRight,
  Play,
  Lightbulb,
} from '@phosphor-icons/react';
import type { MediaTimeRange, RetrievalSource, RetrievalSourceType } from './types';
import { openUrl } from '@/utils/urlOpener';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { CitationSourceContext } from '../../../utils/citationSourceContext';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import {
  findFirstMediaRef,
  formatMediaRefTimestamp,
} from '@/features/learning-hub/apps/views/media/mediaRefTime';

// ============================================================================
// 精确引用定位解析（S1：P.N / mm:ss / 笔记 / 导图 / 本地文档）
// ============================================================================

export type CitationLocatorKind =
  | 'media'
  | 'page'
  | 'note'
  | 'mindmap'
  | 'markdown'
  | 'local'
  | 'web'
  | 'none';

export interface CitationLocatorInfo {
  kind: CitationLocatorKind;
  /** 1-based PDF 页码 */
  pageNumber: number | null;
  /** 音视频起播秒数 */
  mediaSeconds: number | null;
  /** 格式化后的 `mm:ss` / `h:mm:ss` */
  mediaTimestamp: string | null;
  sourceId: string | null;
  resourceType: string | null;
}

function isHttpLikeUrl(value?: string): boolean {
  return Boolean(value && (value.startsWith('http://') || value.startsWith('https://')));
}

function isValidTimeRange(value: unknown): value is MediaTimeRange {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.startMs === 'number' &&
    Number.isFinite(candidate.startMs) &&
    candidate.startMs >= 0
  );
}

/**
 * 从 RetrievalSource（含 metadata 或透传字段）解析精确来源定位信息。
 * 纯函数，便于单测验证。
 */
export function extractCitationLocator(source: RetrievalSource): CitationLocatorInfo {
  const meta = (source.metadata ?? {}) as Record<string, unknown>;
  const raw = source as RetrievalSource & Record<string, unknown>;

  const rawPageIndex =
    typeof meta.pageIndex === 'number'
      ? meta.pageIndex
      : typeof raw.pageIndex === 'number'
        ? raw.pageIndex
        : undefined;
  const pageNumber =
    typeof rawPageIndex === 'number' && Number.isFinite(rawPageIndex) && rawPageIndex >= 0
      ? Math.floor(rawPageIndex) + 1
      : null;

  const rawTimeRange = isValidTimeRange(meta.timeRange)
    ? meta.timeRange
    : isValidTimeRange(raw.timeRange)
      ? raw.timeRange
      : undefined;
  const rawMediaCitation =
    typeof meta.mediaCitation === 'string'
      ? meta.mediaCitation
      : typeof raw.mediaCitation === 'string'
        ? raw.mediaCitation
        : undefined;

  const parsedMediaRef = rawMediaCitation ? findFirstMediaRef([rawMediaCitation]) : null;
  const mediaSeconds = rawTimeRange
    ? Math.max(0, Math.floor(rawTimeRange.startMs / 1000))
    : parsedMediaRef
      ? parsedMediaRef.seconds
      : null;
  const mediaTimestamp = mediaSeconds !== null ? formatMediaRefTimestamp(mediaSeconds) : null;

  const sourceIdCandidate =
    (typeof meta.sourceId === 'string' && meta.sourceId) ||
    (typeof meta.source_id === 'string' && meta.source_id) ||
    (typeof raw.sourceId === 'string' && raw.sourceId) ||
    parsedMediaRef?.resourceId ||
    null;
  const resourceIdCandidate =
    (typeof meta.resourceId === 'string' && meta.resourceId) ||
    (typeof raw.resourceId === 'string' && raw.resourceId) ||
    null;
  const resourceType =
    (typeof meta.resourceType === 'string' && meta.resourceType) ||
    (typeof meta.resource_type === 'string' && meta.resource_type) ||
    (typeof raw.resourceType === 'string' && raw.resourceType) ||
    null;
  const pathCandidate =
    (typeof meta.path === 'string' && meta.path) ||
    (typeof raw.path === 'string' && raw.path) ||
    null;

  let kind: CitationLocatorKind = 'none';
  if (mediaSeconds !== null) {
    kind = 'media';
  } else if (pageNumber !== null) {
    kind = 'page';
  } else if (sourceIdCandidate?.startsWith('mm_') || resourceType === 'mindmap') {
    kind = 'mindmap';
  } else if (sourceIdCandidate?.startsWith('note_') || resourceType === 'note') {
    kind = 'note';
  } else if (
    (sourceIdCandidate || resourceIdCandidate || pathCandidate) &&
    !isHttpLikeUrl(source.url) &&
    (resourceType === 'markdown' || /\.(md|markdown)$/i.test(pathCandidate || source.title || ''))
  ) {
    kind = 'markdown';
  } else if ((sourceIdCandidate || resourceIdCandidate || pathCandidate) && !isHttpLikeUrl(source.url)) {
    kind = 'local';
  } else if (isHttpLikeUrl(source.url)) {
    kind = 'web';
  }

  return {
    kind,
    pageNumber,
    mediaSeconds,
    mediaTimestamp,
    sourceId: sourceIdCandidate,
    resourceType,
  };
}

// ============================================================================
// 图标映射
// ============================================================================

// ★ 2026-01 清理：移除 graph 图标（错题系统废弃）
const sourceTypeIcons: Record<RetrievalSourceType, typeof FileText> = {
  rag: FileText,
  memory: Brain,
  web_search: Globe,
  multimodal: ImageIcon,
  insight: Lightbulb,
};

// ============================================================================
// CitationPopover - 锚定浮层
// ============================================================================

const POPOVER_WIDTH = 320;
const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;

export interface CitationPopoverProps {
  /** 来源数据 */
  source: RetrievalSource;
  /** 锚点元素（徽章容器） */
  anchorEl: HTMLElement | null;
  /** 关闭回调（Escape / 点击外部 / 滚动） */
  onClose: () => void;
  /** 「查看来源」：与点击徽章同路径（citationEvents 滚动高亮面板） */
  onLocate?: () => void;
  /** hover 宽限：鼠标移入浮层时取消关闭计时 */
  onMouseEnter?: () => void;
  /** hover 宽限：鼠标移出浮层时重新计时关闭 */
  onMouseLeave?: () => void;
  /** 关闭动画进行中：保留挂载并播放 zoom-fade 离场 */
  exiting?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * CitationPopover - 引用来源预览浮层
 *
 * 功能：
 * 1. portal 到 body 的锚定浮层（自动上下翻转 + 水平钳制在视口内）
 * 2. 展示来源标题 / 类型 / score / snippet
 * 3. 点击卡片主体 → 定位来源面板；有 url 时提供「打开来源」
 * 4. Escape / 点击外部 / 页面滚动关闭；关闭时焦点归还锚点
 */
export const CitationPopover: React.FC<CitationPopoverProps> = ({
  source,
  anchorEl,
  onClose,
  onLocate,
  onMouseEnter,
  onMouseLeave,
  exiting = false,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const popRef = useRef<HTMLDivElement | null>(null);

  const Icon = sourceTypeIcons[source.type] || FileText;
  const hasUrl = !!source.url;
  const locator = extractCitationLocator(source);
  const hasLocalLocator =
    locator.kind === 'media' ||
    locator.kind === 'page' ||
    locator.kind === 'note' ||
    locator.kind === 'mindmap' ||
    locator.kind === 'markdown' ||
    locator.kind === 'local';
  const showJumpCta = Boolean(onLocate) && (hasLocalLocator || !hasUrl);
  const hasFooter = showJumpCta || hasUrl;

  const jumpCtaLabel = (() => {
    switch (locator.kind) {
      case 'media':
        return t('blocks.retrieval.seekToTimestamp', {
          time: locator.mediaTimestamp ?? '00:00',
          defaultValue: '跳转到 {{time}}',
        });
      case 'page':
        return t('blocks.retrieval.jumpToPage', {
          page: locator.pageNumber ?? 1,
          defaultValue: '跳转到第 {{page}} 页',
        });
      case 'note':
      case 'markdown':
        return t('blocks.retrieval.openNote', { defaultValue: '打开笔记' });
      case 'mindmap':
        return t('blocks.retrieval.openMindmap', { defaultValue: '定位导图' });
      default:
        return t('blocks.retrieval.locateSource', { defaultValue: '定位来源' });
    }
  })();

  const handleOpenUrl = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (source.url) {
        openUrl(source.url);
      }
    },
    [source.url],
  );

  const handleJumpClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onLocate?.();
    },
    [onLocate],
  );

  // 锚定定位：优先在锚点下方展开，放不下时翻到上方；水平居中并钳制在视口内
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop || !anchorEl) return;

    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const height = pop.offsetHeight;

    const fitsBelow = rect.bottom + POPOVER_GAP + height <= vh - VIEWPORT_MARGIN;
    const fitsAbove = rect.top - POPOVER_GAP - height >= VIEWPORT_MARGIN;
    const placeBelow = fitsBelow || !fitsAbove;

    const top = placeBelow
      ? Math.min(rect.bottom + POPOVER_GAP, vh - height - VIEWPORT_MARGIN)
      : rect.top - POPOVER_GAP - height;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - POPOVER_WIDTH / 2, VIEWPORT_MARGIN),
      Math.max(vw - POPOVER_WIDTH - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );

    pop.style.top = `${Math.max(top, VIEWPORT_MARGIN)}px`;
    pop.style.left = `${left}px`;
    // .ui-zoom-fade-in 的缩放原点朝向锚点，进场更自然
    pop.style.setProperty('--ui-zoom-origin', placeBelow ? 'top center' : 'bottom center');
    pop.style.visibility = 'visible';
  }, [anchorEl, source]);

  // Escape / 点击外部 / 滚动 关闭
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // 焦点在浮层内时归还给锚点内的徽章按钮
      if (popRef.current?.contains(document.activeElement)) {
        (anchorEl?.querySelector('button') as HTMLElement | null)?.focus();
      }
      onClose();
    };
    const handleScroll = (e: Event) => {
      // 浮层内部（snippet 区域）的滚动不应关闭浮层
      const target = e.target as Node | null;
      if (target && popRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [anchorEl, onClose]);

  // 📱 Android 系统返回键：浮层挂载即处于打开态，返回键先关浮层（overlay 级），
  // 避免穿透到底层导航。onClose 经 ref 读取，保持注册在整个挂载期稳定。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, []);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      ref={popRef}
      data-citation-popover="true"
      style={{
        position: 'fixed',
        width: POPOVER_WIDTH,
        // 首帧先隐藏，useLayoutEffect 定位后再显示，避免左上角闪现
        visibility: 'hidden',
        top: 0,
        left: 0,
      }}
      className={cn(
        'z-50 rounded-lg border border-border shadow-lg',
        'bg-popover text-popover-foreground',
        'ui-zoom-fade-in ui-zoom-fade-out',
        className,
      )}
      data-state={exiting ? 'closed' : 'open'}
      aria-hidden={exiting || undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 卡片主体：点击定位来源面板（与徽章点击同路径） */}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'block w-full text-left cursor-pointer rounded-t-lg',
          !hasFooter && 'rounded-b-lg',
          'transition-colors duration-150 motion-reduce:transition-none',
          'hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/40',
        )}
        onClick={() => onLocate?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onLocate?.();
          }
        }}
      >
        {/* 头部 */}
        <div className="flex items-start gap-2 p-3 border-b border-border/50">
          <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded bg-muted/50">
            <Icon size={16} className="text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-sm text-foreground line-clamp-2">
              {source.title}
            </h4>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span className="text-xs text-muted-foreground">
                {t(`citation.${source.type}`)}
              </span>
              {locator.kind === 'page' && locator.pageNumber !== null && (
                <span
                  data-citation-locator="page"
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium tabular-nums bg-primary/10 text-primary"
                >
                  P.{locator.pageNumber}
                </span>
              )}
              {locator.kind === 'media' && locator.mediaTimestamp !== null && (
                <span
                  data-citation-locator="media"
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium tabular-nums bg-primary/10 text-primary"
                >
                  <Play size={10} weight="fill" aria-hidden="true" />
                  <span>{locator.mediaTimestamp}</span>
                </span>
              )}
              {source.score !== undefined && (
                <span className="px-1.5 py-0.5 rounded text-xs bg-primary/10 text-primary">
                  {Math.round(source.score * 100)}%
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 内容区域（clamp 而非滚动，保持 hover 卡片轻量） */}
        <div className="p-3">
          <p className="text-sm text-muted-foreground leading-relaxed line-clamp-5">
            {source.snippet || t('blocks.retrieval.noSnippet')}
          </p>
        </div>
      </div>

      {/* 底部操作：显式跳页/寻址/打开笔记 CTA 或外链打开 */}
      {hasFooter && (
        <div className="flex items-center gap-1.5 p-2 border-t border-border/50">
          {showJumpCta && (
            <DsButton
              variant="ghost"
              size="sm"
              data-citation-jump-cta="true"
              onClick={handleJumpClick}
              className="flex-1 justify-center gap-1.5 text-primary hover:text-primary"
            >
              {locator.kind === 'media' ? (
                <Play size={13} weight="fill" aria-hidden="true" />
              ) : (
                <ArrowRight size={14} aria-hidden="true" />
              )}
              <span className="truncate">{jumpCtaLabel}</span>
            </DsButton>
          )}
          {hasUrl && (
            <DsButton
              variant="ghost"
              size="sm"
              onClick={handleOpenUrl}
              className={cn(showJumpCta ? 'shrink-0 px-2' : 'w-full')}
              title={showJumpCta ? t('blocks.retrieval.openSource') : undefined}
              aria-label={showJumpCta ? t('blocks.retrieval.openSource') : undefined}
            >
              <ArrowSquareOut size={14} />
              {!showJumpCta && <span className="truncate">{t('blocks.retrieval.openSource')}</span>}
            </DsButton>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
};

// ============================================================================
// 引用标记组件（用于内容中的引用标记）
// ============================================================================

export interface CitationBadgeProps {
  /** 引用序号 */
  index: number;
  /**
   * 来源类型短前缀（如「图」「网」）。各类型序号各自从 1 开始，[知识库-1] 与 [图片-1]
   * 都显示成 [1] 时读者分不清是哪条来源；知识库保持纯数字。
   */
  prefix?: string;
  /** 点击回调 */
  onClick?: (e: React.MouseEvent) => void;
  /** 聚焦回调（键盘可达的 hover 预览） */
  onFocus?: (e: React.FocusEvent) => void;
  /** 失焦回调 */
  onBlur?: (e: React.FocusEvent) => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * CitationBadge - 引用标记组件
 *
 * 用于在正文中显示紧凑数字引用气泡（1、2、忆2 等）。
 * 触屏（pointer: coarse）下使用 coarseHitClassFor24 伪元素扩区保证可点击热区，
 * 避免实体撑高 44px 破坏正文行高。
 */
export const CitationBadge: React.FC<CitationBadgeProps> = ({
  index,
  prefix,
  onClick,
  onFocus,
  onBlur,
  className,
}) => {
  return (
    <DsButton
      variant="ghost"
      size="sm"
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(
        '!inline-flex !h-5 !min-h-0 !min-w-5 !px-1.5 mx-0.5 align-baseline',
        '!rounded-full !text-xs font-medium leading-none tabular-nums',
        'bg-primary/10 text-primary',
        'hover:bg-primary/20',
        coarseHitClassFor24,
        className
      )}
    >
      {prefix}{index + 1}
    </DsButton>
  );
};

// ============================================================================
// CitationBadgeWithPopover - 徽章 + hover 即时预览
// ============================================================================

const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 200;

export interface CitationBadgeWithPopoverProps {
  /** 来源类型（rag/memory/web_search/multimodal） */
  citationType?: RetrievalSourceType;
  /** 类型内 1-based 序号（[知识库-N] 的 N，契约不可变） */
  citationIndex: number;
  /** 是否来自裸数字 `[N]` 兜底匹配：无对应来源时还原为纯文本 `[N]`，避免误伤正文 */
  bareNumeric?: boolean;
  /** 点击徽章 / 浮层「查看来源」时触发（citationEvents 滚动高亮面板） */
  onNavigate?: () => void;
  /** 自定义类名（传给徽章） */
  className?: string;
}

/**
 * CitationBadgeWithPopover - 带悬浮预览的引用徽章
 *
 * 来源数据通过 CitationSourceContext resolve（content.tsx 提供）；
 * 无 Provider 或 resolve 不到来源时退化为纯徽章（仅点击定位）。
 */
export const CitationBadgeWithPopover: React.FC<CitationBadgeWithPopoverProps> = ({
  citationType,
  citationIndex,
  bareNumeric = false,
  onNavigate,
  className,
}) => {
  const resolveSource = useContext(CitationSourceContext);
  const { t } = useTranslation('chatV2');
  const prefix = citationType && citationType !== 'rag' && citationType !== 'insight'
    ? t(`citation.badgePrefix.${citationType}`, { defaultValue: '' })
    : '';
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<RetrievalSource | null>(null);
  const lastSourceRef = useRef<RetrievalSource | null>(null);
  if (source) lastSourceRef.current = source;
  const presence = useMotionPresence(open && !!source, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'animation',
  });

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const closeNow = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  const scheduleOpen = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
    if (open || !resolveSource || !citationType || citationIndex <= 0) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => {
      const resolved = resolveSource(citationType, citationIndex);
      if (resolved) {
        setSource(resolved);
        setOpen(true);
      }
    }, HOVER_OPEN_DELAY_MS);
  }, [open, resolveSource, citationType, citationIndex]);

  const scheduleClose = useCallback(() => {
    window.clearTimeout(openTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, []);

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      closeNow();
      onNavigate?.();
    },
    [closeNow, onNavigate],
  );

  const handleLocate = useCallback(() => {
    closeNow();
    onNavigate?.();
  }, [closeNow, onNavigate]);

  // 裸数字 `[N]` 仅当当前消息确实存在对应 RAG 来源时渲染为交互徽章，否则原样还原 `[N]` 文本
  if (bareNumeric) {
    const resolvedBare =
      citationType && resolveSource && citationIndex > 0
        ? resolveSource(citationType, citationIndex)
        : null;
    if (!resolvedBare) {
      return <>[{citationIndex}]</>;
    }
  }

  // 孤儿 [知识库-N]：本条消息没有对应的知识库来源（例如跨轮次综合引用或工具读取资料后按
  // 知识库格式标注）。不能 return null 吞掉标记导致正文出现空白缺口；改渲染为非交互式的
  // 淡色引用胶囊，保留序号与来源提示，避免死按钮误导。
  const isOrphanRag =
    citationType === 'rag' && !!resolveSource && citationIndex > 0 && !resolveSource('rag', citationIndex);
  if (isOrphanRag) {
    const ragLabel = t('citation.rag', { defaultValue: 'Knowledge Base' });
    const orphanTooltip = `${ragLabel} [${citationIndex}]`;
    return (
      <span
        data-citation-orphan="true"
        title={orphanTooltip}
        aria-label={orphanTooltip}
        className={cn(
          'inline-flex items-center justify-center align-baseline min-w-5 h-5 px-1.5 mx-0.5',
          'rounded-full text-xs font-medium leading-none tabular-nums select-none',
          'bg-muted/80 text-muted-foreground border border-border/60',
          className,
        )}
      >
        {citationIndex}
      </span>
    );
  }

  return (
    <span
      ref={anchorRef}
      className="inline-flex align-baseline"
      data-citation-anchor="true"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <CitationBadge
        index={Math.max(citationIndex - 1, 0)}
        prefix={prefix}
        onClick={handleClick}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        className={className}
      />
      {presence.mounted && lastSourceRef.current && (
        <CitationPopover
          source={lastSourceRef.current}
          anchorEl={anchorRef.current}
          onClose={closeNow}
          onLocate={handleLocate}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          exiting={presence.exiting}
        />
      )}
    </span>
  );
};
