import React, { useEffect, useMemo, useState, useId, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass,
  BookOpen,
  Brain,
  Hammer,
  CaretRight,
  CaretLeft,
  ArrowSquareOut,
  Image,
  ImageBroken,
  ArrowsOut,
  ArrowsIn,
  WarningCircle,
} from '@phosphor-icons/react';
import type { UnifiedSourceBundle, UnifiedSourceGroup, UnifiedSourceItem } from './sourceTypes';
import { cn } from '@/utils/cn';
import { Z_INDEX } from '@/config/zIndex';
import { openUrl } from '@/utils/urlOpener';
import { citationEvents, type CitationHighlightEvent } from '../../utils/citationEvents';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { TextShimmer } from '../ui/TextShimmer';
import { setPendingMemoryLocate } from '@/utils/pendingMemoryLocate';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import { MultimodalSourceCard, resolveMultimodalImageSrc } from './MultimodalSourceCard';
import {
  buildResourceLocator,
  canLocateResource,
  DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT,
  type ResourceLocator,
} from '@/features/learning-hub/learningHubContracts';
import './UnifiedSourcePanel.css';

interface UnifiedSourcePanelProps {
  data: UnifiedSourceBundle;
  className?: string;
  /** 所属消息 ID（用于过滤 citationEvents，避免多条消息的面板同时响应） */
  messageId?: string;
  /** 检索进行中（驱动"正在检索"内联 shimmer 态） */
  isRetrieving?: boolean;
}

type CategoryKey = 'rag' | 'memory' | 'web_search' | 'tool' | 'multimodal' | string;

type FlatEntry =
  | { type: 'header'; key: string; label: string; count?: number }
  | { type: 'item'; key: string; item: UnifiedSourceItem; displayNumber: number };

const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const SNIPPET_MAX_LENGTH = 220;
/** 展开网格：每页懒挂载的卡片数 */
const EXPANDED_PAGE_SIZE = 24;
/** 水平轮播：最多直接挂载的卡片数（超出显示"查看全部"卡） */
const CAROUSEL_MAX_ITEMS = 30;
/** hover 预览关闭的宽限时间（卡片 → 预览之间的鼠标移动） */
const PREVIEW_CLOSE_DELAY_MS = 160;

function groupIcon(group: CategoryKey) {
  switch (group) {
    case 'memory':
      return <Brain size={16} />;
    case 'web_search':
      return <MagnifyingGlass size={16} />;
    case 'tool':
      return <Hammer size={16} />;
    case 'multimodal':
      return <Image size={16} />;
    default:
      return <BookOpen size={16} />;
  }
}

function renderScore(item: UnifiedSourceItem) {
  if (typeof item.score !== 'number') return null;
  const pct = Math.round(item.score * 100);
  return <span className="usp-item-score">{pct}%</span>;
}

function isHttpUrl(value?: string | null): boolean {
  if (!value) return false;
  return value.startsWith('http://') || value.startsWith('https://');
}

const CATEGORY_PRIORITY: Record<CategoryKey, number> = {
  tool: 0,
  multimodal: 1,
  rag: 2,
  memory: 3,
  web_search: 4,
};

/**
 * 带错误回退的缩略图（用于移动端列表项与 hover 预览）
 */
const SourceThumb: React.FC<{ item: UnifiedSourceItem; className?: string; iconSize?: number }> = ({
  item,
  className,
  iconSize = 16,
}) => {
  const [error, setError] = useState(false);
  const src = resolveMultimodalImageSrc(item);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (!src) return null;

  return (
    <div
      className={cn(
        'rounded-md overflow-hidden bg-muted flex items-center justify-center text-muted-foreground',
        className
      )}
    >
      {error ? (
        <ImageBroken size={iconSize} />
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setError(true)}
        />
      )}
    </div>
  );
};

