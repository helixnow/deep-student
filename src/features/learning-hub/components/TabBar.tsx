/**
 * TabBar - 学习资源标签页栏（Notion 风格）
 *
 * 显示已打开的标签页列表，支持切换、关闭、拖拽排序。
 * 标签页过多时显示左右滚动箭头按钮。
 * 使用 @dnd-kit/sortable 实现水平拖拽重排。
 * 使用自定义 ResourceIcons 替代 Lucide 图标。
 */

import React, { useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, CaretRight, PushPin, PushPinSlash, SidebarSimple, X } from '@phosphor-icons/react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { OpenTab, SplitViewState } from '../types/tabs';
import type { ResourceType } from '../types';
import { useTranslation } from 'react-i18next';
import {
  NoteIcon,
  TextbookIcon,
  ExamIcon,
  EssayIcon,
  TranslationIcon,
  MindmapIcon,
  ImageFileIcon,
  GenericFileIcon,
  type ResourceIconProps,
} from '../icons';

// ============================================================================
// 类型定义
// ============================================================================

export interface TabBarProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  onSwitch: (tabId: string) => void;
  onClose: (tabId: string) => void;
  splitView?: SplitViewState | null;
  onSplitView?: (tabId: string) => void;
  onCloseSplitView?: () => void;
  setTabs?: React.Dispatch<React.SetStateAction<OpenTab[]>>;
  /** ★ 固定/取消固定标签页（固定的 tab 豁免 LRU 淘汰与批量关闭） */
  onTogglePin?: (tabId: string) => void;
  /** ★ 关闭除此之外的其他标签页（固定标签页豁免） */
  onCloseOthers?: (tabId: string) => void;
  /** ★ 关闭右侧标签页（固定标签页豁免） */
  onCloseRight?: (tabId: string) => void;
}

// ============================================================================
// 图标映射
// ============================================================================

const TAB_ICON_MAP: Record<string, React.FC<ResourceIconProps>> = {
  note: NoteIcon,
  textbook: TextbookIcon,
  exam: ExamIcon,
  translation: TranslationIcon,
  essay: EssayIcon,
  image: ImageFileIcon,
  file: GenericFileIcon,
  mindmap: MindmapIcon,
};

const getTabIcon = (type: ResourceType): React.FC<ResourceIconProps> =>
  TAB_ICON_MAP[type] || GenericFileIcon;

// ============================================================================
// TabItem 子组件
// ============================================================================

interface TabItemProps {
  tab: OpenTab;
  isActive: boolean;
  isSplitRight?: boolean;
  /** 是否存在可被「关闭右侧」影响的标签页 */
  hasTabsToRight?: boolean;
  /** 是否允许分屏（只有一个标签页时分屏会导致左侧空白，隐藏入口） */
  canSplit?: boolean;
  onSwitch: () => void;
  onClose: () => void;
  onSplitView?: () => void;
  onCloseSplitView?: () => void;
  onTogglePin?: () => void;
  onCloseOthers?: () => void;
  onCloseRight?: () => void;
}

