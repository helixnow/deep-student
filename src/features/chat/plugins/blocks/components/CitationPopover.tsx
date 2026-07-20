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
import { NotionButton } from '@/components/ui/NotionButton';
import {
  FileText,
  Globe,
  Brain,
  Image as ImageIcon,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import type { RetrievalSource, RetrievalSourceType } from './types';
import { openUrl } from '@/utils/urlOpener';
import { CitationSourceContext } from '../../../utils/citationSourceContext';

// ============================================================================
// 图标映射
// ============================================================================

// ★ 2026-01 清理：移除 graph 图标（错题系统废弃）
const sourceTypeIcons: Record<RetrievalSourceType, typeof FileText> = {
  rag: FileText,
  memory: Brain,
  web_search: Globe,
  multimodal: ImageIcon,
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
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const popRef = useRef<HTMLDivElement | null>(null);

  const Icon = sourceTypeIcons[source.type] || FileText;
  const hasUrl = !!source.url;

  const handleOpenUrl = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (source.url) {
        openUrl(source.url);
      }
    },
    [source.url],
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
        'ui-zoom-fade-in',
        className,
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 卡片主体：点击定位来源面板（与徽章点击同路径） */}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'block w-full text-left cursor-pointer rounded-t-lg',
          !hasUrl && 'rounded-b-lg',
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
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                {t(`citation.${source.type}`)}
              </span>
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

      {/* 底部操作：有 url 时提供外链打开 */}
      {hasUrl && (
        <div className="p-2 border-t border-border/50">
          <NotionButton variant="ghost" size="sm" onClick={handleOpenUrl} className="w-full">
            <ArrowSquareOut size={14} />
            <span className="truncate">{t('blocks.retrieval.openSource')}</span>
          </NotionButton>
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
 * 用于在正文中显示引用标记 [1]、[2] 等
 */
export const CitationBadge: React.FC<CitationBadgeProps> = ({
  index,
  onClick,
  onFocus,
  onBlur,
  className,
}) => {
  return (
    <NotionButton
      variant="ghost"
      size="sm"
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(
        '!inline-flex !min-w-[1.25rem] !h-5 !px-1 mx-0.5',
        'text-xs font-medium',
        'bg-primary/10 text-primary',
        'hover:bg-primary/20',
        className
      )}
    >
      [{index + 1}]
    </NotionButton>
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
  onNavigate,
  className,
}) => {
  const resolveSource = useContext(CitationSourceContext);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<RetrievalSource | null>(null);

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
        onClick={handleClick}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        className={className}
      />
      {open && source && (
        <CitationPopover
          source={source}
          anchorEl={anchorRef.current}
          onClose={closeNow}
          onLocate={handleLocate}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </span>
  );
};
