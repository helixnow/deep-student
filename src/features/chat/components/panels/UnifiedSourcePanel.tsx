import React, { useEffect, useMemo, useState, useId, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass,
  BookOpen,
  Brain,
  Hammer,
  CaretRight,
  CaretLeft,
  X,
  ArrowSquareOut,
  GraduationCap,
  Image,
  ImageBroken,
  ArrowsOut,
  ArrowsIn,
  WarningCircle,
} from '@phosphor-icons/react';
import type { UnifiedSourceBundle, UnifiedSourceGroup, UnifiedSourceItem } from './sourceTypes';
import { cn } from '@/utils/cn';
import { openUrl } from '@/utils/urlOpener';
import { citationEvents, type CitationHighlightEvent } from '../../utils/citationEvents';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { DsButton } from '@/components/ui/DsButton';
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
/** 折叠区 grid-rows 展开过渡时长（与 duration-300 对齐） */
const COLLAPSE_ANIMATION_MS = 300;
/** 展开过渡结束后仍未收到 transitionend 时的安全余量兜底 */
const SCROLL_FALLBACK_MARGIN_MS = 120;
/** 引用高亮的持续时间（与 usp-citation-pulse 动画时长一致） */
const CITATION_HIGHLIGHT_MS = 2000;

function groupIcon(group: CategoryKey, size = 16) {
  switch (group) {
    case 'memory':
      return <Brain size={size} />;
    case 'web_search':
      return <MagnifyingGlass size={size} />;
    case 'academic_search':
      return <GraduationCap size={size} />;
    case 'tool':
      return <Hammer size={size} />;
    case 'multimodal':
      return <Image size={size} />;
    default:
      return <BookOpen size={size} />;
  }
}

function renderScore(item: UnifiedSourceItem) {
  if (typeof item.score !== 'number') return null;
  const pct = Math.round(item.score * 100);
  const tier = pct >= 75 ? 'high' : pct >= 45 ? 'mid' : 'low';
  return (
    <span className="usp-item-score" data-tier={tier}>
      <i className="usp-score-dot" aria-hidden />
      {pct}%
    </span>
  );
}

function isHttpUrl(value?: string | null): boolean {
  if (!value) return false;
  return value.startsWith('http://') || value.startsWith('https://');
}