const TabItem: React.FC<TabItemProps> = React.memo(({
  tab, isActive, isSplitRight, hasTabsToRight, canSplit,
  onSwitch, onClose, onSplitView, onCloseSplitView,
  onTogglePin, onCloseOthers, onCloseRight,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const Icon = getTabIcon(tab.type);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 触屏（长按打开菜单）：菜单项高提升到 ≥40px（契约第 3 条）
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.tabId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  }, [onClose]);

  // 鼠标中键关闭
  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // ★ 键盘可访问性：Enter/Space 激活标签页，Delete/Backspace 关闭；
  // 其余按键转发给 dnd-kit 的键盘拖拽监听器（保持排序能力）
  const dndKeyDown = (listeners as { onKeyDown?: (e: React.KeyboardEvent) => void } | undefined)?.onKeyDown;
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSwitch();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onClose();
      return;
    }
    dndKeyDown?.(e);
  }, [onSwitch, onClose, dndKeyDown]);

  // 点击外部 / Escape 关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('click', close, { once: true });
    document.addEventListener('contextmenu', close, { once: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ctxMenu]);

  // 📱 Android 返回键：自绘标签右键菜单打开时先关闭菜单（契约第 4 条）
  useEffect(() => {
    if (!ctxMenu) return;
    return registerBackHandler(() => {
      setCtxMenu(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [ctxMenu]);

  // ★ 右键菜单视口边缘检测：溢出时向左/向上收拢
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!ctxMenu) {
      setCtxMenuPos(null);
      return;
    }
    const rect = ctxMenuRef.current?.getBoundingClientRect();
    let { x, y } = ctxMenu;
    if (rect) {
      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight - 8) y = ctxMenu.y - rect.height;
    }
    setCtxMenuPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [ctxMenu]);

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        role="tab"
        // roving tabindex：Tab 键只落在活跃标签，左右方向键在标签间移动（见 tablist onKeyDown）
        tabIndex={isActive ? 0 : -1}
        aria-selected={isActive}
        onClick={onSwitch}
        onAuxClick={handleAuxClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        title={tab.dstuPath}
        className={cn(
          // Tahoe Finder tab strip: one continuous row with a single active capsule.
          'group/tab relative flex items-center gap-1.5 pl-2.5 pr-1.5 hover:pr-7 h-[30px] [@media(pointer:coarse)]:h-[36px] [@media(pointer:coarse)]:pr-7 rounded-lg cursor-default select-none my-[3px]',
          'text-[13px] leading-none whitespace-nowrap min-w-0 max-w-[200px] shrink-0 border-r border-border/40 last:border-r-0',
          'transition-[background-color,color,opacity] duration-150',
          isActive
            ? 'text-[var(--foreground)] font-medium bg-[var(--interactive-selected)] border-r-transparent'
            : 'text-[var(--foreground)]/60 hover:text-[var(--foreground)]/90 hover:bg-[var(--interactive-hover)]',
          isSplitRight && !isActive && 'text-[#2383e2] dark:text-[#3b82f6] bg-[#2383e2]/10 hover:bg-[#2383e2]/15 hover:text-[#2383e2]',
          isDragging && 'opacity-60 shadow-md z-50',
        )}
      >
        {/* 图标 */}
        <Icon size={14} className={cn("shrink-0", isSplitRight && !isActive ? "opacity-100" : "opacity-80")} />
        
        {/* 标题 */}
        <span className="min-w-0 truncate">{tab.title || t('common:untitled')}</span>
        
        {/* ★ 固定指示图标 */}
        {tab.isPinned && (
          <PushPin size={11} weight="fill" className="ml-0.5 opacity-55 shrink-0" />
        )}

        {/* 右侧分屏指示图标 */}
        {isSplitRight && (
          <SidebarSimple size={13} className="ml-0.5 opacity-60 shrink-0" />
        )}
        
        {/* 关闭按钮脱离标题排版；伪元素扩大点击热区，视觉尺寸不变 */}
        <span
          role="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={handleClose}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-inherit p-[3px] transition-opacity duration-100',
            'opacity-0 group-hover/tab:opacity-100 [@media(pointer:coarse)]:opacity-60',
            'hover:bg-[var(--foreground)]/10 active:bg-[var(--foreground)]/15',
            'before:absolute before:-inset-[5px] before:content-[""]',
          )}
        >
          <X size={12} />
        </span>
      </div>

      {/* 右键菜单（portal 到 body，避免被标签栏 overflow/transform 裁剪） */}
      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          role="menu"
          className="fixed z-[9999] min-w-[160px] py-1 bg-popover border border-transparent ring-1 ring-border/40 rounded-lg shadow-lg"
          style={{
            left: (ctxMenuPos ?? ctxMenu).x,
            top: (ctxMenuPos ?? ctxMenu).y,
            // 首帧测量前先隐藏，避免边缘位置闪跳
            visibility: ctxMenuPos ? 'visible' : 'hidden',
          }}
        >
          {/* 📱 移动端不支持分屏（父级不传 onSplitView/onCloseSplitView），隐藏无效入口，避免点击无反应 */}
          {isSplitRight ? (
            onCloseSplitView && (
              <button
                role="menuitem"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-[var(--interactive-hover)] text-left [@media(pointer:coarse)]:min-h-[40px]"
                onClick={() => { onCloseSplitView(); setCtxMenu(null); }}
              >
                <SidebarSimple size={14} />
                {t('learningHub:splitView.close')}
              </button>
            )
          ) : (
            onSplitView && (
              <button
                role="menuitem"
                disabled={!canSplit}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left [@media(pointer:coarse)]:min-h-[40px]',
                  canSplit ? 'hover:bg-[var(--interactive-hover)]' : 'opacity-40 cursor-default',
                )}
                onClick={() => { if (canSplit) { onSplitView(); setCtxMenu(null); } }}
              >
                <SidebarSimple size={14} />
                {t('learningHub:splitView.openRight')}
              </button>
            )
          )}
          {onTogglePin && (
            <button
              role="menuitem"
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-[var(--interactive-hover)] text-left [@media(pointer:coarse)]:min-h-[40px]"
              onClick={() => { onTogglePin(); setCtxMenu(null); }}
            >
              {tab.isPinned ? <PushPinSlash size={14} /> : <PushPin size={14} />}
              {tab.isPinned
                ? t('learningHub:tabBar.unpin')
                : t('learningHub:tabBar.pin')}
            </button>
          )}
          <div className="h-px bg-border my-1" role="separator" />
          <button
            role="menuitem"
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-[var(--interactive-hover)] text-left [@media(pointer:coarse)]:min-h-[40px]"
            onClick={() => { onClose(); setCtxMenu(null); }}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            {t('common:actions.close')}
          </button>
          {onCloseOthers && (
            <button
              role="menuitem"
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-[var(--interactive-hover)] text-left [@media(pointer:coarse)]:min-h-[40px]"
              onClick={() => { onCloseOthers(); setCtxMenu(null); }}
            >
              <span className="w-[14px]" />
              {t('learningHub:tabBar.closeOthers')}
            </button>
          )}
          {onCloseRight && (
            <button
              role="menuitem"
              className={cn(
                'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left [@media(pointer:coarse)]:min-h-[40px]',
                hasTabsToRight
                  ? 'hover:bg-[var(--interactive-hover)]'
                  : 'opacity-40 cursor-default',
              )}
              disabled={!hasTabsToRight}
              onClick={() => { if (hasTabsToRight) { onCloseRight(); setCtxMenu(null); } }}
            >
              <span className="w-[14px]" />
              {t('learningHub:tabBar.closeRight')}
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  );
});

