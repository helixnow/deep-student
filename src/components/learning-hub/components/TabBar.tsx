/**
 * TabBar - 学习资源标签页栏（Notion 风格）
 *
 * 显示已打开的标签页列表，支持切换、关闭。
 * 标签页过多时显示左右滚动箭头按钮。
 * 使用自定义 ResourceIcons 替代 Lucide 图标。
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, PanelRight, PanelLeftClose } from 'lucide-react';
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
        role="tab"
        tabIndex={0}
        aria-selected={isActive}
        onClick={onSwitch}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        title={tab.dstuPath}
        className={cn(
          'group/tab relative flex items-center gap-1.5 pl-2.5 pr-1.5 h-[33px] cursor-default select-none',
          'text-[12.5px] leading-none whitespace-nowrap min-w-0 max-w-[180px] shrink-0',
          'transition-colors duration-100',
          isActive
            ? 'text-[var(--foreground)]'
            : 'text-[var(--foreground)]/55 hover:text-[var(--foreground)]/80 hover:bg-[var(--foreground)]/[0.04]',
          isSplitRight && 'ring-1 ring-inset ring-primary/30',
        )}
      >
        {/* 底部活跃指示条 */}
        {isActive && (
          <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-[#2383e2]" />
        )}
        {/* 右侧分屏指示点 */}
        {isSplitRight && (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
        )}
        {/* 图标 */}
        <Icon size={15} className="shrink-0" />
        {/* 标题 */}
        <span className="truncate">{tab.title || t('common:untitled')}</span>
        {/* 关闭按钮 */}
        <span
          role="button"
          tabIndex={-1}
          onClick={handleClose}
          className={cn(
            'shrink-0 ml-0.5 rounded-[3px] p-[2px] transition-all duration-100',
            'opacity-0 group-hover/tab:opacity-100',
            'hover:bg-[var(--foreground)]/10 active:bg-[var(--foreground)]/15',
          )}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
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

export const TabBar: React.FC<TabBarProps> = ({
  tabs, activeTabId, onSwitch, onClose, splitView, onSplitView, onCloseSplitView,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, update } = useScrollOverflow(scrollRef);

  // 标签页变化后重新检查溢出
  useEffect(() => { update(); }, [tabs.length, update]);

  const scroll = useCallback((dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -160 : 160, behavior: 'smooth' });
  }, []);

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
    <div className="flex-shrink-0 relative flex items-stretch h-[34px] bg-[var(--background)]"
         style={{ borderBottom: '1px solid color-mix(in srgb, var(--foreground) 8%, transparent)' }}>
      {/* 左滚动按钮 */}
      {canScrollLeft && (
        <button
          onClick={() => scroll('left')}
          className="sticky left-0 z-10 flex items-center justify-center w-6 shrink-0 bg-[var(--background)] hover:bg-[var(--foreground)]/[0.04] transition-colors"
          style={{ borderRight: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}
        >
          <ChevronLeft className="w-3.5 h-3.5 opacity-45" />
        </button>
      )}

      {/* 标签页列表 */}
      <div
        ref={scrollRef}
        role="tablist"
        className="flex items-stretch flex-1 min-w-0 overflow-x-auto scrollbar-none"
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

      {/* 右滚动按钮 */}
      {canScrollRight && (
        <button
          onClick={() => scroll('right')}
          className="sticky right-0 z-10 flex items-center justify-center w-6 shrink-0 bg-[var(--background)] hover:bg-[var(--foreground)]/[0.04] transition-colors"
          style={{ borderLeft: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)' }}
        >
          <ChevronRight className="w-3.5 h-3.5 opacity-45" />
        </button>
      )}
    </div>
  );
};
