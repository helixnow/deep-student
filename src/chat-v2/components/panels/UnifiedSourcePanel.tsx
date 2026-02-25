import React, { useEffect, useMemo, useState, useId, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Search, BookOpen, Brain, Hammer, ChevronRight, ChevronLeft, ExternalLink, Image, Maximize2, Minimize2 } from 'lucide-react';
import type { UnifiedSourceBundle, UnifiedSourceGroup, UnifiedSourceItem } from './sourceTypes';
import { cn } from '@/utils/cn';
import { Z_INDEX } from '@/config/zIndex';
import { openUrl } from '@/utils/urlOpener';
import { citationEvents, type CitationHighlightEvent } from '../../utils/citationEvents';
import type { RetrievalSourceType } from '../../plugins/blocks/components/types';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { setPendingMemoryLocate } from '@/utils/pendingMemoryLocate';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/shad/Sheet';
import { getReadableToolName } from '@/chat-v2/utils/toolDisplayName';
import './UnifiedSourcePanel.css';

// 来源类型映射到引用类型（与 citationParser 保持一致）
const ORIGIN_TO_CITATION_TYPE: Record<string, string> = {
  rag: 'rag',
  memory: 'memory',
  web_search: 'web_search',
  multimodal: 'multimodal',
};

interface UnifiedSourcePanelProps {
  data: UnifiedSourceBundle;
  className?: string;
  /** 高亮的来源索引（从引用标记点击触发） */
  highlightedSourceIndex?: number;
  /** 高亮清除回调 */
  onHighlightClear?: () => void;
}

type CategoryKey = 'rag' | 'memory' | 'web_search' | 'tool' | 'multimodal' | string;
const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const SNIPPET_MAX_LENGTH = 220;
const LINK_LABEL_MAX_LENGTH = 48;

