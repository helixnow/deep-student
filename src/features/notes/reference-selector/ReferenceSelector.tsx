/**
 * 引用选择器 —— 锚定内联面板（非模态）
 *
 * 从触发按钮下方展开的 Popover 式浮层（360px），替代原先的 NotionDialog 居中模态：
 * 1. 搜索过滤（单一防抖加载路径，打开即拉取、输入 300ms 防抖）
 * 2. 资源预览（教材封面缩略图，无封面回退类型图标）
 * 3. 单击条目即选中并确认（无二步 Confirm）
 * 4. 列表 role=listbox，↑↓ 移动高亮、Enter 确认、Esc 收起
 * 5. 已被引用的资源显示禁用状态
 * 6. i18n / 亮暗主题 / prefers-reduced-motion（经 .ui-zoom-fade-in）
 *
 * 对外契约：open / onOpenChange / type / onSelect / existingRefs 保持不变；
 * 新增可选 anchorRef 用于锚定触发元素（缺省时回退为顶部居中浮层，仍非模态）。
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, X, BookOpen, Table, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { resolvePopoverPosition, type PopoverPosition } from '@/components/ui/shad/Popover';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Input } from '@/components/ui/shad/Input';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '../../../lib/utils';
import { getErrorMessage } from '../../../utils/errorUtils';
import { listTextbooks, listExamSessions } from './api';
import { ReferenceSelectorItem } from './ReferenceSelectorItem';
import type {
  ReferenceSelectorProps,
  UnifiedResourceItem,
  ReferenceSelectResult,
  TextbookListItem,
  ExamSessionListItem,
} from './types';

const PANEL_WIDTH = 360;
const SEARCH_DEBOUNCE_MS = 300;
const RECENT_STORAGE_PREFIX = 'notes.referenceSelector.recent.';
const RECENT_MAX = 5;

function readRecentIds(type: string): string[] {
  try {
    const raw = window.localStorage.getItem(`${RECENT_STORAGE_PREFIX}${type}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecentId(type: string, id: string): void {
  try {
    const next = [id, ...readRecentIds(type).filter((existing) => existing !== id)].slice(0, RECENT_MAX);
    window.localStorage.setItem(`${RECENT_STORAGE_PREFIX}${type}`, JSON.stringify(next));
  } catch {
    // localStorage 不可用（隐私模式等）：静默降级，无最近分组
  }
}

/**
 * 将教材列表项转换为统一资源项
 */
function textbookToUnified(item: TextbookListItem): UnifiedResourceItem {
  return {
    id: item.id,
    title: item.title,
    updatedAt: item.updatedAt,
    thumbnail: item.coverPath,
    sourceDb: 'textbooks',
    previewType: 'pdf',
  };
}

/**
 * 将题目集会话列表项转换为统一资源项
 * @param item 题目集会话列表项
 * @param fallbackTitle 无 examName 时的回退标题前缀（已国际化）
 */
function examSessionToUnified(
  item: ExamSessionListItem,
  fallbackTitle: string
): UnifiedResourceItem {
  const title = item.examName || `${fallbackTitle} ${item.id.substring(0, 8)}`;
  return {
    id: item.id,
    title,
    updatedAt: item.createdAt,
    thumbnail: undefined,
    sourceDb: 'exam_sessions',
    previewType: 'exam',
  };
}

