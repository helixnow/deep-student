/**
 * TabBar - 学习资源标签页栏（Notion 风格）
 *
 * 显示已打开的标签页列表，支持切换、关闭。
 * 标签页过多时显示左右滚动箭头按钮。
 * 使用自定义 ResourceIcons 替代 Lucide 图标。
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, PanelRight, PanelLeftClose, X } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
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
  onSwitch: () => void;
  onClose: () => void;
  onSplitView?: () => void;
  onCloseSplitView?: () => void;
}

const TabItem: React.FC<TabItemProps> = React.memo(({
  tab, isActive, isSplitRight, onSwitch, onClose, onSplitView, onCloseSplitView,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const Icon = getTabIcon(tab.type);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

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

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close, { once: true });
    document.addEventListener('contextmenu', close, { once: true });
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [ctxMenu]);

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        role="tab"
        tabIndex={0}
        aria-selected={isActive}
        onPointerDown={(e) => {
          // 只在左键点击时触发切换，防止拖拽时意外切换，或右键时切换
          if (e.button === 0) {
            onSwitch();
          }
        }}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        title={tab.dstuPath}
        className={cn(
          'group/tab relative flex items-center gap-1.5 pl-2.5 pr-1.5 h-[28px] rounded-md cursor-default select-none my-[4px]',
          'text-[13px] leading-none whitespace-nowrap min-w-0 max-w-[200px] shrink-0',
          'transition-colors duration-150', // 移除 transform/all transition 防止与 dnd-kit 冲突
          isActive
            ? 'text-[var(--foreground)] font-medium bg-[var(--foreground)]/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.02)] ring-1 ring-inset ring-[var(--foreground)]/[0.04]'
            : 'text-[var(--foreground)]/60 hover:text-[var(--foreground)]/90 hover:bg-[var(--foreground)]/[0.04]',
          isSplitRight && !isActive && 'text-[#2383e2] dark:text-[#3b82f6] bg-[#2383e2]/10 hover:bg-[#2383e2]/15 hover:text-[#2383e2]',
          isDragging && 'opacity-50 scale-105 shadow-md z-50'
        )}
      >
        {/* 图标 */}
        <Icon size={14} className={cn("shrink-0", isSplitRight && !isActive ? "opacity-100" : "opacity-80")} />
        
        {/* 标题 */}
        <span className="truncate">{tab.title || t('common:untitled')}</span>
        
        {/* 右侧分屏指示图标 */}
        {isSplitRight && (
          <PanelRight className="w-[13px] h-[13px] ml-0.5 opacity-60 shrink-0" />
        )}
        
        {/* 关闭按钮 */}
        <span
          role="button"
          tabIndex={-1}
          onClick={handleClose}
          className={cn(
            'shrink-0 ml-0.5 rounded-[4px] p-[3px] transition-all duration-100',
            'opacity-0 group-hover/tab:opacity-100',
            'hover:bg-[var(--foreground)]/10 active:bg-[var(--foreground)]/15',
          )}
        >
          <X className="w-3 h-3" />
        </span>
      </div>

      {/* 右键菜单 */}
      {ctxMenu && (
        <div
          className="fixed z-[9999] min-w-[160px] py-1 bg-popover border border-transparent ring-1 ring-border/40 rounded-lg shadow-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {isSplitRight ? (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
              onClick={() => { onCloseSplitView?.(); setCtxMenu(null); }}
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
              {t('learningHub:splitView.close', '关闭分屏')}
            </button>
          ) : (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
              onClick={() => { onSplitView?.(); setCtxMenu(null); }}
            >
              <PanelRight className="w-3.5 h-3.5" />
              {t('learningHub:splitView.openRight', '在右侧打开')}
            </button>
          )}
          <div className="h-px bg-border my-1" />
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
            onClick={() => { onClose(); setCtxMenu(null); }}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            {t('common:actions.close', '关闭')}
          </button>
        </div>
      )}
    </>
  );
});

TabItem.displayName = 'TabItem';

// ============================================================================
// useScrollOverflow - 横向滚动溢出检测
// ============================================================================

function useScrollOverflow(ref: React.RefObject<HTMLDivElement | null>) {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, [ref]);

  useEffect(() => {
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
  }, [ref, update]);

  return { canScrollLeft, canScrollRight, update };
}

// ============================================================================
// TabBar 主组件
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
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs, activeTabId, onSwitch, onClose, splitView, onSplitView, onCloseSplitView, setTabs
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, update } = useScrollOverflow(scrollRef);
  
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 拖动 5px 才激活，避免与点击冲突
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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

  // 自动滚动到活跃标签页
  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const container = scrollRef.current;
    const activeEl = container.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!activeEl) return;
    const { offsetLeft, offsetWidth } = activeEl;
    const { scrollLeft, clientWidth } = container;
    if (offsetLeft < scrollLeft) {
      container.scrollTo({ left: offsetLeft - 8, behavior: 'smooth' });
    } else if (offsetLeft + offsetWidth > scrollLeft + clientWidth) {
      container.scrollTo({ left: offsetLeft + offsetWidth - clientWidth + 8, behavior: 'smooth' });
    }
  }, [activeTabId]);

  if (tabs.length === 0) return null;

  return (
    <div className="flex-shrink-0 relative flex items-stretch h-[36px] bg-[var(--background)] z-10"
         style={{ borderBottom: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}>
      {/* 左滚动按钮 */}
      {canScrollLeft && (
        <button
          onClick={() => scroll('left')}
          className="sticky left-0 z-10 flex items-center justify-center w-8 shrink-0 bg-[var(--background)] hover:bg-[var(--foreground)]/[0.04] transition-colors"
          style={{ borderRight: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}
        >
          <ChevronLeft className="w-4 h-4 opacity-45" />
        </button>
      )}

      {/* 标签页列表 */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabs.map(t => t.tabId)}
          strategy={horizontalListSortingStrategy}
        >
          <div
            ref={scrollRef}
            role="tablist"
            className="flex items-center gap-[2px] flex-1 min-w-0 overflow-x-auto scrollbar-none px-2"
            onWheel={e => {
              const el = scrollRef.current;
              if (!el || el.scrollWidth <= el.clientWidth) return;
              e.preventDefault();
              el.scrollLeft += e.deltaY || e.deltaX;
            }}
          >
            {tabs.map(tab => (
              <TabItem
                key={tab.tabId}
                tab={tab}
                isActive={tab.tabId === activeTabId}
                isSplitRight={splitView?.rightTabId === tab.tabId}
                onSwitch={() => onSwitch(tab.tabId)}
                onClose={() => onClose(tab.tabId)}
                onSplitView={() => onSplitView?.(tab.tabId)}
                onCloseSplitView={onCloseSplitView}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* 右滚动按钮 */}
      {canScrollRight && (
        <button
          onClick={() => scroll('right')}
          className="sticky right-0 z-10 flex items-center justify-center w-8 shrink-0 bg-[var(--background)] hover:bg-[var(--foreground)]/[0.04] transition-colors"
          style={{ borderLeft: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}
        >
          <ChevronRight className="w-4 h-4 opacity-45" />
        </button>
      )}
    </div>
  );
};