TabItem.displayName = 'TabItem';

// ============================================================================
// useScrollOverflow - 横向滚动溢出检测
// ============================================================================

function useScrollOverflow(ref: React.RefObject<HTMLDivElement | null>, attached: boolean) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, [ref]);

  // attached 参与依赖：TabBar 在 tabs 清空时返回 null，滚动容器随之销毁/重建，
  // 需要在容器重新出现时重新挂监听（仅依赖 [] 会在容器为 null 时错过挂载时机）
  useEffect(() => {
    if (!attached) return;
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref, update, attached]);

  return { canScrollLeft, canScrollRight, update };
}

// ============================================================================
// TabBar 主组件
// ============================================================================

export const TabBar: React.FC<TabBarProps> = ({
  tabs, activeTabId, onSwitch, onClose, splitView, onSplitView, onCloseSplitView, setTabs,
  onTogglePin, onCloseOthers, onCloseRight,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasTabs = tabs.length > 0;
  const { canScrollLeft, canScrollRight, update } = useScrollOverflow(scrollRef, hasTabs);

  const sensors = useTouchFriendlyDndSensors({ mouseDistance: 5 });

  // 标签页变化后重新检查溢出
  useEffect(() => { update(); }, [tabs.length, update]);

  const scroll = useCallback((dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -160 : 160, behavior: 'smooth' });
  }, []);

  // 标签页重排
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      if (setTabs) {
        setTabs((items) => {
          const oldIndex = items.findIndex((item) => item.tabId === active.id);
          const newIndex = items.findIndex((item) => item.tabId === over.id);
          return arrayMove(items, oldIndex, newIndex);
        });
      }
    }
  }, [setTabs]);

  // ★ 竖向滚轮转横向滚动：React 的 onWheel 在根节点以 passive 方式注册，
  // preventDefault 会报错且无效，这里手动挂非 passive 监听。
  // hasTabs 参与依赖：容器随 tabs 清空销毁，重新出现时需重挂监听。
  useEffect(() => {
    if (!hasTabs) return;
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY || e.deltaX;
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [hasTabs]);

  // 自动滚动到活跃标签页
  // ★ 用 getBoundingClientRect 计算（offsetLeft 相对的是外层定位祖先，
  // 左滚动按钮出现/消失时会引入偏差）
  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const container = scrollRef.current;
    const activeEl = container.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!activeEl) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    if (elRect.left < containerRect.left) {
      container.scrollBy({ left: elRect.left - containerRect.left - 8, behavior: 'smooth' });
    } else if (elRect.right > containerRect.right) {
      container.scrollBy({ left: elRect.right - containerRect.right + 8, behavior: 'smooth' });
    }
  }, [activeTabId]);

  // ★ tablist 键盘导航（WAI-ARIA tabs 模式）：←/→ 在标签间切换，Home/End 跳到首尾
  const handleTablistKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    if (tabs.length === 0) return;
    e.preventDefault();
    const currentIdx = Math.max(0, tabs.findIndex(t => t.tabId === activeTabId));
    let nextIdx: number;
    switch (e.key) {
      case 'ArrowLeft': nextIdx = (currentIdx - 1 + tabs.length) % tabs.length; break;
      case 'ArrowRight': nextIdx = (currentIdx + 1) % tabs.length; break;
      case 'Home': nextIdx = 0; break;
      default: nextIdx = tabs.length - 1;
    }
    const next = tabs[nextIdx];
    if (!next || next.tabId === activeTabId) return;
    onSwitch(next.tabId);
    // 切换后把焦点移到新的活跃标签（roving tabindex）
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
  }, [tabs, activeTabId, onSwitch]);

  if (tabs.length === 0) return null;

  return (
    <div className="flex-shrink-0 relative flex items-stretch h-[38px] [@media(pointer:coarse)]:h-[44px] bg-[color:var(--shell-toolbar-surface,var(--background))] z-10"
         data-no-screen-swipe
         style={{ borderBottom: '1px solid color-mix(in srgb, var(--foreground) 8%, transparent)' }}>
      {/* 左滚动按钮 */}
      {canScrollLeft && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => scroll('left')}
          className="sticky left-0 z-10 flex w-8 shrink-0 items-center justify-center bg-[color:var(--shell-toolbar-surface,var(--background))] transition-colors hover:bg-[var(--interactive-hover)]"
          style={{ borderRight: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}
        >
          <CaretLeft size={16} className="opacity-45" />
        </button>
      )}

      {/* 标签页列表 */}
      <DndContext
        sensors={sensors}
        autoScroll={SHELL_SAFE_AUTO_SCROLL}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabs.map(t => t.tabId)}
          strategy={horizontalListSortingStrategy}
        >
          <div
            ref={scrollRef}
            role="tablist"
            aria-orientation="horizontal"
            onKeyDown={handleTablistKeyDown}
            className="flex min-w-0 flex-1 items-center gap-0 overflow-x-auto px-2 scrollbar-none"
          >
            {tabs.map((tab, index) => (
              <TabItem
                key={tab.tabId}
                tab={tab}
                isActive={tab.tabId === activeTabId}
                isSplitRight={splitView?.rightTabId === tab.tabId}
                hasTabsToRight={tabs.slice(index + 1).some(t => !t.isPinned)}
                canSplit={tabs.length > 1}
                onSwitch={() => onSwitch(tab.tabId)}
                onClose={() => onClose(tab.tabId)}
                onSplitView={onSplitView ? () => onSplitView(tab.tabId) : undefined}
                onCloseSplitView={onCloseSplitView}
                onTogglePin={onTogglePin ? () => onTogglePin(tab.tabId) : undefined}
                onCloseOthers={onCloseOthers ? () => onCloseOthers(tab.tabId) : undefined}
                onCloseRight={onCloseRight ? () => onCloseRight(tab.tabId) : undefined}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* 右滚动按钮 */}
      {canScrollRight && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => scroll('right')}
          className="sticky right-0 z-10 flex w-8 shrink-0 items-center justify-center bg-[color:var(--shell-toolbar-surface,var(--background))] transition-colors hover:bg-[var(--interactive-hover)]"
          style={{ borderLeft: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}
        >
          <CaretRight size={16} className="opacity-45" />
        </button>
      )}
    </div>
  );
};