export const ReferenceSelector: React.FC<ReferenceSelectorProps> = ({
  open,
  onOpenChange,
  type,
  onSelect,
  existingRefs = [],
  anchorRef,
  hint,
}) => {
  const { t } = useTranslation(['notes', 'common']);

  // 状态
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<UnifiedResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [recentIds, setRecentIds] = useState<string[]>([]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  // 单一加载路径：首次打开立即加载，后续搜索输入防抖
  const hasLoadedOnOpenRef = useRef(false);
  // 请求序号防竞态：慢的旧响应不覆盖新响应
  const requestSeqRef = useRef(0);
  const listboxId = useRef(`ref-selector-listbox-${Math.random().toString(36).slice(2, 9)}`).current;

  // 已引用的资源 ID 集合（用于快速查找）
  const existingRefIds = useMemo(() => {
    const sourceDb = type === 'exam_session' ? 'exam_sessions' : 'textbooks';
    return new Set(
      existingRefs
        .filter(ref => ref.sourceDb === sourceDb)
        .map(ref => ref.sourceId)
    );
  }, [existingRefs, type]);

  // 加载数据
  const loadData = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      if (type === 'textbook') {
        const result = await listTextbooks(searchQuery || undefined);
        if (seq !== requestSeqRef.current) return;
        if (!result.ok) {
          setError(result.error.toUserMessage());
          setItems([]);
          return;
        }
        setItems(result.value.map(textbookToUnified));
      } else if (type === 'exam_session') {
        const result = await listExamSessions();
        if (seq !== requestSeqRef.current) return;
        if (!result.ok) {
          setError(result.error.toUserMessage());
          setItems([]);
          return;
        }
        const fallbackTitle = t('notes:reference.examSessionFallbackTitle');
        // 题目集接口不支持服务端搜索，此前 searchQuery 被静默忽略；改为客户端过滤
        const needle = searchQuery.trim().toLocaleLowerCase();
        const mapped = result.value.map(s => examSessionToUnified(s, fallbackTitle));
        setItems(needle
          ? mapped.filter(item => item.title.toLocaleLowerCase().includes(needle))
          : mapped);
      }
    } catch (err: unknown) {
      if (seq !== requestSeqRef.current) return;
      setError(getErrorMessage(err));
      setItems([]);
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [type, searchQuery, t]);

  // 打开时重置状态；关闭时清空搜索（避免重开时旧关键词触发双请求）
  useEffect(() => {
    if (open) {
      setActiveIndex(-1);
      setRecentIds(readRecentIds(type));
    } else {
      hasLoadedOnOpenRef.current = false;
      setSearchQuery('');
      setItems([]);
      setError(null);
      setPosition(null);
    }
  }, [open, type]);

  // 展示序：无搜索词时最近使用置顶成组，其余按接口顺序
  const { displayItems, recentCount } = useMemo(() => {
    if (searchQuery.trim() || recentIds.length === 0) {
      return { displayItems: items, recentCount: 0 };
    }
    const byId = new Map(items.map(item => [item.id, item]));
    const recent = recentIds
      .map(id => byId.get(id))
      .filter((item): item is UnifiedResourceItem => Boolean(item));
    if (recent.length === 0) return { displayItems: items, recentCount: 0 };
    const recentSet = new Set(recent.map(item => item.id));
    return {
      displayItems: [...recent, ...items.filter(item => !recentSet.has(item.id))],
      recentCount: recent.length,
    };
  }, [items, recentIds, searchQuery]);

  // 单一加载路径：首次打开立即执行（0ms，可被 StrictMode 双调用清理），
  // searchQuery 变化时 300ms 防抖
  useEffect(() => {
    if (!open) return;

    const immediate = !hasLoadedOnOpenRef.current;
    const timer = setTimeout(() => {
      hasLoadedOnOpenRef.current = true;
      void loadData();
    }, immediate ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, loadData]);

  // 数据刷新后收敛键盘高亮
  useEffect(() => {
    setActiveIndex(prev => (prev >= displayItems.length ? -1 : prev));
  }, [displayItems]);

  // 单击条目即选中确认（去掉两步 Confirm）
  const handleSelect = useCallback((item: UnifiedResourceItem) => {
    if (existingRefIds.has(item.id)) return;

    pushRecentId(type, item.id);
    const result: ReferenceSelectResult = {
      sourceDb: item.sourceDb,
      sourceId: item.id,
      title: item.title,
      previewType: item.previewType,
    };

    onSelect(result);
    onOpenChange(false);
  }, [existingRefIds, type, onSelect, onOpenChange]);

  // 键盘导航：跳过已引用（禁用）项
  const moveActive = useCallback((direction: 1 | -1) => {
    if (displayItems.length === 0) return;
    setActiveIndex(prev => {
      let next = prev;
      for (let step = 0; step < displayItems.length; step++) {
        next = (next + direction + displayItems.length) % displayItems.length;
        if (!existingRefIds.has(displayItems[next].id)) return next;
      }
      return prev;
    });
  }, [displayItems, existingRefIds]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < displayItems.length) {
          handleSelect(displayItems[activeIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onOpenChange(false);
        break;
      default:
        break;
    }
  }, [moveActive, activeIndex, displayItems, handleSelect, onOpenChange]);

  // 打开时：Esc 收起 + 点击面板/锚点以外收起 + 聚焦搜索框
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onOpenChange(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);

    const focusTimer = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
      cancelAnimationFrame(focusTimer);
    };
  }, [open, onOpenChange, anchorRef]);

  // 锚定定位：跟随触发按钮，处理视口碰撞；resize/scroll/尺寸变化时重算
  const updatePosition = useCallback(() => {
    const anchor = anchorRef?.current;
    const panel = panelRef.current;
    if (!anchor || !panel) {
      setPosition(null);
      return;
    }
    const next = resolvePopoverPosition({
      triggerRect: anchor.getBoundingClientRect(),
      contentWidth: panel.offsetWidth || PANEL_WIDTH,
      contentHeight: panel.offsetHeight || 420,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      align: 'start',
      side: 'bottom',
      sideOffset: 6,
      collisionPadding: 8,
    });
    setPosition(prev =>
      prev && prev.left === next.left && prev.top === next.top ? prev : next
    );
  }, [anchorRef]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    const frameId = requestAnimationFrame(updatePosition);
    const handleReposition = () => updatePosition();
    window.addEventListener('resize', handleReposition, { passive: true });
    window.addEventListener('scroll', handleReposition, { passive: true, capture: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && panelRef.current) {
      resizeObserver = new ResizeObserver(handleReposition);
      resizeObserver.observe(panelRef.current);
    }

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, { capture: true } as EventListenerOptions);
    };
  }, [open, updatePosition]);

  // 获取标题
  const panelTitle = useMemo(() => {
    switch (type) {
      case 'exam_session':
        return t('notes:reference.selectExamSession');
      case 'textbook':
      default:
        return t('notes:reference.selectTextbook');
    }
  }, [type, t]);

  // 获取空状态文案
  const emptyText = useMemo(() => {
    switch (type) {
      case 'exam_session':
        return t('notes:reference.noExamSessions');
      case 'textbook':
      default:
        return t('notes:reference.noTextbooks');
    }
  }, [type, t]);

  if (!open || typeof document === 'undefined') return null;

  const hasAnchor = Boolean(anchorRef?.current);
  const panelStyle: React.CSSProperties = hasAnchor
    ? {
        position: 'fixed',
        zIndex: Z_INDEX.popover,
        width: PANEL_WIDTH,
        left: position?.left ?? anchorRef!.current!.getBoundingClientRect().left,
        top: position?.top ?? anchorRef!.current!.getBoundingClientRect().bottom + 6,
        boxShadow: 'var(--notes-popup-shadow, 0 4px 12px hsl(var(--shadow-base) / 0.15))',
      }
    : {
        // 无锚点回退：顶部居中非模态浮层（无遮罩，Esc/点击外部仍可收起）
        position: 'fixed',
        zIndex: Z_INDEX.popover,
        width: PANEL_WIDTH,
        left: '50%',
        top: 96,
        transform: 'translateX(-50%)',
        boxShadow: 'var(--notes-popup-shadow, 0 4px 12px hsl(var(--shadow-base) / 0.15))',
      };

  const activeItem = activeIndex >= 0 ? displayItems[activeIndex] : undefined;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={panelTitle}
      className="ui-zoom-fade-in flex max-h-[70vh] flex-col overflow-hidden rounded-control border border-border/60 bg-popover text-popover-foreground"
      style={panelStyle}
    >
      {/* 头部：标题 + 关闭 */}
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2.5">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {type === 'exam_session' ? (
            <Table className="h-4 w-4 shrink-0 text-green-500" aria-hidden="true" />
          ) : (
            <BookOpen className="h-4 w-4 shrink-0 text-purple-500" aria-hidden="true" />
          )}
          <span className="truncate">{panelTitle}</span>
        </span>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => onOpenChange(false)}
          className="!h-6 !w-6 !rounded-full hover:bg-[var(--interactive-hover)]"
          aria-label={t('notes:a11y.close')}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </NotionButton>
      </div>

      {/* 搜索框 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchInputRef}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeItem ? `${listboxId}-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('notes:reference.searchPlaceholder')}
            className="h-8 w-full pl-8 pr-8 text-sm"
          />
          {searchQuery && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 !h-5 !w-5 -translate-y-1/2 !rounded-full !p-0.5 hover:bg-[var(--interactive-hover)]"
              aria-label={t('notes:a11y.clear')}
            >
              <X className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            </NotionButton>
          )}
        </div>
      </div>

      {/* 列表区域 */}
      <div className="min-h-0 flex-1 border-t border-border/60">
        <CustomScrollArea className="h-[280px]" viewportClassName="px-2 py-1.5">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center py-10">
              <CircleNotch className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
              <p className="mt-2 text-xs text-muted-foreground">
                {t('common:loading')}
              </p>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center py-10">
              <WarningCircle className="h-6 w-6 text-destructive" aria-hidden="true" />
              <p className="mt-2 px-4 text-center text-xs text-destructive">{error}</p>
              <NotionButton variant="ghost" size="sm" onClick={loadData} className="mt-2 text-xs text-primary hover:underline">
                {t('common:actions.retry')}
              </NotionButton>
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-10">
              {type === 'exam_session' ? (
                <Table className="h-10 w-10 text-muted-foreground/30" aria-hidden="true" />
              ) : (
                <BookOpen className="h-10 w-10 text-muted-foreground/30" aria-hidden="true" />
              )}
              <p className="mt-2 text-xs text-muted-foreground">{emptyText}</p>
              {searchQuery && (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setSearchQuery('')}
                  className="mt-1.5 text-xs text-primary hover:underline"
                >
                  {t('notes:a11y.clear')}
                </NotionButton>
              )}
            </div>
          ) : (
            <div id={listboxId} role="listbox" aria-label={panelTitle} className="space-y-0.5">
              {displayItems.map((item, index) => (
                <React.Fragment key={item.id}>
                  {recentCount > 0 && index === 0 && (
                    <div className="px-3 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground/70" aria-hidden="true">
                      {t('notes:wikilinkV2.recentGroup')}
                    </div>
                  )}
                  {recentCount > 0 && index === recentCount && (
                    <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground/70" aria-hidden="true">
                      {t('notes:wikilinkV2.allGroup')}
                    </div>
                  )}
                  <ReferenceSelectorItem
                    id={`${listboxId}-${item.id}`}
                    item={item}
                    isReferenced={existingRefIds.has(item.id)}
                    isSelected={activeIndex === index}
                    isActive={activeIndex === index}
                    onClick={() => handleSelect(item)}
                    onHover={() => setActiveIndex(index)}
                  />
                </React.Fragment>
              ))}
            </div>
          )}
        </CustomScrollArea>
      </div>

      {/* 底部信息栏：计数 + 位置提示 + 取消 */}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/30 px-3 py-2">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          {items.length > 0 ? (
            <>
              {t('notes:reference.itemCount', { count: items.length })}
              {existingRefIds.size > 0 && (
                <span className="ml-1.5">
                  ({t('notes:reference.referencedCount', { count: existingRefIds.size })})
                </span>
              )}
            </>
          ) : hint ? (
            <span className="truncate">{hint}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {items.length > 0 && hint && (
            <span className="hidden text-[11px] text-muted-foreground/70 sm:inline">{hint}</span>
          )}
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="!h-6 text-[11px] text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
          >
            {t('common:cancel')}
          </NotionButton>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
};

export default ReferenceSelector;