/** 网页来源的域名（用于卡片底部元信息，比重复的分组名信息量更大） */
function extractDomain(link?: string | null): string | null {
  if (!isHttpUrl(link)) return null;
  try {
    return new URL(link as string).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** 入场 stagger 延迟档位（超过后统一用最大延迟，避免长列表尾部等太久） */
const STAGGER_CAP = 12;

function staggerStyle(seqIndex: number): React.CSSProperties {
  return { '--usp-i': Math.min(seqIndex, STAGGER_CAP) } as React.CSSProperties;
}

const CATEGORY_PRIORITY: Record<CategoryKey, number> = {
  tool: 0,
  multimodal: 1,
  rag: 2,
  memory: 3,
  web_search: 4,
  academic_search: 5,
};

/**
 * 带错误回退的缩略图（用于移动端列表项与卡片内联详情）
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
  /** 折叠区包装元素（用于等待 grid-rows 展开过渡结束后再滚动） */
  const collapseWrapperRef = useRef<HTMLDivElement>(null);
  /** open 的最新值（citation 事件处理器中读取，不进入订阅 effect 依赖） */
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

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

  // ========== 卡片内联详情 ==========
  // 取代旧的 hover portal 预览：portal 浮层 role="tooltip" 却含可交互按钮
  // （a11y 角色不当），且 zIndex 借用 toast 档、滚动时易错位。
  // 现改为点击卡片在面板内内联展开完整 snippet，随消息流滚动，无浮层问题。
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const detailAreaId = useId();

  const toggleDetail = useCallback((item: UnifiedSourceItem) => {
    setDetailItemId((prev) => (prev === item.id ? null : item.id));
  }, []);

  const closeDetail = useCallback(() => setDetailItemId(null), []);

  /** 卡片整面可点开详情；点击卡片内部按钮/链接（打开、定位等）时不触发 */
  const handleCardSurfaceClick = useCallback((e: React.MouseEvent, item: UnifiedSourceItem) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    toggleDetail(item);
  }, [toggleDetail]);

  const handleCardSurfaceKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>, item: UnifiedSourceItem) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggleDetail(item);
  }, [toggleDetail]);

  // 切换分类 / 展开模式 / 折叠面板时收起详情
  useEffect(() => {
    setDetailItemId(null);
  }, [activeCategory, isExpanded, open]);

  // ========== 状态健壮性 ==========
  // data 变化（流式追加来源等）只重置瞬时态，不打断用户的展开浏览。
  // 以内容签名（total + 各 item id 序列）为依赖而非对象身份：
  // 流式 flush 期间上游可能换 bundle 引用但来源集合未变，
  // 按身份重置会不断清掉用户点开的内联详情卡
  const dataSignature = useMemo(() => {
    let sig = `${data?.total ?? 0}`;
    for (const group of data?.groups || []) {
      for (const item of group.items || []) {
        sig += `|${item.id}`;
      }
    }
    return sig;
  }, [data]);
  useEffect(() => {
    setDetailItemId(null);
    setLocalHighlightId(null);
  }, [dataSignature]);

  // 展开态按 messageId 维度管理：组件被复用渲染另一条消息时，
  // 不能把上一条消息的 open/isExpanded/分页状态带过去
  useEffect(() => {
    setOpen(false);
    setIsExpanded(false);
    setVisibleCount(EXPANDED_PAGE_SIZE);
    setDetailItemId(null);
    setLocalHighlightId(null);
  }, [messageId]);

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
    // 按实际卡宽计算步长（桌面 w-56=224 / 移动 w-44=176），避免硬编码在移动端过冲
    const firstCard = container.querySelector<HTMLElement>('.usp-item-card');
    const cardWidth = (firstCard?.getBoundingClientRect().width ?? 224) + 8; // + gap
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

  // 当前内联详情对应的来源项（卡片点击后展开；数据流式更新后 id 失效则自动关闭）
  const detailItem = useMemo(() => {
    if (!detailItemId) return null;
    return allSources.find(item => item.id === detailItemId) ?? null;
  }, [detailItemId, allSources]);

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
    let removeTransitionListener: (() => void) | null = null;

    const cleanupScrollWait = () => {
      if (timers.scroll) {
        clearTimeout(timers.scroll);
        timers.scroll = undefined;
      }
      if (removeTransitionListener) {
        removeTransitionListener();
        removeTransitionListener = null;
      }
    };

    /** 目标 item 在其分类内的顺位（用于判断轮播截断/分页是否覆盖到它） */
    const findCategoryItemIndex = (target: UnifiedSourceItem): number => {
      const category = categories.find(c => c.group === target.origin);
      if (!category) return -1;
      let idx = 0;
      for (const provider of category.providers) {
        for (const item of provider.items || []) {
          if (item.id === target.id) return idx;
          idx += 1;
        }
      }
      return -1;
    };

    const handleCitationEvent = (event: CitationHighlightEvent) => {
      if (event.messageId && messageId && event.messageId !== messageId) {
        return;
      }
      const target = citationLookup.get(`${event.type}:${event.index}`);
      if (!target) return;

      // 清理之前的滚动等待/定时器（防止快速点击时堆积）
      cleanupScrollWait();
      if (timers.clear) clearTimeout(timers.clear);

      const wasOpen = openRef.current;
      setOpen(true);
      setLocalHighlightId(target.id);

      if (categories.some(c => c.group === target.origin)) {
        setActiveCategory(target.origin);
      }

      // 轮播截断 / 分页未覆盖目标时：预先切到展开网格并把分页推进到目标位置，
      // 否则目标卡不在 DOM，高亮滚动会静默失败
      const itemIdx = findCategoryItemIndex(target);
      if (itemIdx >= CAROUSEL_MAX_ITEMS) {
        setIsExpanded(true);
      }
      if (itemIdx >= 0) {
        setVisibleCount(c =>
          itemIdx >= c ? Math.ceil((itemIdx + 1) / EXPANDED_PAGE_SIZE) * EXPANDED_PAGE_SIZE : c
        );
      }

      const scrollToCard = () => {
        const card = cardRefs.current.get(target.id);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          return;
        }
        // 兜底：目标仍不在 DOM（如轮播截断且分类切换后 DOM 尚未提交），
        // 强制展开网格后重试一次
        setIsExpanded(true);
        timers.scroll = setTimeout(() => {
          cardRefs.current.get(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }, 100);
      };

      if (wasOpen) {
        // 面板已展开：等一小拍让分类/分页切换后的 DOM 生效即可滚动
        timers.scroll = setTimeout(scrollToCard, 50);
      } else {
        // 折叠 → 展开：等 grid-rows 展开过渡真正结束（transitionend）再滚动，
        // 否则 300ms 折叠动画未完成时 scrollIntoView 会打空
        let fired = false;
        const fire = () => {
          if (fired) return;
          fired = true;
          cleanupScrollWait();
          scrollToCard();
        };
        const wrapper = collapseWrapperRef.current;
        if (wrapper) {
          const onTransitionEnd = (e: TransitionEvent) => {
            if (e.target !== wrapper || e.propertyName !== 'grid-template-rows') return;
            fire();
          };
          wrapper.addEventListener('transitionend', onTransitionEnd);
          removeTransitionListener = () => wrapper.removeEventListener('transitionend', onTransitionEnd);
        }
        // 安全余量兜底：motion-reduce 无过渡 / transitionend 丢失时也能滚到位
        timers.scroll = setTimeout(fire, COLLAPSE_ANIMATION_MS + SCROLL_FALLBACK_MARGIN_MS);
      }

      // 与 usp-citation-pulse 动画同步：2 秒后清除高亮
      timers.clear = setTimeout(() => {
        setLocalHighlightId(null);
      }, CITATION_HIGHLIGHT_MS);
    };

    const unsubscribe = citationEvents.subscribe(handleCitationEvent);
    return () => {
      unsubscribe();
      cleanupScrollWait();
      if (timers.clear) clearTimeout(timers.clear);
    };
  }, [citationLookup, categories, messageId]);

  const activeCategoryProviders = useMemo(() => {
    return categories.find(c => c.group === activeCategory)?.providers ?? [];
  }, [categories, activeCategory]);

  /** 分组显示名：common 命名空间优先，chatV2 补充（academic_search 等新分组），最后回退原值 */
  const groupLabelOf = useCallback((group: string) => {
    return t(`common:chat.sources.groupLabels.${group}`, {
      defaultValue: t(`chatV2:sourcePanel.groupLabels.${group}`, { defaultValue: group }),
    });
  }, [t]);

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

  // 监听滚动状态（capture 监听 img load：缩略图加载完成后内容宽度变化，重算轮播箭头）
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isExpanded) return;

    checkScrollability();
    container.addEventListener('scroll', checkScrollability);
    container.addEventListener('load', checkScrollability, true);
    window.addEventListener('resize', checkScrollability);

    return () => {
      container.removeEventListener('scroll', checkScrollability);
      container.removeEventListener('load', checkScrollability, true);
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
   * 来源项操作按钮（卡片底部 / 移动端列表 / 内联详情共用）
   */
  const renderItemAction = useCallback((item: UnifiedSourceItem, compact: boolean) => {
    // compact 视觉高度 24px；触屏（pointer:coarse）下两种形态都用 min-h 撑回 44px 触控热区
    const btnClass = compact
      ? 'text-primary !h-6 [@media(pointer:coarse)]:!min-h-11 text-xs'
      : 'text-primary [@media(pointer:coarse)]:!min-h-11';
    const iconSize = compact ? 12 : 14;
    if (item.origin === 'graph') {
      return (
        <DsButton variant="ghost" size="sm" onClick={() => handleLocateGraph(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:chat.sources.locateGraph')}
        </DsButton>
      );
    }
    if (item.origin === 'memory' && getMemoryLocateId(item)) {
      return (
        <DsButton variant="ghost" size="sm" onClick={() => handleLocateMemory(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:chat.sources.locateMemory')}
        </DsButton>
      );
    }
    if ((item.origin === 'rag' || item.origin === 'multimodal') && canLocateResource(getItemResourceLocator(item))) {
      return (
        <DsButton variant="ghost" size="sm" onClick={() => handleLocateResource(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:chat.sources.locateKb')}
        </DsButton>
      );
    }
    if (item.link && isHttpUrl(item.link)) {
      return (
        <DsButton variant="ghost" size="sm" onClick={() => handleOpenLink(item)} className={btnClass}>
          <ArrowSquareOut size={iconSize} />
          {t('common:actions.open')}
        </DsButton>
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
  }, [open, isExpanded, activeCategory]);

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
      .map(origin => groupLabelOf(origin))
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

  // 骨架与真卡同结构同尺寸（标题行 + 两行摘要 + 底部操作行），防止加载完成时 CLS
  const renderSkeletonCards = (count: number, fullWidth = false) => (
    Array.from({ length: count }).map((_, i) => (
      <div
        key={`usp-skeleton-${i}`}
        className={cn(
          'usp-skeleton-card rounded-xl border border-border/50 bg-card p-2.5',
          fullWidth ? 'w-full' : 'w-56 flex-shrink-0'
        )}
        aria-hidden
      >
        <div className="flex items-center gap-2 mb-1.5">
          <Skeleton className="w-5 h-5 rounded-full" />
          <Skeleton className="h-3.5 w-28" />
        </div>
        <div className="h-8 mb-1.5">
          <Skeleton className="h-3 w-full mb-1.5" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <div className="flex items-center justify-between pt-1.5 border-t border-border/50">
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5 w-10" />
        </div>
      </div>
    ))
  );

  /** 桌面端来源卡片（多模态走 MultimodalSourceCard，其余走通用卡） */
  const renderSourceCard = (
    entry: Extract<FlatEntry, { type: 'item' }>,
    expandedMode: boolean,
    seqIndex: number
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
          onClick={toggleDetail}
          className={cn('usp-card-in cursor-pointer', detailItemId === entry.item.id && 'usp-card-active')}
          style={staggerStyle(seqIndex)}
        />
      );
    }

    const snippetText = sanitizeSnippet(entry.item.snippet);
    const domain = extractDomain(entry.item.link);

    return (
      <div
        ref={registerCardRef(entry.item.id)}
        className={cn(
          'usp-item-card usp-card-in group',
          !expandedMode && 'w-56 flex-shrink-0',
          isHighlighted && 'usp-citation-pulse',
          detailItemId === entry.item.id && 'usp-card-active'
        )}
        style={staggerStyle(seqIndex)}
        key={entry.key}
        onClick={(e) => handleCardSurfaceClick(e, entry.item)}
        onKeyDown={(e) => handleCardSurfaceKeyDown(e, entry.item)}
        role="button"
        tabIndex={0}
        aria-expanded={detailItemId === entry.item.id}
        aria-controls={detailAreaId}
      >
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 overflow-hidden">
            {/* 来源编号徽章（类型内序号，与 [类型-N] 契约一致） */}
            <span className="usp-item-badge">{entry.displayNumber}</span>
            <span className="usp-card-icon shrink-0">{groupIcon(entry.item.origin, 15)}</span>
            <span className="usp-card-title text-sm font-medium truncate" title={entry.item.title}>
              {entry.item.title}
            </span>
          </div>
          {renderScore(entry.item)}
        </div>
        <div className="text-xs text-muted-foreground line-clamp-2 mb-1.5 min-h-8">
          {snippetText}
        </div>
        <div className="flex items-center justify-between gap-2 mt-auto pt-1.5 border-t border-border/50">
          <span
            className="usp-card-meta truncate"
            title={domain ?? undefined}
          >
            {domain ?? groupLabelOf(entry.item.origin)}
          </span>
          {renderItemAction(entry.item, true)}
        </div>
      </div>
    );
  };

  /**
   * 渲染扁平条目列表（provider header + 来源卡），并为卡片分配 stagger 序号。
   * seqIndex 只数卡片，header 不占位，保证入场节奏均匀。
   */
  const renderEntryCards = (entries: FlatEntry[], expandedMode: boolean) => {
    let seq = 0;
    return entries.map(entry => {
      if (entry.type === 'header') {
        return renderProviderHeader(entry, expandedMode);
      }
      return renderSourceCard(entry, expandedMode, seq++);
    });
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
          className="usp-provider-header flex items-center gap-2 text-xs font-medium text-muted-foreground pt-1"
          style={{ gridColumn: '1 / -1' }}
        >
          <span className="truncate">{entry.label}</span>
          {entry.count != null && <span className="usp-provider-count">{entry.count}</span>}
          <span className="usp-provider-rule" aria-hidden />
        </div>
      );
    }
    return (
      <div key={entry.key} className="usp-provider-divider" role="presentation" title={entry.label}>
        <span className="usp-provider-divider-label">{entry.label}</span>
      </div>
    );
  };

  /** 卡片内联详情：点击卡片在面板内展开完整 snippet，随消息流滚动（桌面/移动共用） */
  const renderInlineDetail = () => {
    if (!detailItem) return null;
    const detailDomain = extractDomain(detailItem.link);
    return (
      <div
        key={detailItem.id}
        id={detailAreaId}
        className="usp-inline-detail rounded-xl border border-primary/30 bg-card p-3 flex flex-col text-sm"
        role="region"
        aria-label={detailItem.title}
      >
        <div className="font-semibold mb-2 flex items-center gap-2 border-b pb-2 shrink-0">
          {groupIcon(detailItem.origin)}
          <span className="truncate flex-1" title={detailItem.title}>{detailItem.title}</span>
          {renderScore(detailItem)}
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="!h-6 !w-6 shrink-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            onClick={closeDetail}
            aria-label={t('common:actions.close')}
          >
            <X size={14} />
          </DsButton>
        </div>
        {detailItem.origin === 'multimodal' && (
          <SourceThumb item={detailItem} className="w-full h-32 mb-2 shrink-0" iconSize={20} />
        )}
        <CustomScrollArea
          className="max-h-60 min-h-0"
          viewportClassName="max-h-60"
          fullHeight={false}
          hideTrackWhenIdle={false}
        >
          <div className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
            {detailItem.snippet || t('common:chat.sources.multimodal.noSnippet')}
          </div>
        </CustomScrollArea>
        <div className="flex items-center justify-between gap-2 pt-2 mt-2 border-t border-border/50 shrink-0">
          <span className="usp-card-meta truncate" title={detailDomain ?? undefined}>
            {detailDomain ?? groupLabelOf(detailItem.origin)}
          </span>
          {renderItemAction(detailItem, true)}
        </div>
      </div>
    );
  };

  // ========== 移动端：inline 折叠 + 垂直/水平列表 ==========

  const renderMobileSourceItem = (entry: Extract<FlatEntry, { type: 'item' }>, seqIndex: number) => {
    const isHighlighted = localHighlightId === entry.item.id;
    const domain = extractDomain(entry.item.link);

    return (
      <div
        key={entry.key}
        ref={registerCardRef(entry.item.id)}
        // 点击整卡展开内联详情（与桌面对齐；内部按钮/链接不触发）
        onClick={(e) => handleCardSurfaceClick(e, entry.item)}
        onKeyDown={(e) => handleCardSurfaceKeyDown(e, entry.item)}
        role="button"
        tabIndex={0}
        aria-expanded={detailItemId === entry.item.id}
        aria-controls={detailAreaId}
        className={cn(
          'usp-item-card usp-card-in !p-3',
          isHighlighted && 'usp-citation-pulse',
          detailItemId === entry.item.id && 'usp-card-active'
        )}
        style={staggerStyle(seqIndex)}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="usp-item-badge usp-item-badge-lg">{entry.displayNumber}</span>
          <span className="usp-card-icon">{groupIcon(entry.item.origin)}</span>
          <span className="usp-card-title font-medium truncate flex-1">{entry.item.title}</span>
          {renderScore(entry.item)}
        </div>
        <div className="flex items-start gap-2 mb-2">
          {entry.item.origin === 'multimodal' && (
            <SourceThumb item={entry.item} className="w-12 h-12 flex-shrink-0" />
          )}
          <div className="text-sm text-muted-foreground line-clamp-3 flex-1 min-w-0">
            {sanitizeSnippet(entry.item.snippet)}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
          <span className="usp-card-meta truncate" title={domain ?? undefined}>
            {domain ?? groupLabelOf(entry.item.origin)}
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
          <DsButton
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
          </DsButton>
          {renderRetrievingChip()}
        </div>

        {/* 可折叠的内容区 */}
        <div
          ref={collapseWrapperRef}
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
                        <DsButton
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
                        </DsButton>
                      );
                    })}
                    {/* 展开/收起按钮 → 移动端契约：不用底部抽屉，改为消息流内 inline 垂直展开 */}
                    {totalItemsInCategory > 2 && (
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="usp-expand-btn ml-auto"
                        onClick={() => setIsExpanded(prev => !prev)}
                        title={isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}
                      >
                        {isExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                        <span>{isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}</span>
                      </DsButton>
                    )}
                  </div>
                )}

                {isExpanded ? (
                  /* 展开态：inline 网格（窄屏单列，稍宽自动双列；含分组标题 + 分页懒挂载） */
                  <div className="usp-sources-wrapper">
                    <div className="usp-grid py-1" key={`m-grid-${activeCategory}`} role="list">
                      {expandedEntries.length === 0 && !isRetrieving && (
                        <div className="usp-empty w-full text-center py-4" style={{ gridColumn: '1 / -1' }}>
                          {t('common:chat.sources.empty')}
                        </div>
                      )}
                      {(() => {
                        let seq = 0;
                        return expandedEntries.map(entry => {
                          if (entry.type === 'header') {
                            return (
                              <div
                                key={entry.key}
                                className="usp-provider-header flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider pt-2"
                                style={{ gridColumn: '1 / -1' }}
                              >
                                <span className="truncate">{entry.label}</span>
                                <span className="usp-provider-rule" aria-hidden />
                              </div>
                            );
                          }
                          return renderMobileSourceItem(entry, seq++);
                        });
                      })()}
                      {isRetrieving && renderSkeletonCards(2, true)}
                      {expandedRemaining > 0 && (
                        <div className="flex justify-center" style={{ gridColumn: '1 / -1' }}>
                          <DsButton
                            variant="ghost"
                            size="sm"
                            className="usp-load-more"
                            onClick={() => setVisibleCount(c => c + EXPANDED_PAGE_SIZE)}
                          >
                            {t('chatV2:sourcePanel.loadMore', { count: expandedRemaining })}
                          </DsButton>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                /* 收起态：来源卡片水平滚动列表 */
                <div className="usp-sources-wrapper relative">
                  {/* 左翻页按钮 */}
                  {canScrollLeft && (
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="usp-scroll-btn usp-scroll-left absolute left-0 top-1/2 z-10 !h-11 !w-11 -translate-y-1/2 rounded-full border bg-background/90 shadow-md"
                      onClick={() => scrollByAmount('left')}
                      aria-label={t('common:actions.scrollLeft')}
                    >
                      <CaretLeft size={16} />
                    </DsButton>
                  )}

                  {/* 右翻页按钮 */}
                  {canScrollRight && (
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="usp-scroll-btn usp-scroll-right absolute right-0 top-1/2 z-10 !h-11 !w-11 -translate-y-1/2 rounded-full border bg-background/90 shadow-md"
                      onClick={() => scrollByAmount('right')}
                      aria-label={t('common:actions.scrollRight')}
                    >
                      <CaretRight size={16} />
                    </DsButton>
                  )}

                  <CustomScrollArea
                    orientation="horizontal"
                    viewportRef={scrollContainerRef}
                    viewportClassName="py-1"
                    className="w-full"
                  >
                    {/* 布局包装元素必须由本组件持有：OverlayScrollbars 会把 children
                        包进自己的 contents 元素，viewportClassName 的 flex/grid 到不了卡片层 */}
                    <div className="usp-carousel" key={`m-carousel-${activeCategory}`} role="list">
                      {carouselEntries.length === 0 && !isRetrieving && (
                        <div className="usp-empty w-full text-center py-4">{t('common:chat.sources.empty')}</div>
                      )}
                      {(() => {
                        let seq = 0;
                        return carouselEntries.map(entry => {
                          if (entry.type === 'header') {
                            return renderProviderHeader(entry, false);
                          }
                          const snippetText = sanitizeSnippet(entry.item.snippet);
                          const isHighlighted = localHighlightId === entry.item.id;
                          const seqIndex = seq++;

                          return (
                            <div
                              ref={registerCardRef(entry.item.id)}
                              // 点击展开内联详情（移动端此前完全没有查看全文的入口）
                              onClick={(e) => handleCardSurfaceClick(e, entry.item)}
                              onKeyDown={(e) => handleCardSurfaceKeyDown(e, entry.item)}
                              className={cn(
                                'usp-item-card usp-card-in w-44 flex-shrink-0 !p-2',
                                isHighlighted && 'usp-citation-pulse',
                                detailItemId === entry.item.id && 'usp-card-active'
                              )}
                              style={staggerStyle(seqIndex)}
                              key={entry.key}
                              role="button"
                              tabIndex={0}
                              aria-expanded={detailItemId === entry.item.id}
                              aria-controls={detailAreaId}
                            >
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="usp-item-badge usp-item-badge-sm">{entry.displayNumber}</span>
                                <span className="usp-card-icon shrink-0">{groupIcon(entry.item.origin, 14)}</span>
                                <span className="usp-card-title text-xs font-medium truncate">{entry.item.title}</span>
                              </div>
                              {entry.item.origin === 'multimodal' && resolveMultimodalImageSrc(entry.item) ? (
                                <div className="flex items-start gap-1.5">
                                  <SourceThumb item={entry.item} className="w-9 h-9 flex-shrink-0" iconSize={14} />
                                  <div className="text-2xs text-muted-foreground line-clamp-2 min-h-6 flex-1 min-w-0">
                                    {snippetText}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-2xs text-muted-foreground line-clamp-2 min-h-6">
                                  {snippetText}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                      {isRetrieving && renderSkeletonCards(2)}
                      {carouselOverflow > 0 && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          className="usp-more-card w-28 flex-shrink-0 rounded-xl border border-dashed !h-auto self-stretch text-xs text-muted-foreground"
                          onClick={() => setIsExpanded(true)}
                        >
                          {t('chatV2:sourcePanel.showAllCard', { count: totalItemsInCategory })}
                        </DsButton>
                      )}
                    </div>
                  </CustomScrollArea>
                </div>
                )}

                {/* 卡片内联详情：移动端与桌面同一能力（点击卡片查看完整 snippet） */}
                {renderInlineDetail()}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ========== 桌面端：折叠面板 + 轮播/展开网格 + 卡片内联详情 ==========
  return (
    <div
      ref={panelRef}
      className={cn('unified-source-panel', !open && 'collapsed', className)}
      data-testid="unified-source-panel"
    >
      <div className="usp-header">
        <DsButton
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
        </DsButton>
        {renderRetrievingChip()}
        {data.stage && (
          <span className="usp-header-stage">{data.stage}</span>
        )}
      </div>

      <div
        ref={collapseWrapperRef}
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
                      <DsButton
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
                      </DsButton>
                    );
                  })}
                  {/* 展开/收起按钮 */}
                  {totalItemsInCategory > 3 && (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="usp-expand-btn ml-auto"
                      onClick={() => setIsExpanded(prev => !prev)}
                      title={isExpanded ? t('common:actions.collapse') : t('common:actions.expand')}
                    >
                      {isExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                      <span>{isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}</span>
                    </DsButton>
                  )}
                </div>
              )}

              {/* 来源列表容器 */}
              <div className="usp-sources-wrapper relative">
                {/* 左翻页按钮 */}
                {!isExpanded && canScrollLeft && (
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="usp-scroll-btn usp-scroll-left absolute left-0 top-1/2 -translate-y-1/2 z-10 !w-8 !h-8 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 rounded-full bg-background/90 border shadow-md"
                    onClick={() => scrollByAmount('left')}
                    aria-label={t('common:actions.scrollLeft')}
                  >
                    <CaretLeft size={18} />
                  </DsButton>
                )}

                {/* 右翻页按钮 */}
                {!isExpanded && canScrollRight && (
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="usp-scroll-btn usp-scroll-right absolute right-0 top-1/2 -translate-y-1/2 z-10 !w-8 !h-8 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 rounded-full bg-background/90 border shadow-md"
                    onClick={() => scrollByAmount('right')}
                    aria-label={t('common:actions.scrollRight')}
                  >
                    <CaretRight size={18} />
                  </DsButton>
                )}

                {isExpanded ? (
                  /* 展开态：双列/三列自适应网格（随面板宽度在 1~3 列间流动），随消息流滚动 */
                  <div className="usp-grid py-1" key={`grid-${activeCategory}`} role="list">
                    {totalItemsInCategory === 0 && !isRetrieving && (
                      <div className="usp-empty w-full text-center py-4" style={{ gridColumn: '1 / -1' }}>
                        {t('common:chat.sources.empty')}
                      </div>
                    )}

                    {renderEntryCards(expandedEntries, true)}

                    {isRetrieving && renderSkeletonCards(hasItems ? 2 : 3, true)}

                    {/* 展开网格：分页加载更多 */}
                    {expandedRemaining > 0 && (
                      <div className="flex justify-center py-1" style={{ gridColumn: '1 / -1' }}>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          className="usp-load-more"
                          onClick={() => setVisibleCount(c => c + EXPANDED_PAGE_SIZE)}
                        >
                          {t('chatV2:sourcePanel.loadMore', { count: expandedRemaining })}
                        </DsButton>
                      </div>
                    )}
                  </div>
                ) : (
                  <CustomScrollArea
                    orientation="horizontal"
                    viewportRef={scrollContainerRef}
                    viewportClassName="py-1 w-full"
                    className="w-full"
                  >
                    {/* 布局包装元素必须由本组件持有：OverlayScrollbars 会把 children
                        包进自己的 contents 元素，viewportClassName 的 flex/grid 到不了卡片层 */}
                    <div className="usp-carousel" key={`carousel-${activeCategory}`} role="list">
                      {totalItemsInCategory === 0 && !isRetrieving && (
                        <div className="usp-empty w-full text-center py-4">
                          {t('common:chat.sources.empty')}
                        </div>
                      )}

                      {renderEntryCards(carouselEntries, false)}

                      {isRetrieving && renderSkeletonCards(hasItems ? 2 : 3, false)}

                      {/* 轮播溢出：查看全部卡 */}
                      {carouselOverflow > 0 && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          className="usp-more-card w-32 flex-shrink-0 rounded-xl border border-dashed !h-auto self-stretch text-xs text-muted-foreground"
                          onClick={() => setIsExpanded(true)}
                        >
                          {t('chatV2:sourcePanel.showAllCard', { count: totalItemsInCategory })}
                        </DsButton>
                      )}
                    </div>
                  </CustomScrollArea>
                )}
              </div>

              {/* 卡片内联详情：点击卡片在面板内展开完整 snippet，随消息流滚动 */}
              {renderInlineDetail()}
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