const UnifiedSourcePanel: React.FC<UnifiedSourcePanelProps> = ({
  data,
  className,
  messageId,
  isRetrieving = false,
}) => {
  const { t } = useTranslation(['common', 'chatV2']);
  const groups = data?.groups || [];
  const errors = data?.errors || [];
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const categories = useMemo(() => {
    const map = new Map<CategoryKey, { group: CategoryKey; providers: UnifiedSourceGroup[]; count: number }>();
    groups.forEach((providerGroup) => {
      const key = providerGroup.group as CategoryKey;
      const existing = map.get(key);
      if (existing) {
        existing.providers.push(providerGroup);
        existing.count += providerGroup.count;
      } else {
        map.set(key, {
          group: key,
          providers: [providerGroup],
          count: providerGroup.count,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => {
      const pa = CATEGORY_PRIORITY[a.group] ?? 10;
      const pb = CATEGORY_PRIORITY[b.group] ?? 10;
      if (pa !== pb) return pa - pb;
      return (b.count ?? 0) - (a.count ?? 0);
    });
  }, [groups]);

  const [activeCategory, setActiveCategory] = useState<CategoryKey>(() => categories[0]?.group ?? '');
  const [localHighlightId, setLocalHighlightId] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(EXPANDED_PAGE_SIZE);

  // ========== hover 预览（可交互 portal 浮层） ==========
  const [preview, setPreview] = useState<{ item: UnifiedSourceItem; anchor: DOMRect } | null>(null);
  const previewElRef = useRef<HTMLDivElement | null>(null);
  const previewCloseTimer = useRef<number | null>(null);

  const clearPreviewCloseTimer = useCallback(() => {
    if (previewCloseTimer.current != null) {
      window.clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = null;
    }
  }, []);

  const openPreview = useCallback((e: React.MouseEvent, item: UnifiedSourceItem) => {
    clearPreviewCloseTimer();
    setPreview({ item, anchor: e.currentTarget.getBoundingClientRect() });
  }, [clearPreviewCloseTimer]);

  const scheduleClosePreview = useCallback(() => {
    clearPreviewCloseTimer();
    previewCloseTimer.current = window.setTimeout(() => {
      setPreview(null);
      previewCloseTimer.current = null;
    }, PREVIEW_CLOSE_DELAY_MS);
  }, [clearPreviewCloseTimer]);

  const cancelClosePreview = useCallback(() => {
    clearPreviewCloseTimer();
  }, [clearPreviewCloseTimer]);

  // 滚动/窗口变化时关闭预览，避免浮层错位（预览内部的滚动除外）
  useEffect(() => {
    if (!preview) return;
    const handleScroll = (e: Event) => {
      const target = e.target;
      if (previewElRef.current && target instanceof Node && previewElRef.current.contains(target)) {
        return;
      }
      setPreview(null);
    };
    const handleResize = () => setPreview(null);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [preview]);

  // 切换分类 / 展开模式 / 折叠面板时关闭预览
  useEffect(() => {
    setPreview(null);
  }, [activeCategory, isExpanded, open]);

  // 卸载时清理预览定时器
  useEffect(() => clearPreviewCloseTimer, [clearPreviewCloseTimer]);

  // ========== 状态健壮性：data 变化时重置瞬时状态 ==========
  useEffect(() => {
    setPreview(null);
    setLocalHighlightId(null);
    setVisibleCount(EXPANDED_PAGE_SIZE);
  }, [data]);

  useEffect(() => {
    setVisibleCount(EXPANDED_PAGE_SIZE);
  }, [activeCategory]);

  // 检查滚动状态
  const checkScrollability = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 5);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 5);
  }, []);

  // 左右翻页
  const scrollByAmount = useCallback((direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const cardWidth = 224 + 8; // w-56 = 224px + gap
    const scrollAmount = cardWidth * 2; // 每次滚动 2 张卡片
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    });
  }, []);

  useEffect(() => {
    if (!categories.length) {
      setActiveCategory('');
      return;
    }
    if (!categories.some(c => c.group === activeCategory)) {
      const next = categories[0];
      setActiveCategory(next.group);
    }
  }, [categories, activeCategory]);

  // 所有来源的扁平列表（按分类优先级顺序）
  const allSources = useMemo(() => {
    const result: UnifiedSourceItem[] = [];
    categories.forEach(category => {
      category.providers.forEach(provider => {
        (provider.items || []).forEach(item => {
          result.push(item);
        });
      });
    });
    return result;
  }, [categories]);

  // 引用契约查找表：`${citationType}:${typeIndex}` → item
  // typeIndex 由 sourceAdapter 按跨块全局顺序分配，与 `[类型-N]` 契约一致
  const citationLookup = useMemo(() => {
    const map = new Map<string, UnifiedSourceItem>();
    for (const item of allSources) {
      if (item.citationType && item.typeIndex != null) {
        map.set(`${item.citationType}:${item.typeIndex}`, item);
      }
    }
    return map;
  }, [allSources]);

  // 监听引用点击事件（按 messageId 过滤，多消息面板互不干扰）
  useEffect(() => {
    const timers: { scroll?: ReturnType<typeof setTimeout>; clear?: ReturnType<typeof setTimeout> } = {};

    const handleCitationEvent = (event: CitationHighlightEvent) => {
      if (event.messageId && messageId && event.messageId !== messageId) {
        return;
      }
      const target = citationLookup.get(`${event.type}:${event.index}`);
      if (!target) return;

      // 清理之前的定时器（防止快速点击时定时器堆积）
      if (timers.scroll) clearTimeout(timers.scroll);
      if (timers.clear) clearTimeout(timers.clear);

      setOpen(true);
      setLocalHighlightId(target.id);

      if (categories.some(c => c.group === target.origin)) {
        setActiveCategory(target.origin);
      }

      // 延迟滚动到卡片位置（等待 DOM 更新）
      timers.scroll = setTimeout(() => {
        const card = cardRefs.current.get(target.id);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }, 150);

      // 2秒后清除高亮
      timers.clear = setTimeout(() => {
        setLocalHighlightId(null);
      }, 2000);
    };

    const unsubscribe = citationEvents.subscribe(handleCitationEvent);
    return () => {
      unsubscribe();
      if (timers.scroll) clearTimeout(timers.scroll);
      if (timers.clear) clearTimeout(timers.clear);
    };
  }, [citationLookup, categories, messageId]);

  const activeCategoryProviders = useMemo(() => {
    return categories.find(c => c.group === activeCategory)?.providers ?? [];
  }, [categories, activeCategory]);

  const resolveProviderLabel = useCallback((providerLabel?: string, providerId?: string) => {
    const candidate = providerLabel || providerId || '';
    if (!candidate) return '';

    const translated = t(candidate, { defaultValue: '' });
    if (translated) {
      return translated;
    }

    const looksLikeToolName =
      candidate.includes('.') ||
      candidate.startsWith('builtin-') ||
      candidate.startsWith('mcp_');

    if (looksLikeToolName) {
      return getReadableToolName(candidate, t);
    }

    return candidate;
  }, [t]);

  // 当前分类的扁平条目（provider header + item）
  // displayNumber 使用"类型内序号"（与 citation [类型-N] 徽章一致）
  const flatEntries = useMemo(() => {
    const entries: FlatEntry[] = [];
    const showHeaders = activeCategoryProviders.length > 1;
    let fallbackNumber = 0;

    activeCategoryProviders.forEach((provider, index) => {
      const displayLabel = resolveProviderLabel(provider.providerLabel, provider.providerId);
      if (showHeaders && displayLabel) {
        entries.push({
          type: 'header',
          key: `header-${provider.providerId}-${index}`,
          label: displayLabel,
          count: provider.count,
        });
      }

      (provider.items || []).forEach(item => {
        fallbackNumber += 1;
        entries.push({
          type: 'item',
          key: item.id,
          item,
          displayNumber: item.typeIndex ?? fallbackNumber,
        });
      });
    });

    return entries;
  }, [activeCategoryProviders, resolveProviderLabel]);

  const totalItemsInCategory = useMemo(
    () => flatEntries.reduce((acc, e) => (e.type === 'item' ? acc + 1 : acc), 0),
    [flatEntries]
  );

  // 水平轮播：最多挂载 CAROUSEL_MAX_ITEMS 张卡，超出以"查看全部"卡收尾
  const carouselEntries = useMemo(() => {
    if (totalItemsInCategory <= CAROUSEL_MAX_ITEMS) return flatEntries;
    const out: FlatEntry[] = [];
    let itemCount = 0;
    for (const entry of flatEntries) {
      if (entry.type === 'item') {
        if (itemCount >= CAROUSEL_MAX_ITEMS) break;
        itemCount += 1;
      }
      out.push(entry);
    }
    return out;
  }, [flatEntries, totalItemsInCategory]);

  const carouselOverflow = Math.max(0, totalItemsInCategory - CAROUSEL_MAX_ITEMS);

  // 展开网格：分页式懒挂载（"加载更多"）
  const expandedEntries = useMemo(() => {
    if (totalItemsInCategory <= visibleCount) return flatEntries;
    const out: FlatEntry[] = [];
    let itemCount = 0;
    for (const entry of flatEntries) {
      if (entry.type === 'item') {
        if (itemCount >= visibleCount) break;
        itemCount += 1;
      }
      out.push(entry);
    }
    return out;
  }, [flatEntries, totalItemsInCategory, visibleCount]);

  const expandedRemaining = Math.max(0, totalItemsInCategory - visibleCount);

  // 监听滚动状态
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isExpanded) return;

    checkScrollability();
    container.addEventListener('scroll', checkScrollability);
    window.addEventListener('resize', checkScrollability);

    return () => {
      container.removeEventListener('scroll', checkScrollability);
      window.removeEventListener('resize', checkScrollability);
    };
  }, [checkScrollability, isExpanded, carouselEntries]);

  const totalLabel = useMemo(() => {
    return t('common:chat.sources.total', { count: data?.total ?? 0 });
  }, [t, data?.total]);

  const hasItems = (data?.total ?? 0) > 0;

  const handleOpenLink = useCallback((item: UnifiedSourceItem) => {
    if (item.link && isHttpUrl(item.link)) {
      openUrl(item.link);
    }
  }, []);

  const handleLocateGraph = useCallback((item: UnifiedSourceItem) => {
    const cardId = item.sourceId || (item.raw as any)?.source_id || item.raw.document_id;
    if (!cardId) return;
    try {
      window.dispatchEvent(new CustomEvent('DSTU_LOCATE_GRAPH_CARD' as any, { detail: { cardId } }));
    } catch (error: unknown) {
      console.error('[UnifiedSourcePanel] Failed to dispatch graph locate event:', error);
    }
  }, []);

  const getItemResourceLocator = useCallback((item: UnifiedSourceItem): ResourceLocator => buildResourceLocator({
    sourceId: item.sourceId || item.raw?.source_id || undefined,
    resourceId: item.resourceId,
    resourceType: item.resourceType,
    title: item.raw.file_name || item.title,
    path: item.path,
  }), []);

  const getMemoryLocateId = useCallback((item: UnifiedSourceItem): string => {
    const locator = getItemResourceLocator(item);
    return locator.sourceId || locator.resourceId || '';
  }, [getItemResourceLocator]);

  const handleLocateMemory = useCallback((item: UnifiedSourceItem) => {
    const locator = getItemResourceLocator(item);
    const memoryId = locator.sourceId || locator.resourceId;
    if (!memoryId) return;
    try {
      setPendingMemoryLocate(memoryId);
      window.dispatchEvent(new CustomEvent(DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT as any, {
        detail: { preferTab: 'memory', locator }
      }));
    } catch (error: unknown) {
      console.error('[UnifiedSourcePanel] Failed to dispatch memory navigate event:', error);
    }
  }, [getItemResourceLocator]);

  // 跳转到知识库文档并高亮（rag / multimodal 共用）
  const handleLocateResource = useCallback((item: UnifiedSourceItem) => {
    const locator = getItemResourceLocator(item);
    if (!canLocateResource(locator)) return;
    try {
      window.dispatchEvent(new CustomEvent(DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT as any, {
        detail: { locator, preferTab: 'manage' }
      }));
    } catch (error: unknown) {
      console.error('[UnifiedSourcePanel] Failed to dispatch knowledge base locate event:', error);
    }
  }, [getItemResourceLocator]);

  /**
   * 来源项操作按钮（卡片底部 / 移动端列表 / hover 预览共用）
   */
  const renderItemAction = useCallback((item: UnifiedSourceItem, compact: boolean) => {
    const btnClass = compact ? 'text-primary !h-6 text-xs' : 'text-primary';
    const iconSize = compact ? 12 : 14;
    if (item.origin === 'graph') {
      return (
        <NotionButton variant="ghost" size="sm" onClick={() => handleLocateGraph(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:chat.sources.locateGraph')}
        </NotionButton>
      );
    }
    if (item.origin === 'memory' && getMemoryLocateId(item)) {
      return (
        <NotionButton variant="ghost" size="sm" onClick={() => handleLocateMemory(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:chat.sources.locateMemory')}
        </NotionButton>
      );
    }
    if ((item.origin === 'rag' || item.origin === 'multimodal') && canLocateResource(getItemResourceLocator(item))) {
      return (
        <NotionButton variant="ghost" size="sm" onClick={() => handleLocateResource(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:chat.sources.locateKb')}
        </NotionButton>
      );
    }
    if (item.link && isHttpUrl(item.link)) {
      return (
        <NotionButton variant="ghost" size="sm" onClick={() => handleOpenLink(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:actions.open')}
        </NotionButton>
      );
    }
    return null;
  }, [t, handleLocateGraph, handleLocateMemory, handleLocateResource, handleOpenLink, getMemoryLocateId, getItemResourceLocator]);

  const registerCardRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // 展开时自动滚动到面板位置（随展开过程平滑跟随）
  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    const panel = panelRef.current;
    if (!panel) return;

    const scrollContainer = findScrollableContainer(panel);
    const marginPx = Math.max(window.innerHeight * 0.08, 60);

    const ensureVisible = (behavior: ScrollBehavior = 'smooth') => {
      const panelRect = panel.getBoundingClientRect();
      const containerRect =
        scrollContainer instanceof HTMLElement
          ? scrollContainer.getBoundingClientRect()
          : { top: 0, bottom: window.innerHeight };

      const overflowBottom = panelRect.bottom - (containerRect.bottom - marginPx);
      if (overflowBottom > 0) {
        scrollContainerBy(scrollContainer, overflowBottom, behavior);
        return;
      }

      const overflowTop = panelRect.top - (containerRect.top + marginPx);
      if (overflowTop < 0) {
        scrollContainerBy(scrollContainer, overflowTop, behavior);
      }
    };

    ensureVisible('smooth');

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        ensureVisible('auto');
        rafId = null;
      });
    });

    observer.observe(panel);

    const timeoutId = window.setTimeout(() => {
      observer.disconnect();
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }, 700);

    return () => {
      observer.disconnect();
      window.clearTimeout(timeoutId);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [open]);

  // 无来源、无检索中、无错误时不渲染（early return 必须在所有 hooks 之后）
  if (!groups.length && !isRetrieving && !errors.length) {
    return null;
  }

  // ========== 共享渲染片段 ==========

  const renderHeaderTitle = () => {
    if (isRetrieving && !hasItems) {
      return (
        <TextShimmer className="usp-header-title text-sm">
          {t('chatV2:sourcePanel.retrieving')}
        </TextShimmer>
      );
    }
    if (!hasItems && errors.length > 0) {
      return (
        <span className="usp-header-title text-destructive">
          {t('chatV2:sourcePanel.retrievalFailedGeneric')}
        </span>
      );
    }
    return <span className="usp-header-title">{totalLabel}</span>;
  };

  const renderRetrievingChip = () => {
    if (!isRetrieving || !hasItems) return null;
    return (
      <TextShimmer className="usp-retrieving-chip text-xs font-normal">
        {t('chatV2:sourcePanel.retrieving')}
      </TextShimmer>
    );
  };

  const renderErrorBar = () => {
    if (!errors.length) return null;
    const scopes = Array.from(new Set(errors.map(e => e.origin)))
      .map(origin => t(`common:chat.sources.groupLabels.${origin}`, { defaultValue: origin }))
      .join(' / ');
    const detail = errors.find(e => e.message)?.message;
    return (
      <div
        className="usp-error-bar flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 text-destructive px-2.5 py-1.5 text-xs"
        role="status"
        title={detail || undefined}
      >
        <WarningCircle size={16} className="shrink-0" />
        <span className="truncate">
          {t('chatV2:sourcePanel.retrievalFailed', { scopes })}
        </span>
      </div>
    );
  };

  const renderSkeletonCards = (count: number, fullWidth = false) => (
    Array.from({ length: count }).map((_, i) => (
      <div
        key={`usp-skeleton-${i}`}
        className={cn(
          'rounded-lg border border-border/50 bg-card p-2.5',
          fullWidth ? 'w-full' : 'w-56 flex-shrink-0'
        )}
        aria-hidden
      >
        <div className="flex items-center gap-2 mb-2">
          <Skeleton className="w-5 h-5 rounded-full" />
          <Skeleton className="h-3.5 w-28" />
        </div>
        <Skeleton className="h-3 w-full mb-1.5" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    ))
  );

  /** 桌面端来源卡片（多模态走 MultimodalSourceCard，其余走通用卡） */
  const renderSourceCard = (
    entry: Extract<FlatEntry, { type: 'item' }>,
    expandedMode: boolean
  ) => {
    const isHighlighted = localHighlightId === entry.item.id;

    if (entry.item.origin === 'multimodal') {
      const canLocate = canLocateResource(getItemResourceLocator(entry.item));
      return (
        <MultimodalSourceCard
          key={entry.key}
          ref={registerCardRef(entry.item.id)}
          item={entry.item}
          displayNumber={entry.displayNumber}
          highlighted={isHighlighted}
          expanded={expandedMode}
          onLocate={canLocate ? handleLocateResource : undefined}
          onMouseEnter={(e) => openPreview(e, entry.item)}
          onMouseLeave={scheduleClosePreview}
        />
      );
    }

    const snippetText = sanitizeSnippet(entry.item.snippet);

    return (
      <div
        ref={registerCardRef(entry.item.id)}
        className={cn(
          'usp-item-card rounded-lg border bg-card p-2.5 hover:bg-[var(--interactive-hover)] transition-all cursor-default group',
          !expandedMode && 'w-56 flex-shrink-0',
          isHighlighted && 'shadow-[inset_0_0_0_2px_hsl(var(--primary)),0_10px_15px_-3px_rgb(0_0_0/0.1)]'
        )}
        key={entry.key}
        role="listitem"
        onMouseEnter={(e) => openPreview(e, entry.item)}
        onMouseLeave={scheduleClosePreview}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2 overflow-hidden">
            {/* 来源编号徽章（类型内序号，与 [类型-N] 契约一致） */}
            <span className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold">
              {entry.displayNumber}
            </span>
            <span className="text-muted-foreground shrink-0">{groupIcon(entry.item.origin)}</span>
            <span className="text-sm font-medium truncate" title={entry.item.title}>{entry.item.title}</span>
          </div>
          {renderScore(entry.item)}
        </div>
        <div className="text-xs text-muted-foreground line-clamp-2 mb-1.5 h-8">
          {snippetText}
        </div>
        <div className="flex items-center justify-between mt-auto pt-1.5 border-t border-border/50">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider opacity-70">
            {t(`common:chat.sources.groupLabels.${entry.item.origin}`, { defaultValue: entry.item.origin })}
          </span>
          {renderItemAction(entry.item, true)}
        </div>
      </div>
    );
  };

  /** provider 分组标识（轮播 = 竖排分隔条；展开网格 = 整行小标题） */
  const renderProviderHeader = (
    entry: Extract<FlatEntry, { type: 'header' }>,
    expandedMode: boolean
  ) => {
    if (expandedMode) {
      return (
        <div
          key={entry.key}
          className="usp-provider-header flex items-center gap-1.5 text-xs font-medium text-muted-foreground pt-1"
          style={{ gridColumn: '1 / -1' }}
        >
          <span className="truncate">{entry.label}</span>
          {entry.count != null && <span className="opacity-70">{entry.count}</span>}
        </div>
      );
    }
    return (
      <div key={entry.key} className="usp-provider-divider" role="presentation" title={entry.label}>
        <span className="usp-provider-divider-label">{entry.label}</span>
      </div>
    );
  };

  // ========== 移动端：inline 折叠 + 垂直/水平列表 ==========

  const renderMobileSourceItem = (entry: Extract<FlatEntry, { type: 'item' }>) => {
    const isHighlighted = localHighlightId === entry.item.id;

    return (
      <div
        key={entry.key}
        ref={registerCardRef(entry.item.id)}
        className={cn(
          'p-3 rounded-lg border bg-card hover:bg-[var(--interactive-hover)] transition-all',
          isHighlighted && 'ring-1 ring-primary/30'
        )}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-sm font-semibold">
            {entry.displayNumber}
          </span>
          <span className="text-muted-foreground">{groupIcon(entry.item.origin)}</span>
          <span className="font-medium truncate flex-1">{entry.item.title}</span>
          {renderScore(entry.item)}
        </div>
        <div className="flex items-start gap-2 mb-2">
          {entry.item.origin === 'multimodal' && (
            <SourceThumb item={entry.item} className="w-12 h-12 flex-shrink-0" />
          )}
          <div className="text-sm text-muted-foreground line-clamp-3 flex-1 min-w-0">
            {entry.item.snippet}
          </div>
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground uppercase tracking-wider opacity-70">
            {t(`common:chat.sources.groupLabels.${entry.item.origin}`, { defaultValue: entry.item.origin })}
          </span>
          {renderItemAction(entry.item, false)}
        </div>
      </div>
    );
  };

  // 移动端：缩略卡片 + inline 垂直展开模式
  if (isMobile) {
    return (
      <div
        ref={panelRef}
        className={cn('unified-source-panel', className)}
        data-testid="unified-source-panel"
      >
        {/* 头部 */}
        <div className="usp-header">
          <NotionButton
            data-testid="btn-toggle-source-panel"
            variant="ghost"
            size="sm"
            className="usp-header-left"
            onClick={() => setOpen(prev => !prev)}
            aria-expanded={open}
          >
            <MagnifyingGlass size={16} className="panel-header-icon" />
            {renderHeaderTitle()}
            <CaretRight size={16} className={cn('usp-header-arrow', open && 'expanded')} />
          </NotionButton>
          {renderRetrievingChip()}
        </div>

        {/* 可折叠的内容区 */}
        <div
          className={cn(
            'usp-collapse-wrapper grid w-full transition-all duration-300 ease-in-out motion-reduce:transition-none',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
          )}
          aria-hidden={!open}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="usp-container">
              <div className="usp-body relative">
                {renderErrorBar()}

                {/* 分类标签 */}
                {categories.length > 0 && (
                  <div className="usp-category-pills" role="tablist">
                    {categories.map(category => {
                      const isActive = category.group === activeCategory;
                      const label = t(`common:chat.sources.groupLabels.${category.group}`, { defaultValue: category.group });
                      return (
                        <NotionButton
                          key={`category-${category.group}`}
                          variant="ghost"
                          size="sm"
                          className={cn('usp-category-pill', isActive && 'active')}
                          onClick={() => setActiveCategory(category.group)}
                          aria-pressed={isActive}
                        >
                          <span className="usp-pill-icon">{groupIcon(category.group)}</span>
                          <span className="usp-pill-label">{label}</span>
                          <span className="usp-pill-count">{category.count}</span>
                        </NotionButton>
                      );
                    })}
                    {/* 展开/收起按钮 → 移动端契约：不用底部抽屉，改为消息流内 inline 垂直展开 */}
                    {totalItemsInCategory > 2 && (
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="usp-expand-btn ml-auto"
                        onClick={() => setIsExpanded(prev => !prev)}
                        title={isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}
                      >
                        {isExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                        <span>{isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}</span>
                      </NotionButton>
                    )}
                  </div>
                )}

                {isExpanded ? (
                  /* 展开态：inline 垂直列表（含分组标题 + 分页懒挂载），随消息流滚动 */
                  <div className="space-y-3 py-1">
                    {expandedEntries.length === 0 && !isRetrieving && (
                      <div className="usp-empty w-full text-center py-4">{t('common:chat.sources.empty')}</div>
                    )}
                    {expandedEntries.map(entry => {
                      if (entry.type === 'header') {
                        return (
                          <div key={entry.key} className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-2">
                            {entry.label}
                          </div>
                        );
                      }
                      return renderMobileSourceItem(entry);
                    })}
                    {isRetrieving && renderSkeletonCards(2, true)}
                    {expandedRemaining > 0 && (
                      <div className="flex justify-center">
                        <NotionButton
                          variant="ghost"
                          size="sm"
                          onClick={() => setVisibleCount(c => c + EXPANDED_PAGE_SIZE)}
                        >
                          {t('chatV2:sourcePanel.loadMore', { count: expandedRemaining })}
                        </NotionButton>
                      </div>
                    )}
                  </div>
                ) : (
                /* 收起态：来源卡片水平滚动列表 */
                <div className="usp-sources-wrapper relative">
                  {/* 左翻页按钮 */}
                  {canScrollLeft && (
                    <NotionButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="usp-scroll-btn usp-scroll-left absolute left-0 top-1/2 -translate-y-1/2 z-10 !w-7 !h-7 rounded-full bg-background/90 border shadow-md"
                      onClick={() => scrollByAmount('left')}
                      aria-label={t('common:actions.scrollLeft')}
                    >
                      <CaretLeft size={16} />
                    </NotionButton>
                  )}

                  {/* 右翻页按钮 */}
                  {canScrollRight && (
                    <NotionButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="usp-scroll-btn usp-scroll-right absolute right-0 top-1/2 -translate-y-1/2 z-10 !w-7 !h-7 rounded-full bg-background/90 border shadow-md"
                      onClick={() => scrollByAmount('right')}
                      aria-label={t('common:actions.scrollRight')}
                    >
                      <CaretRight size={16} />
                    </NotionButton>
                  )}

                  <CustomScrollArea
                    orientation="horizontal"
                    viewportRef={scrollContainerRef}
                    viewportClassName="flex gap-2 py-1"
                    viewportProps={{ role: 'list' }}
                    className="w-full"
                  >
                    {carouselEntries.length === 0 && !isRetrieving && (
                      <div className="usp-empty w-full text-center py-4">{t('common:chat.sources.empty')}</div>
                    )}
                    {carouselEntries.map(entry => {
                      if (entry.type === 'header') {
                        return renderProviderHeader(entry, false);
                      }
                      const snippetText = sanitizeSnippet(entry.item.snippet);
                      const isHighlighted = localHighlightId === entry.item.id;

                      return (
                        <div
                          ref={registerCardRef(entry.item.id)}
                          className={cn(
                            'usp-item-card w-44 flex-shrink-0 rounded-lg border bg-card p-2 transition-all cursor-default',
                            isHighlighted && 'shadow-[inset_0_0_0_2px_hsl(var(--primary))]'
                          )}
                          key={entry.key}
                          role="listitem"
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold">
                              {entry.displayNumber}
                            </span>
                            <span className="text-muted-foreground shrink-0">{groupIcon(entry.item.origin)}</span>
                            <span className="text-xs font-medium truncate">{entry.item.title}</span>
                          </div>
                          {entry.item.origin === 'multimodal' && resolveMultimodalImageSrc(entry.item) ? (
                            <div className="flex items-start gap-1.5">
                              <SourceThumb item={entry.item} className="w-9 h-9 flex-shrink-0" iconSize={14} />
                              <div className="text-[10px] text-muted-foreground line-clamp-2 h-6 flex-1 min-w-0">
                                {snippetText}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[10px] text-muted-foreground line-clamp-2 h-6">
                              {snippetText}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {isRetrieving && renderSkeletonCards(2)}
                    {carouselOverflow > 0 && (
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="usp-more-card w-28 flex-shrink-0 rounded-lg border border-dashed !h-auto self-stretch text-xs text-muted-foreground"
                        onClick={() => setIsExpanded(true)}
                      >
                        {t('chatV2:sourcePanel.showAllCard', { count: totalItemsInCategory })}
                      </NotionButton>
                    )}
                  </CustomScrollArea>
                </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ========== 桌面端：折叠面板 + 轮播/展开网格 + 可交互 hover 预览 ==========
  return (
    <div
      ref={panelRef}
      className={cn('unified-source-panel', !open && 'collapsed', className)}
      data-testid="unified-source-panel"
    >
      <div className="usp-header">
        <NotionButton
          data-testid="btn-toggle-source-panel"
          variant="ghost"
          size="sm"
          className="usp-header-left"
          onClick={() => setOpen(prev => !prev)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <MagnifyingGlass size={16} className="panel-header-icon" />
          {renderHeaderTitle()}
          <CaretRight size={16} className={cn('usp-header-arrow', open && 'expanded')} />
        </NotionButton>
        {renderRetrievingChip()}
        {data.stage && (
          <span className="usp-header-stage">{data.stage}</span>
        )}
      </div>

      <div
        className={cn(
          'usp-collapse-wrapper grid w-full transition-all duration-300 ease-in-out motion-reduce:transition-none motion-reduce:duration-0',
          open ? 'grid-rows-[1fr] opacity-100 translate-y-0' : 'grid-rows-[0fr] opacity-0 -translate-y-1 pointer-events-none'
        )}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className="usp-container"
            id={bodyId}
            role="region"
            aria-label={totalLabel}
            aria-hidden={!open}
          >
            <div className="usp-body relative">
              {renderErrorBar()}

              {categories.length > 0 && (
                <div className="usp-category-pills" role="tablist">
                  {categories.map(category => {
                    const isActive = category.group === activeCategory;
                    const label = t(`common:chat.sources.groupLabels.${category.group}`, { defaultValue: category.group });
                    return (
                      <NotionButton
                        key={`category-${category.group}`}
                        data-testid={`source-category-${category.group}`}
                        variant="ghost"
                        size="sm"
                        className={cn('usp-category-pill', isActive && 'active')}
                        onClick={() => setActiveCategory(category.group)}
                        aria-pressed={isActive}
                      >
                        <span className="usp-pill-icon">{groupIcon(category.group)}</span>
                        <span className="usp-pill-label">{label}</span>
                        <span className="usp-pill-count">{category.count}</span>
                      </NotionButton>
                    );
                  })}
                  {/* 展开/收起按钮 */}
                  {totalItemsInCategory > 3 && (
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="usp-expand-btn ml-auto"
                      onClick={() => setIsExpanded(prev => !prev)}
                      title={isExpanded ? t('common:actions.collapse') : t('common:actions.expand')}
                    >
                      {isExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                      <span>{isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}</span>
                    </NotionButton>
                  )}
                </div>
              )}

              {/* 来源列表容器 */}
              <div className="usp-sources-wrapper relative">
                {/* 左翻页按钮 */}
                {!isExpanded && canScrollLeft && (
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="usp-scroll-btn usp-scroll-left absolute left-0 top-1/2 -translate-y-1/2 z-10 !w-8 !h-8 rounded-full bg-background/90 border shadow-md"
                    onClick={() => scrollByAmount('left')}
                    aria-label={t('common:actions.scrollLeft')}
                  >
                    <CaretLeft size={18} />
                  </NotionButton>
                )}

                {/* 右翻页按钮 */}
                {!isExpanded && canScrollRight && (
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="usp-scroll-btn usp-scroll-right absolute right-0 top-1/2 -translate-y-1/2 z-10 !w-8 !h-8 rounded-full bg-background/90 border shadow-md"
                    onClick={() => scrollByAmount('right')}
                    aria-label={t('common:actions.scrollRight')}
                  >
                    <CaretRight size={18} />
                  </NotionButton>
                )}

                <CustomScrollArea
                  orientation="horizontal"
                  viewportRef={scrollContainerRef}
                  viewportClassName={cn(
                    'py-1 w-full',
                    isExpanded
                      ? 'grid gap-2'
                      : 'flex gap-2'
                  )}
                  viewportProps={{
                    role: 'list',
                    ...(isExpanded ? { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } } : {})
                  }}
                  className="w-full"
                >
                  {totalItemsInCategory === 0 && !isRetrieving && (
                    <div className="usp-empty w-full text-center py-4" style={isExpanded ? { gridColumn: '1 / -1' } : undefined}>
                      {t('common:chat.sources.empty')}
                    </div>
                  )}

                  {(isExpanded ? expandedEntries : carouselEntries).map(entry => {
                    if (entry.type === 'header') {
                      return renderProviderHeader(entry, isExpanded);
                    }
                    return renderSourceCard(entry, isExpanded);
                  })}

                  {isRetrieving && renderSkeletonCards(hasItems ? 2 : 3, isExpanded)}

                  {/* 轮播溢出：查看全部卡 */}
                  {!isExpanded && carouselOverflow > 0 && (
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="usp-more-card w-32 flex-shrink-0 rounded-lg border border-dashed !h-auto self-stretch text-xs text-muted-foreground"
                      onClick={() => setIsExpanded(true)}
                    >
                      {t('chatV2:sourcePanel.showAllCard', { count: totalItemsInCategory })}
                    </NotionButton>
                  )}

                  {/* 展开网格：分页加载更多 */}
                  {isExpanded && expandedRemaining > 0 && (
                    <div className="flex justify-center py-1" style={{ gridColumn: '1 / -1' }}>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setVisibleCount(c => c + EXPANDED_PAGE_SIZE)}
                      >
                        {t('chatV2:sourcePanel.loadMore', { count: expandedRemaining })}
                      </NotionButton>
                    </div>
                  )}
                </CustomScrollArea>
              </div>

              {/* 可交互 Hover 预览（portal 浮层，滚动/切分类时关闭） */}
              {preview && createPortal(
                (() => {
                  const { item, anchor } = preview;
                  const showBelow = anchor.top < 360;
                  const top = showBelow ? anchor.bottom + 10 : anchor.top - 10;
                  const left = Math.min(window.innerWidth - 340, Math.max(10, anchor.left));
                  const transform = showBelow ? 'none' : 'translateY(-100%)';
                  const isMultimodalItem = item.origin === 'multimodal';

                  return (
                    <div
                      ref={previewElRef}
                      className="fixed w-80 max-h-96 p-4 bg-popover text-popover-foreground rounded-xl shadow-lg ring-1 ring-border/40 border-transparent text-sm pointer-events-auto ui-zoom-fade-in flex flex-col"
                      style={{
                        zIndex: Z_INDEX.toast,
                        top,
                        left,
                        transform
                      }}
                      role="tooltip"
                      onMouseEnter={cancelClosePreview}
                      onMouseLeave={scheduleClosePreview}
                    >
                      <div className="font-semibold mb-2 flex items-center gap-2 border-b pb-2 shrink-0">
                        {groupIcon(item.origin)}
                        <span className="truncate">{item.title}</span>
                        {renderScore(item)}
                      </div>
                      {isMultimodalItem && (
                        <SourceThumb item={item} className="w-full h-32 mb-2 shrink-0" iconSize={20} />
                      )}
                      <CustomScrollArea className="flex-1 min-h-0" hideTrackWhenIdle={false}>
                        <div className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                          {item.snippet || t('common:chat.sources.multimodal.noSnippet')}
                        </div>
                      </CustomScrollArea>
                      <div className="flex items-center justify-between pt-2 mt-2 border-t border-border/50 shrink-0">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider opacity-70">
                          {t(`common:chat.sources.groupLabels.${item.origin}`, { defaultValue: item.origin })}
                        </span>
                        {renderItemAction(item, true)}
                      </div>
                    </div>
                  );
                })(),
                document.body
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnifiedSourcePanel;

function sanitizeSnippet(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const stripped = raw.replace(URL_REGEX, ' ').replace(/\s+/g, ' ').trim();
  const base = stripped || raw;
  if (base.length <= SNIPPET_MAX_LENGTH) return base;
  return `${base.slice(0, SNIPPET_MAX_LENGTH)}…`;
}

type ScrollContainer = Window | HTMLElement;

function findScrollableContainer(node: HTMLElement | null): ScrollContainer {
  if (typeof window === 'undefined' || !node) return window;
  let current: HTMLElement | null = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const isScrollable =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      current.scrollHeight > current.clientHeight + 8;
    if (isScrollable) {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

function scrollContainerBy(container: ScrollContainer, delta: number, behavior: ScrollBehavior) {
  if (Math.abs(delta) < 1) return;
  if (container === window) {
    window.scrollBy({ top: delta, behavior });
  } else {
    container.scrollBy({ top: delta, behavior });
  }
}