function groupIcon(group: CategoryKey) {
  switch (group) {
    case 'memory':
      return <Brain size={16} />;
    case 'web_search':
      return <Search size={16} />;
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

const UnifiedSourcePanel: React.FC<UnifiedSourcePanelProps> = ({ 
  data, 
  className,
  highlightedSourceIndex,
  onHighlightClear,
}) => {
  const { t } = useTranslation(['common']);
  const groups = data?.groups || [];
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
  const [hoveredItem, setHoveredItem] = useState<UnifiedSourceItem | null>(null);
  const [previewPos, setPreviewPos] = useState<DOMRect | null>(null);
  const [localHighlight, setLocalHighlight] = useState<number | null>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

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

  const handleItemMouseEnter = (e: React.MouseEvent, item: UnifiedSourceItem) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoveredItem(item);
    setPreviewPos(rect);
  };

  const handleItemMouseLeave = () => {
    setHoveredItem(null);
    setPreviewPos(null);
  };

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

  // 计算所有来源的全局索引（用于引用编号）- 必须在高亮 useEffect 之前定义
  const allSourcesWithIndex = useMemo(() => {
    const result: Array<{ item: UnifiedSourceItem; globalIndex: number; categoryType: string }> = [];
    let globalIdx = 0;
    
    // 按类别优先级排序后遍历
    const sortedCategories = [...categories].sort((a, b) => {
      const pa = CATEGORY_PRIORITY[a.group] ?? 10;
      const pb = CATEGORY_PRIORITY[b.group] ?? 10;
      return pa - pb;
    });
    
    sortedCategories.forEach(category => {
      category.providers.forEach(provider => {
        (provider.items || []).forEach(item => {
          result.push({
            item,
            globalIndex: globalIdx++,
            categoryType: ORIGIN_TO_CITATION_TYPE[category.group] || category.group,
          });
        });
      });
    });
    
    return result;
  }, [categories]);

  // 🆕 根据来源类型和类型内索引计算全局索引
  const calculateGlobalIndexFromCitation = useCallback((type: RetrievalSourceType, typeIndex: number): number => {
    // 找到该类型在 allSourcesWithIndex 中的第 typeIndex 个项目
    let count = 0;
    for (const source of allSourcesWithIndex) {
      if (source.categoryType === type) {
        count++;
        if (count === typeIndex) {
          return source.globalIndex;
        }
      }
    }
    return -1;
  }, [allSourcesWithIndex]);

  // 🆕 监听引用点击事件
  useEffect(() => {
    // 🔧 P0 修复：使用 ref 存储定时器，确保组件卸载时清理
    const timers: { scroll?: ReturnType<typeof setTimeout>; clear?: ReturnType<typeof setTimeout> } = {};
    
    const handleCitationEvent = (event: CitationHighlightEvent) => {
      const globalIndex = calculateGlobalIndexFromCitation(event.type, event.index);
      if (globalIndex >= 0) {
        // 清理之前的定时器（防止快速点击时定时器堆积）
        if (timers.scroll) clearTimeout(timers.scroll);
        if (timers.clear) clearTimeout(timers.clear);
        
        // 触发高亮
        setOpen(true);
        setLocalHighlight(globalIndex);
        
        // 找到对应的类别并切换
        const sourceInfo = allSourcesWithIndex.find(s => s.globalIndex === globalIndex);
        if (sourceInfo) {
          const categoryKey = Object.entries(ORIGIN_TO_CITATION_TYPE)
            .find(([_, v]) => v === sourceInfo.categoryType)?.[0] || sourceInfo.item.origin;
          
          if (categoryKey && categories.some(c => c.group === categoryKey)) {
            setActiveCategory(categoryKey);
          }
        }
        
        // 延迟滚动到卡片位置
        timers.scroll = setTimeout(() => {
          const card = cardRefs.current.get(globalIndex);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        }, 150);
        
        // 2秒后清除高亮
        timers.clear = setTimeout(() => {
          setLocalHighlight(null);
        }, 2000);
      }
    };

    const unsubscribe = citationEvents.subscribe(handleCitationEvent);
    return () => {
      unsubscribe();
      // 🔧 清理所有定时器
      if (timers.scroll) clearTimeout(timers.scroll);
      if (timers.clear) clearTimeout(timers.clear);
    };
  }, [calculateGlobalIndexFromCitation, allSourcesWithIndex, categories]);

  // 处理外部高亮定位请求
  useEffect(() => {
    if (highlightedSourceIndex === undefined || highlightedSourceIndex === null) {
      return;
    }

    // 1. 展开面板
    setOpen(true);
    
    // 2. 设置本地高亮状态
    setLocalHighlight(highlightedSourceIndex);

    // 3. 找到对应的来源并切换到正确的类别
    const sourceInfo = allSourcesWithIndex.find(s => s.globalIndex === highlightedSourceIndex);
    if (sourceInfo) {
      // 找到该来源所属的类别
      const categoryKey = Object.entries(ORIGIN_TO_CITATION_TYPE)
        .find(([_, v]) => v === sourceInfo.categoryType)?.[0] || sourceInfo.item.origin;
      
      if (categoryKey && categories.some(c => c.group === categoryKey)) {
        setActiveCategory(categoryKey);
      }
    }

    // 4. 延迟滚动到卡片位置（等待 DOM 更新）
    const scrollTimer = setTimeout(() => {
      const card = cardRefs.current.get(highlightedSourceIndex);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, 150);

    // 5. 2 秒后清除高亮
    const clearTimer = setTimeout(() => {
      setLocalHighlight(null);
      onHighlightClear?.();
    }, 2000);

    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [highlightedSourceIndex, allSourcesWithIndex, categories, onHighlightClear]);

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

  const flatEntries = useMemo(() => {
    const entries: Array<
      | { type: 'header'; key: string; label: string; count?: number }
      | { type: 'item'; key: string; item: UnifiedSourceItem; globalIndex: number }
    > = [];

    activeCategoryProviders.forEach((provider, index) => {
      const displayLabel = resolveProviderLabel(provider.providerLabel, provider.providerId);
      const shouldShowHeader = activeCategoryProviders.length > 1 || !!displayLabel;
      if (shouldShowHeader && displayLabel) {
        entries.push({
          type: 'header',
          key: `header-${provider.providerId}-${index}`,
          label: displayLabel,
          count: provider.count,
        });
      }

      (provider.items || []).forEach((item, itemIndex) => {
        // 查找全局索引
        const globalInfo = allSourcesWithIndex.find(s => s.item.id === item.id);
        entries.push({
          type: 'item',
          key: `${provider.providerId || 'provider'}-${item.id}-${itemIndex}`,
          item,
          globalIndex: globalInfo?.globalIndex ?? itemIndex,
        });
      });
    });

    return entries;
  }, [activeCategoryProviders, allSourcesWithIndex, resolveProviderLabel]);

  // 监听滚动状态（必须在 flatEntries 定义之后）
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
  }, [checkScrollability, isExpanded, flatEntries]);

  const totalLabel = useMemo(() => {
    return t('common:chat.sources.total', { count: data?.total ?? 0 });
  }, [t, data?.total]);

  if (!groups.length) {
    return null;
  }

  const handleOpenLink = (item: UnifiedSourceItem) => {
    if (item.link && isHttpUrl(item.link)) {
      openUrl(item.link);
    }
  };

  const handleLocateGraph = (item: UnifiedSourceItem) => {
    const cardId = (item.raw as any)?.source_id || item.raw.document_id;
    if (!cardId) return;
    try {
      window.dispatchEvent(new CustomEvent('DSTU_LOCATE_GRAPH_CARD' as any, { detail: { cardId } }));
    } catch (error: unknown) {
      console.error('[UnifiedSourcePanel] Failed to dispatch graph locate event:', error);
    }
  };

  const getMemoryLocateId = (item: UnifiedSourceItem): string => {
    return item.sourceId || item.raw?.source_id || item.raw?.document_id || '';
  };

  const handleLocateMemory = (item: UnifiedSourceItem) => {
    const memoryId = getMemoryLocateId(item);
    if (!memoryId) return;
    try {
      setPendingMemoryLocate(memoryId);
      window.dispatchEvent(new CustomEvent('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE' as any, {
        detail: { preferTab: 'memory', memoryId }
      }));
    } catch (error: unknown) {
      console.error('[UnifiedSourcePanel] Failed to dispatch memory navigate event:', error);
    }
  };

  // 🔧 P1-34: 跳转到知识库文档并高亮
  const handleLocateRagDocument = (item: UnifiedSourceItem) => {
    // ★ 2026-01-22: 优先使用 sourceId（DSTU 资源 ID 如 tb_xxx），回退到 resourceId（VFS 资源 ID 如 res_xxx）
    // sourceId 是可以直接打开的上层资源 ID，resourceId 是底层存储 ID
    const documentId = item.sourceId || item.resourceId || item.raw.source_id || item.raw.document_id;
    const fileName = item.raw.file_name;
    const resourceType = item.resourceType;
    if (!documentId) return;
    try {
      window.dispatchEvent(new CustomEvent('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE' as any, {
        detail: { documentId, fileName, resourceType, preferTab: 'manage' }
      }));
    } catch (error: unknown) {
      console.error('[UnifiedSourcePanel] Failed to dispatch knowledge base locate event:', error);
    }
  };

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

  // 移动端：渲染来源列表项（垂直布局）
  const renderMobileSourceItem = (entry: { type: 'item'; key: string; item: UnifiedSourceItem; globalIndex: number }) => {
    const isHighlighted = localHighlight === entry.globalIndex;
    const displayNumber = entry.globalIndex + 1;

    return (
      <div
        key={entry.key}
        ref={(el) => {
          if (el) cardRefs.current.set(entry.globalIndex, el);
          else cardRefs.current.delete(entry.globalIndex);
        }}
        className={cn(
          'p-3 rounded-lg border bg-card hover:bg-accent/50 transition-all',
          isHighlighted && 'ring-1 ring-primary/30'
        )}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-sm font-semibold">
            {displayNumber}
          </span>
          <span className="text-muted-foreground">{groupIcon(entry.item.origin)}</span>
          <span className="font-medium truncate flex-1">{entry.item.title}</span>
          {renderScore(entry.item)}
        </div>
        <div className="text-sm text-muted-foreground mb-2 line-clamp-3">
          {entry.item.snippet}
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground uppercase tracking-wider opacity-70">{entry.item.origin}</span>
          {entry.item.origin === 'graph' ? (
            <NotionButton variant="ghost" size="sm" onClick={() => handleLocateGraph(entry.item)} className="text-primary">
              <ExternalLink size={14} />
              {t('common:chat.sources.locateGraph')}
            </NotionButton>
          ) : entry.item.origin === 'memory' && getMemoryLocateId(entry.item) ? (
            <NotionButton variant="ghost" size="sm" onClick={() => handleLocateMemory(entry.item)} className="text-primary">
              <ExternalLink size={14} />
              {t('common:chat.sources.locateMemory')}
            </NotionButton>
          ) : entry.item.origin === 'rag' && entry.item.raw?.document_id ? (
            <NotionButton variant="ghost" size="sm" onClick={() => handleLocateRagDocument(entry.item)} className="text-primary">
              <ExternalLink size={14} />
              {t('common:chat.sources.locateKb')}
            </NotionButton>
          ) : entry.item.link && isHttpUrl(entry.item.link) ? (
            <NotionButton variant="ghost" size="sm" onClick={() => handleOpenLink(entry.item)} className="text-primary">
              <ExternalLink size={14} />
              {t('common:actions.open')}
            </NotionButton>
          ) : null}
        </div>
      </div>
    );
  };

  // 移动端：缩略卡片 + 底部抽屉模式
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
            <Search size={16} className="panel-header-icon" />
            <span className="usp-header-title">{totalLabel}</span>
            <ChevronRight size={16} className={cn('usp-header-arrow', open && 'expanded')} />
          </NotionButton>
        </div>

        {/* 可折叠的内容区 */}
        <div
          className={cn(
            'usp-collapse-wrapper grid w-full transition-all duration-300 ease-in-out',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
          )}
          aria-hidden={!open}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="usp-container">
              <div className="usp-body relative">
                {/* 分类标签 */}
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
                  {/* 展开按钮 → 打开抽屉 */}
                  {flatEntries.filter(e => e.type === 'item').length > 2 && (
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="usp-expand-btn ml-auto"
                      onClick={() => setIsExpanded(true)}
                      title={t('common:actions.expandAll')}
                    >
                      <Maximize2 size={14} />
                      <span>{t('common:actions.expandAll')}</span>
                    </NotionButton>
                  )}
                </div>

                {/* 来源卡片水平滚动列表 */}
                <div className="usp-sources-wrapper relative">
                  {/* 左翻页按钮 */}
                  {canScrollLeft && (
                    <NotionButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="usp-scroll-btn usp-scroll-left absolute left-0 top-1/2 -translate-y-1/2 z-10 !w-7 !h-7 rounded-full bg-background/90 border shadow-md"
                      onClick={() => scrollByAmount('left')}
                      aria-label="scroll left"
                    >
                      <ChevronLeft size={16} />
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
                      aria-label="scroll right"
                    >
                      <ChevronRight size={16} />
                    </NotionButton>
                  )}

                  <div
                    ref={scrollContainerRef}
                    className="flex gap-2 py-1 overflow-x-auto no-scrollbar"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                    role="list"
                  >
                    {flatEntries.length === 0 && (
                      <div className="usp-empty w-full text-center py-4">{t('common:chat.sources.empty')}</div>
                    )}
                    {flatEntries.map(entry => {
                      if (entry.type === 'header') return null;
                      const snippetText = sanitizeSnippet(entry.item.snippet);
                      const isHighlighted = localHighlight === entry.globalIndex;
                      const displayNumber = entry.globalIndex + 1;

                      return (
                        <div
                          ref={(el) => {
                            if (el) cardRefs.current.set(entry.globalIndex, el);
                            else cardRefs.current.delete(entry.globalIndex);
                          }}
                          className={cn(
                            'usp-item-card w-44 flex-shrink-0 rounded-lg border bg-card p-2 transition-all cursor-default',
                            isHighlighted && 'shadow-[inset_0_0_0_2px_hsl(var(--primary))]'
                          )}
                          key={entry.key}
                          role="listitem"
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-semibold">
                              {displayNumber}
                            </span>
                            <span className="text-muted-foreground shrink-0">{groupIcon(entry.item.origin)}</span>
                            <span className="text-xs font-medium truncate">{entry.item.title}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground line-clamp-2 h-6">
                            {snippetText}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 底部抽屉 - 展开全部来源 */}
        <Sheet open={isExpanded} onOpenChange={setIsExpanded}>
          <SheetContent 
            side="bottom" 
            className="h-[80vh] flex flex-col p-0 rounded-t-2xl"
            hideCloseButton
          >
            {/* 拖动指示器 */}
            <div className="flex justify-center py-2 cursor-grab active:cursor-grabbing">
              <div className="w-12 h-1 rounded-full bg-muted-foreground/30" />
            </div>

            {/* 抽屉头部 */}
            <SheetHeader className="px-4 pb-3 border-b">
              <SheetTitle className="flex items-center gap-2 text-base">
                <Search size={18} />
                {totalLabel}
              </SheetTitle>
            </SheetHeader>

            {/* 分类切换 */}
            <div className="flex gap-2 px-4 py-2 overflow-x-auto border-b bg-muted/30">
              {categories.map(category => {
                const isActive = category.group === activeCategory;
                const label = t(`common:chat.sources.groupLabels.${category.group}`, { defaultValue: category.group });
                return (
                  <NotionButton
                    key={`category-${category.group}`}
                    variant={isActive ? 'primary' : 'outline'}
                    size="sm"
                    className="rounded-full whitespace-nowrap"
                    onClick={() => setActiveCategory(category.group)}
                  >
                    <span className="opacity-80">{groupIcon(category.group)}</span>
                    <span>{label}</span>
                    <span className={cn(
                      'px-1.5 py-0.5 rounded-full text-xs',
                      isActive ? 'bg-primary-foreground/20' : 'bg-muted'
                    )}>
                      {category.count}
                    </span>
                  </NotionButton>
                );
              })}
            </div>

            {/* 来源列表（垂直滚动 - 使用自研滚动条） */}
            <CustomScrollArea className="flex-1" viewportClassName="p-4">
              <div className="space-y-3">
                {flatEntries.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    {t('common:chat.sources.empty')}
                  </div>
                )}
                {flatEntries.map(entry => {
                  if (entry.type === 'header') {
                    return (
                      <div key={entry.key} className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-2">
                        {entry.label}
                      </div>
                    );
                  }
                  return renderMobileSourceItem(entry);
                })}
              </div>
            </CustomScrollArea>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  // 桌面端：原有折叠面板模式
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
          <Search size={16} className="panel-header-icon" />
          <span className="usp-header-title">{totalLabel}</span>
          <ChevronRight size={16} className={cn('usp-header-arrow', open && 'expanded')} />
        </NotionButton>
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
                {flatEntries.filter(e => e.type === 'item').length > 3 && (
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    className="usp-expand-btn ml-auto"
                    onClick={() => setIsExpanded(prev => !prev)}
                    title={isExpanded ? t('common:actions.collapse') : t('common:actions.expand')}
                  >
                    {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    <span>{isExpanded ? t('common:actions.collapse') : t('common:actions.expandAll')}</span>
                  </NotionButton>
                )}
              </div>

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
                    <ChevronLeft size={18} />
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
                    <ChevronRight size={18} />
                  </NotionButton>
                )}

                <div
                  ref={scrollContainerRef}
                  className={cn(
                    'py-1 w-full',
                    isExpanded 
                      ? 'grid gap-2' 
                      : 'flex gap-2 overflow-x-auto no-scrollbar'
                  )}
                  style={isExpanded 
                    ? { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } 
                    : { scrollbarWidth: 'none', msOverflowStyle: 'none' }
                  }
                  role="list"
                >
                  <style>{`
                    .no-scrollbar::-webkit-scrollbar {
                      display: none;
                    }
                  `}</style>
                  {flatEntries.length === 0 && (
                    <div className="usp-empty w-full text-center py-4">{t('common:chat.sources.empty')}</div>
                  )}

                {flatEntries.map(entry => {
                  if (entry.type === 'header') {
                    return null; // Skip headers in carousel mode
                  }

                  const snippetText = sanitizeSnippet(entry.item.snippet);
                  const isHighlighted = localHighlight === entry.globalIndex;
                  const displayNumber = entry.globalIndex + 1; // 1-indexed for display

                  return (
                    <div
                      ref={(el) => {
                        if (el) cardRefs.current.set(entry.globalIndex, el);
                        else cardRefs.current.delete(entry.globalIndex);
                      }}
                      id={`source-card-${entry.globalIndex}`}
                      data-source-index={entry.globalIndex}
                      className={cn(
                        'usp-item-card rounded-lg border bg-card p-2.5 hover:bg-accent/50 transition-all cursor-default group',
                        !isExpanded && 'w-56 flex-shrink-0',
                        isHighlighted && 'shadow-[inset_0_0_0_2px_hsl(var(--primary)),0_10px_15px_-3px_rgb(0_0_0/0.1)]'
                      )}
                      key={entry.key}
                      role="listitem"
                      onMouseEnter={(e) => handleItemMouseEnter(e, entry.item)}
                      onMouseLeave={handleItemMouseLeave}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 overflow-hidden">
                          {/* 来源编号徽章 */}
                          <span className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold">
                            {displayNumber}
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
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider opacity-70">{entry.item.origin}</span>
                        {entry.item.origin === 'graph' ? (
                          <NotionButton variant="ghost" size="sm" onClick={() => handleLocateGraph(entry.item)} className="text-primary !h-6 text-xs">
                            <ExternalLink size={12} />
                            {t('common:chat.sources.locateGraph')}
                          </NotionButton>
                        ) : entry.item.origin === 'memory' && getMemoryLocateId(entry.item) ? (
                          <NotionButton variant="ghost" size="sm" onClick={() => handleLocateMemory(entry.item)} className="text-primary !h-6 text-xs">
                            <ExternalLink size={12} />
                            {t('common:chat.sources.locateMemory')}
                          </NotionButton>
                        ) : entry.item.origin === 'rag' && entry.item.raw?.document_id ? (
                          /* 🔧 P1-34: RAG 来源添加“在知识库中打开”按钮 */
                          <NotionButton variant="ghost" size="sm" onClick={() => handleLocateRagDocument(entry.item)} className="text-primary !h-6 text-xs">
                            <ExternalLink size={12} />
                            {t('common:chat.sources.locateKb')}
                          </NotionButton>
                        ) : entry.item.link && isHttpUrl(entry.item.link) ? (
                          <NotionButton variant="ghost" size="sm" onClick={() => handleOpenLink(entry.item)} className="text-primary !h-6 text-xs">
                            <ExternalLink size={12} />
                            {t('common:actions.open')}
                          </NotionButton>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>

              {/* Hover Preview via Portal */}
              {hoveredItem && previewPos && createPortal(
                (() => {
                  const showBelow = previewPos.top < 320;
                  const top = showBelow ? previewPos.bottom + 10 : previewPos.top - 10;
                  const left = Math.min(window.innerWidth - 340, Math.max(10, previewPos.left));
                  const transform = showBelow ? 'none' : 'translateY(-100%)';

                  return (
                    <div
                      className="fixed w-80 max-h-80 p-4 bg-popover text-popover-foreground rounded-xl shadow-lg ring-1 ring-border/40 border-transparent text-sm pointer-events-none animate-in fade-in zoom-in-95 duration-150 flex flex-col"
                      style={{
                        zIndex: Z_INDEX.toast,
                        top,
                        left,
                        transform
                      }}
                    >
                      <div className="font-semibold mb-2 flex items-center gap-2 border-b pb-2 shrink-0">
                        {groupIcon(hoveredItem.origin)}
                        <span className="truncate">{hoveredItem.title}</span>
                        {renderScore(hoveredItem)}
                      </div>
                      <CustomScrollArea className="flex-1 min-h-0" hideTrackWhenIdle={false}>
                        <div className="text-muted-foreground text-xs leading-relaxed">
                          {hoveredItem.snippet}
                        </div>
                      </CustomScrollArea>
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

function buildLinkLabel(link: string): string {
  try {
    const url = new URL(link);
    const label = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    if (label.length <= LINK_LABEL_MAX_LENGTH) return label;
    return `${label.slice(0, LINK_LABEL_MAX_LENGTH)}…`;
  } catch {
    if (link.length <= LINK_LABEL_MAX_LENGTH) return link;
    return `${link.slice(0, LINK_LABEL_MAX_LENGTH)}…`;
  }
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
