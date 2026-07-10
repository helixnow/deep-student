import React, { useRef, useCallback, useMemo, useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CircleNotch, FolderOpen, Plus, ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DndContext,
  pointerWithin,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useTouchFriendlyDndSensors } from '@/hooks/useTouchFriendlyDndSensors';
import type { DstuNode } from '@/dstu/types';
import type { ViewMode } from '../../stores/finderStore';
import { FinderFileItem, SortableFinderFileItem } from './FinderFileItem';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useSelectionBox, getSelectionBoxStyle, SelectionBoxRect } from './useSelectionBox';
import { debugLog, debugMasterSwitch } from '@/debug-panel/debugMasterSwitch';
import './finder-animations.css';

// 紧凑列表项高度
const LIST_ITEM_HEIGHT = 40;

// 网格模式虚拟滚动常量
// 列宽与 FinderFileItem 网格卡片同宽；用固定 px 轨道，避免 1fr 把列压窄后卡片溢出重叠
const GRID_ITEM_WIDTH = 88;
const GRID_GAP = 8;              // gap-2 = 0.5rem = 8px
const GRID_ROW_HEIGHT = 120;     // 网格行高度（包含内容）
const GRID_PADDING = 12;         // p-3 = 0.75rem = 12px

// Type-ahead 缓冲超时（与 Windows Explorer 一致约 1s）
const TYPE_AHEAD_TIMEOUT_MS = 1000;

/**
 * 选择框覆盖层组件 - 使用 Portal 渲染到 body 下避免父元素 transform 影响
 */
function SelectionBoxOverlay({ rect }: { rect: SelectionBoxRect }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lastDebugTimeRef = useRef<number>(0);
  
  useEffect(() => {
    // 调试开关关闭时跳过：避免框选过程中每帧 getBoundingClientRect 造成布局抖动
    if (!debugMasterSwitch.isEnabled()) return;

    const now = Date.now();
    // 节流：每 100ms 最多发一次
    if (now - lastDebugTimeRef.current < 100) return;
    lastDebugTimeRef.current = now;
    
    if (boxRef.current) {
      const actualRect = boxRef.current.getBoundingClientRect();
      const style = getSelectionBoxStyle(rect);
      
      window.dispatchEvent(new CustomEvent('selection-box-debug', {
        detail: {
          type: 'render_position',
          timestamp: now,
          // 期望位置（CSS 设置的）
          expectedLeft: style.left,
          expectedTop: style.top,
          expectedWidth: style.width,
          expectedHeight: style.height,
          // 实际渲染位置
          actualLeft: Math.round(actualRect.left),
          actualTop: Math.round(actualRect.top),
          actualWidth: Math.round(actualRect.width),
          actualHeight: Math.round(actualRect.height),
          // 渲染偏移
          renderOffsetX: Math.round(actualRect.left - (style.left as number)),
          renderOffsetY: Math.round(actualRect.top - (style.top as number)),
        }
      }));
    }
  }, [rect]);
  
  // ★ 使用 Portal 渲染到 body 下，避免父元素 transform 影响 position: fixed
  return createPortal(
    <div ref={boxRef} style={getSelectionBoxStyle(rect)} />,
    document.body
  );
}

interface FinderFileRowProps {
  item: DstuNode;
  viewMode: ViewMode;
  isSelected: boolean;
  isActive: boolean;
  isHighlighted?: boolean;
  isEditing: boolean;
  enableDrag: boolean;
  compact: boolean;
  onSelect: (id: string, mode: 'single' | 'toggle' | 'range') => void;
  onOpen: (item: DstuNode) => void;
  onContextMenu: (e: React.MouseEvent, item: DstuNode) => void;
  onEditConfirm?: (id: string, newName: string) => void;
  onEditCancel?: () => void;
}

/**
 * 每行/每格的稳定包装组件。
 * 把「列表级回调 + item」绑定成对 item 稳定的回调，
 * 使 SortableFinderFileItem 的 React.memo 真正生效：
 * 选中集变化时只有 isSelected 变化的项会重渲染，而不是整个列表。
 */
const FinderFileRow = React.memo(function FinderFileRow({
  item,
  viewMode,
  isSelected,
  isActive,
  isHighlighted,
  isEditing,
  enableDrag,
  compact,
  onSelect,
  onOpen,
  onContextMenu,
  onEditConfirm,
  onEditCancel,
}: FinderFileRowProps) {
  const handleSelect = useCallback(
    (mode: 'single' | 'toggle' | 'range') => onSelect(item.id, mode),
    [onSelect, item.id]
  );
  const handleOpen = useCallback(() => onOpen(item), [onOpen, item]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, item),
    [onContextMenu, item]
  );
  const handleEditConfirm = useCallback(
    (newName: string) => onEditConfirm?.(item.id, newName),
    [onEditConfirm, item.id]
  );

  return (
    <SortableFinderFileItem
      id={item.id}
      item={item}
      viewMode={viewMode}
      isSelected={isSelected}
      isActive={isActive}
      isHighlighted={isHighlighted}
      onSelect={handleSelect}
      onOpen={handleOpen}
      onContextMenu={handleContextMenu}
      enableDrag={enableDrag}
      isEditing={isEditing}
      onEditConfirm={handleEditConfirm}
      onEditCancel={onEditCancel}
      compact={compact}
    />
  );
});

interface FinderFileListProps {
  items: DstuNode[];
  viewMode: ViewMode;
  selectedIds: Set<string>;
  onSelect: (id: string, mode: 'single' | 'toggle' | 'range') => void;
  onOpen: (item: DstuNode) => void;
  onContextMenu: (e: React.MouseEvent, item: DstuNode) => void;
  onContainerClick?: () => void;
  /** 空白区域右键菜单 */
  onContainerContextMenu?: (e: React.MouseEvent) => void;
  /** 单个项目移动（单选拖拽） */
  onMoveItem?: (itemId: string, targetFolderId: string | null) => void;
  /** 多个项目移动（多选拖拽） */
  onMoveItems?: (itemIds: string[], targetFolderId: string | null) => void;
  isLoading: boolean;
  error: string | null;
  emptyMessage?: string;
  enableDragDrop?: boolean;
  /** 正在编辑的项 ID */
  editingId?: string | null;
  /** 内联编辑确认回调 */
  onEditConfirm?: (id: string, newName: string) => void;
  /** 内联编辑取消回调 */
  onEditCancel?: () => void;
  /** ★ 紧凑模式（隐藏时间和大小列） */
  compact?: boolean;
  /** ★ 当前在应用面板中打开的文件 ID（用于高亮） */
  activeFileId?: string | null;
  /** ★ 框选多选回调 */
  onSelectionChange?: (ids: Set<string>) => void;
  /** ★ 启用框选 */
  enableBoxSelect?: boolean;
  /** ★ 加载失败时的重试回调 */
  onRetry?: () => void;
  /** ★ 高亮标记的项 ID（如已关联资源） */
  highlightedIds?: Set<string>;
  /** ★ 2026-06-12（审阅问题 FE-S2）：键盘 F2 请求重命名 */
  onRequestRename?: (item: DstuNode) => void;
}

export function FinderFileList({
  items,
  viewMode,
  selectedIds,
  onSelect,
  onOpen,
  onContextMenu,
  onContainerClick,
  onContainerContextMenu,
  onMoveItem,
  onMoveItems,
  isLoading,
  error,
  emptyMessage,
  enableDragDrop = true,
  editingId,
  onEditConfirm,
  onEditCancel,
  compact = false,
  activeFileId,
  enableBoxSelect = true,
  onSelectionChange,
  onRetry,
  highlightedIds,
  onRequestRename,
}: FinderFileListProps) {
  const { t } = useTranslation('learningHub');
  const { isSmallScreen } = useBreakpoint();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);
  
  // ★ 网格模式虚拟滚动：容器宽度状态
  const [gridContainerWidth, setGridContainerWidth] = useState(0);
  
  // 网格 DOM 是否已挂载（loading/empty/list 早退时 ref 为 null）
  const gridDomReady =
    viewMode === 'grid' && !isLoading && !error && items.length > 0;

  // ★ 计算网格列数（固定卡片宽度，右侧留白）
  const gridColumns = useMemo(() => {
    const availableWidth = gridContainerWidth;
    if (availableWidth <= 0) return 1;
    const cols = Math.floor((availableWidth + GRID_GAP) / (GRID_ITEM_WIDTH + GRID_GAP));
    return Math.max(1, cols);
  }, [gridContainerWidth]);
  
  // ★ 网格模式虚拟滚动：网格真正挂载后再量宽
  // 依赖 gridDomReady：loading→有数据时 viewMode 不变，必须重跑，否则列数会卡在 1
  useLayoutEffect(() => {
    if (!gridDomReady) return;
    
    const container = gridContainerRef.current;
    if (!container) return;
    
    // 立即同步获取容器宽度（gridContainerRef 在 viewport 内部，已排除 padding）
    const initialWidth = container.getBoundingClientRect().width;
    if (initialWidth > 0) {
      setGridContainerWidth(initialWidth);
    }
  }, [gridDomReady]);

  // ★ 网格模式虚拟滚动：监听容器宽度变化（用于响应式调整）
  useEffect(() => {
    if (!gridDomReady) return;
    
    const container = gridContainerRef.current;
    if (!container) return;
    
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 使用 contentRect.width 获取内容区宽度（不包括 padding）
        setGridContainerWidth(entry.contentRect.width);
      }
    });
    
    observer.observe(container);
    return () => observer.disconnect();
  }, [gridDomReady]);

  // ★ 框选功能：获取所有文件项的边界信息
  const getItemRects = useCallback(() => {
    const rects = new Map<string, DOMRect>();
    if (!containerRef.current) return rects;
    
    const itemElements = containerRef.current.querySelectorAll('[data-finder-item]');
    itemElements.forEach((el) => {
      const id = el.getAttribute('data-item-id');
      if (id) {
        rects.set(id, el.getBoundingClientRect());
      }
    });
    return rects;
  }, []);

  // ★ 框选功能：处理选中变化
  const handleBoxSelectionChange = useCallback((ids: Set<string>, mode: 'replace' | 'add') => {
    if (mode === 'add') {
      // Shift 键追加选择
      const newSelection = new Set(selectedIds);
      ids.forEach(id => newSelection.add(id));
      onSelectionChange?.(newSelection);
    } else {
      onSelectionChange?.(ids);
    }
  }, [selectedIds, onSelectionChange]);

  // ★ 框选 Hook
  const { isSelecting, selectionRect, handleMouseDown } = useSelectionBox({
    containerRef,
    getItemRects,
    onSelectionChange: handleBoxSelectionChange,
    enabled: enableBoxSelect && !activeId, // 拖拽时禁用框选
    minDistance: 10,
  });

  // ★ 框选结束时会紧跟一个 click 事件，需要抑制它，避免清掉刚框选的内容。
  // 流程：mousedown 复位标记 → 框选进行中置位 → 随后的 click 消费标记并跳过
  const suppressContainerClickRef = useRef(false);
  useEffect(() => {
    if (isSelecting) {
      suppressContainerClickRef.current = true;
    }
  }, [isSelecting]);

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    suppressContainerClickRef.current = false;
    handleMouseDown(e);
  }, [handleMouseDown]);

  // DnD 传感器配置（N-9/DND-1: 触屏长按激活，避免与滚动/单击打开冲突）
  const sensors = useTouchFriendlyDndSensors();

  // ★ SortableContext 的 items 引用稳定化，避免每次渲染都重建数组
  const itemIds = useMemo(() => items.map(item => item.id), [items]);

  // ★ 列表模式虚拟滚动配置
  const listVirtualizer = useVirtualizer({
    count: viewMode === 'list' ? items.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => LIST_ITEM_HEIGHT,
    overscan: 5,
  });
  
  // ★ 网格模式虚拟滚动配置
  const gridRowCount = useMemo(() => {
    if (gridColumns === 0) return 0;
    return Math.ceil(items.length / gridColumns);
  }, [items.length, gridColumns]);
  
  const gridVirtualizer = useVirtualizer({
    count: viewMode === 'grid' ? gridRowCount : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => GRID_ROW_HEIGHT + GRID_GAP,
    overscan: 2,
  });

  // 拖拽开始
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
    debugLog.info('[FinderFileList] DragStart:', { activeId: event.active.id });
    if (debugMasterSwitch.isEnabled()) {
      window.dispatchEvent(new CustomEvent('finder-drag-debug', {
        detail: {
          type: 'drag_start',
          activeId: event.active.id,
          timestamp: Date.now(),
        }
      }));
    }
  }, []);

  // 拖拽结束
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    debugLog.info('[FinderFileList] DragEnd:', {
      activeId: active.id,
      overId: over?.id ?? null,
      hasOver: !!over,
    });
    if (debugMasterSwitch.isEnabled()) {
      window.dispatchEvent(new CustomEvent('finder-drag-debug', {
        detail: {
          type: 'drag_end',
          activeId: active.id,
          overId: over?.id ?? null,
          timestamp: Date.now(),
        }
      }));
    }

    if (!over || active.id === over.id) {
      debugLog.info('[FinderFileList] DragEnd: No valid drop target');
      return;
    }

    const draggedItem = items.find(item => item.id === active.id);
    const targetItem = items.find(item => item.id === over.id);

    if (!draggedItem || !targetItem) {
      debugLog.info('[FinderFileList] DragEnd: Item not found in list');
      return;
    }

    // 如果拖到文件夹上，则移动到该文件夹
    if (targetItem.type === 'folder') {
      debugLog.info('[FinderFileList] DragEnd: Moving to folder', { targetId: targetItem.id });
      // 检查是否为多选拖拽（拖拽项在选中列表中）
      const isMultiDrag = selectedIds.has(String(active.id)) && selectedIds.size > 1;
      
      if (isMultiDrag && onMoveItems) {
        // 排除目标文件夹自身（不能移动到自己）
        const idsToMove = Array.from(selectedIds).filter(id => id !== targetItem.id);
        debugLog.info('[FinderFileList] Multi-drag move:', { count: idsToMove.length });
        if (idsToMove.length > 0) {
          onMoveItems(idsToMove, targetItem.id);
        }
      } else if (onMoveItem) {
        // ★ 优化：单选拖拽时也过滤自己（文件夹拖到自己）
        if (draggedItem.type === 'folder' && draggedItem.id === targetItem.id) {
          debugLog.info('[FinderFileList] Single-drag: Cannot move folder to itself');
          return;
        }
        debugLog.info('[FinderFileList] Single-drag move:', { from: active.id, to: targetItem.id });
        onMoveItem(String(active.id), targetItem.id);
      } else {
        debugLog.info('[FinderFileList] DragEnd: onMoveItem callback is not provided!');
      }
    } else {
      debugLog.info('[FinderFileList] DragEnd: Target is not a folder, type:', { type: targetItem.type });
    }
  }, [items, selectedIds, onMoveItem, onMoveItems]);

  // 获取激活的项
  const activeItem = useMemo(() => {
    return activeId ? items.find(item => item.id === activeId) : null;
  }, [activeId, items]);

  // 多选拖拽计数
  const dragCount = useMemo(() => {
    if (!activeId) return 1;
    // 如果拖拽项在选中列表中，返回选中数量
    if (selectedIds.has(String(activeId))) {
      return selectedIds.size;
    }
    return 1;
  }, [activeId, selectedIds]);

  // 容器点击：点击空白区域清除选择（Finder/Explorer 惯例）。
  // 原实现要求 e.target === e.currentTarget，但虚拟滚动的内层容器会挡住绝大多数
  // 空白点击，导致"点空白取消选择"几乎不可用
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (!onContainerClick) return;
    // 框选刚结束时的 click 不算"点击空白"（消费一次标记）
    if (suppressContainerClickRef.current) {
      suppressContainerClickRef.current = false;
      return;
    }
    // 按住修饰键的点击不清除（用户可能在做加选操作）
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    // 点击文件项或滚动条时不处理
    if (target.closest('[data-finder-item]') || target.closest('.os-scrollbar')) return;
    onContainerClick();
  }, [onContainerClick]);

  // ★ 容器双击清除选择
  const handleContainerDoubleClick = useCallback((e: React.MouseEvent) => {
    // 双击空白区域清除选择
    const target = e.target as HTMLElement;
    if (!target.closest('[data-finder-item]')) {
      onSelectionChange?.(new Set());
    }
  }, [onSelectionChange]);

  // 容器右键菜单
  const handleContainerContextMenu = useCallback((e: React.MouseEvent) => {
    // 不需要检查 e.target === e.currentTarget，因为：
    // 1. 项的右键已在 LearningHubSidebar.handleContextMenu 中调用 stopPropagation 阻止冒泡
    // 2. 虚拟滚动列表内部的空白区域可能不是容器本身
    if (onContainerContextMenu) {
      onContainerContextMenu(e);
    }
  }, [onContainerContextMenu]);

  // ========================================================================
  // ★ 2026-06-12（审阅问题 FE-S2）：键盘导航核心集
  // 方向键移动焦点 / Shift+方向键区间选择 / Enter 打开 / F2 重命名
  // / PageUp/PageDown 翻页 / 字母键 type-ahead 定位
  // ========================================================================

  // 键盘导航锚点（最近一次键盘/点击聚焦的项，即"焦点"）
  const keyboardAnchorRef = useRef<string | null>(null);
  // Shift 区间选择的固定端点（pivot）：普通移动时跟随焦点，Shift 移动时保持不动
  const selectionPivotRef = useRef<string | null>(null);
  // Type-ahead 输入缓冲
  const typeAheadRef = useRef<{ buffer: string; lastTime: number }>({ buffer: '', lastTime: 0 });

  // 选中集变化时校正锚点：锚点必须始终在选中集内
  useEffect(() => {
    if (selectedIds.size === 0) {
      keyboardAnchorRef.current = null;
      selectionPivotRef.current = null;
    } else if (!keyboardAnchorRef.current || !selectedIds.has(keyboardAnchorRef.current)) {
      // 取选中集中在 items 顺序里最靠前的一项作为锚点
      const first = items.find(item => selectedIds.has(item.id));
      keyboardAnchorRef.current = first?.id ?? null;
      // 选中集被外部（鼠标点击等）重置时，pivot 跟随新锚点
      selectionPivotRef.current = first?.id ?? null;
    }
  }, [selectedIds, items]);

  // 将指定索引滚动到可见区域
  const scrollItemIntoView = useCallback((index: number) => {
    if (viewMode === 'list') {
      listVirtualizer.scrollToIndex(index, { align: 'auto' });
    } else if (gridColumns > 0) {
      gridVirtualizer.scrollToIndex(Math.floor(index / gridColumns), { align: 'auto' });
    }
  }, [viewMode, gridColumns, listVirtualizer, gridVirtualizer]);

  const handleKeyboardNavigation = useCallback((e: React.KeyboardEvent) => {
    // 编辑中或无数据时不拦截
    if (editingId || items.length === 0) return;
    // 不拦截输入框内的按键
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    const anchorId = keyboardAnchorRef.current;
    const anchorIndex = anchorId ? items.findIndex(item => item.id === anchorId) : -1;

    const focusIndex = (rawIndex: number) => {
      e.preventDefault();
      const nextIndex = Math.max(0, Math.min(items.length - 1, rawIndex));
      if (nextIndex === anchorIndex) return;

      const nextItem = items[nextIndex];
      keyboardAnchorRef.current = nextItem.id;
      if (e.shiftKey && onSelectionChange) {
        // Shift+方向键：以 pivot 为固定端点做连续区间选择（Finder/Explorer 语义，
        // 反向移动时自动收缩选区）
        const pivotId = selectionPivotRef.current ?? anchorId;
        let pivotIndex = pivotId ? items.findIndex(item => item.id === pivotId) : -1;
        if (pivotIndex < 0) pivotIndex = nextIndex;
        selectionPivotRef.current = items[pivotIndex].id;

        const lo = Math.min(pivotIndex, nextIndex);
        const hi = Math.max(pivotIndex, nextIndex);
        const newSelection = new Set<string>();
        for (let i = lo; i <= hi; i++) {
          newSelection.add(items[i].id);
        }
        onSelectionChange(newSelection);
      } else {
        selectionPivotRef.current = nextItem.id;
        onSelect(nextItem.id, 'single');
      }
      scrollItemIntoView(nextIndex);
    };

    const moveFocus = (delta: number) => {
      if (anchorIndex < 0) {
        // 无选择时：向下/右从首项开始，向上/左从末项开始
        focusIndex(delta > 0 ? 0 : items.length - 1);
      } else {
        focusIndex(anchorIndex + delta);
      }
    };

    // 一页可容纳的项数（PageUp/PageDown 步长）
    const getPageDelta = () => {
      const viewportHeight = viewportRef.current?.clientHeight ?? 0;
      if (viewMode === 'grid') {
        const rowsPerPage = Math.max(1, Math.floor(viewportHeight / (GRID_ROW_HEIGHT + GRID_GAP)));
        return rowsPerPage * Math.max(1, gridColumns);
      }
      return Math.max(1, Math.floor(viewportHeight / LIST_ITEM_HEIGHT));
    };

    switch (e.key) {
      case 'ArrowDown':
        moveFocus(viewMode === 'grid' ? gridColumns : 1);
        break;
      case 'ArrowUp':
        moveFocus(viewMode === 'grid' ? -gridColumns : -1);
        break;
      case 'ArrowRight':
        if (viewMode === 'grid') moveFocus(1);
        break;
      case 'ArrowLeft':
        if (viewMode === 'grid') moveFocus(-1);
        break;
      case 'Home':
        focusIndex(0);
        break;
      case 'End':
        focusIndex(items.length - 1);
        break;
      case 'PageDown':
        moveFocus(getPageDelta());
        break;
      case 'PageUp':
        moveFocus(-getPageDelta());
        break;
      case 'Enter': {
        if (anchorIndex >= 0 && selectedIds.size === 1) {
          e.preventDefault();
          onOpen(items[anchorIndex]);
        }
        break;
      }
      case 'F2': {
        if (anchorIndex >= 0 && selectedIds.size === 1 && onRequestRename) {
          e.preventDefault();
          onRequestRename(items[anchorIndex]);
        }
        break;
      }
      default: {
        // ★ Type-ahead：输入字符跳转到名称前缀匹配的项（文件管理器标配）
        if (
          e.key.length === 1 &&
          !e.ctrlKey && !e.metaKey && !e.altKey &&
          // 空缓冲时保留空格的默认行为（页面滚动）
          !(e.key === ' ' && typeAheadRef.current.buffer === '')
        ) {
          const now = Date.now();
          const state = typeAheadRef.current;
          if (now - state.lastTime > TYPE_AHEAD_TIMEOUT_MS) {
            state.buffer = '';
          }
          state.lastTime = now;
          state.buffer += e.key.toLowerCase();

          // 重复敲同一个字母 = 在以该字母开头的项之间循环（Explorer 语义）
          const isRepeatedChar = state.buffer.length > 1 &&
            state.buffer.split('').every(c => c === state.buffer[0]);
          const prefix = isRepeatedChar ? state.buffer[0] : state.buffer;
          // 累积前缀从当前项开始找（含当前项）；单字符/循环模式从下一项开始找
          const startIndex = anchorIndex < 0
            ? 0
            : (prefix.length === 1 ? anchorIndex + 1 : anchorIndex);

          for (let offset = 0; offset < items.length; offset++) {
            const idx = (startIndex + offset) % items.length;
            if (items[idx].name.toLowerCase().startsWith(prefix)) {
              e.preventDefault();
              keyboardAnchorRef.current = items[idx].id;
              selectionPivotRef.current = items[idx].id;
              onSelect(items[idx].id, 'single');
              scrollItemIntoView(idx);
              break;
            }
          }
        }
        break;
      }
    }
  }, [editingId, items, selectedIds, viewMode, gridColumns, onSelect, onSelectionChange, onOpen, onRequestRename, scrollItemIntoView]);

  // Notion 风格的加载状态
  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background">
        <div className="relative">
          {/* 优雅的加载动画 */}
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center animate-pulse">
            <CircleNotch size={24} className="text-primary animate-spin" />
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground/70 finder-fade-in">
          {t('finder.loading.resources')}
        </p>
      </div>
    );
  }

  // Notion 风格的错误状态
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background px-4">
        <div className="w-14 h-14 rounded-xl bg-destructive/10 flex items-center justify-center mb-4">
          <WarningCircle size={26} weight="duotone" className="text-destructive/80" aria-hidden />
        </div>
        <p className="text-sm font-medium text-destructive mb-1">{t('finder.error.title', '加载失败')}</p>
        <p className="text-xs text-muted-foreground/70 text-center max-w-[280px] mb-4">{error}</p>
        {onRetry && (
          <NotionButton
            variant="default"
            size="sm"
            onClick={onRetry}
          >
            <ArrowClockwise size={14} className="mr-1.5" />
            {t('finder.error.retry', '重新加载')}
          </NotionButton>
        )}
      </div>
    );
  }

  // Notion 风格的空状态 - 更精致的设计
  if (items.length === 0) {
    return (
      <div 
        className="flex-1 flex flex-col items-center justify-center bg-background select-none px-4"
        onClick={handleContainerClick}
        onContextMenu={handleContainerContextMenu}
      >
        {/* 空状态图标 */}
        <div className="mb-5">
          <FolderOpen size={40} className="text-muted-foreground/40" strokeWidth={1.2} />
        </div>
        
        <p className="text-[15px] font-medium text-foreground/80 mb-1">
          {emptyMessage || t('finder.empty.folder')}
        </p>
        <p className="text-[13px] text-muted-foreground/60 text-center max-w-[240px]">
          {t(isSmallScreen ? 'finder.empty.dropHintTouch' : 'finder.empty.dropHint')}
        </p>

        {/* ★ 可操作的新建入口：直接在点击位置打开与右键相同的新建菜单 */}
        {onContainerContextMenu && (
          <NotionButton
            variant="default"
            size="sm"
            className="mt-4"
            onClick={(e) => {
              e.stopPropagation();
              onContainerContextMenu(e);
            }}
          >
            <Plus size={14} className="mr-1.5" />
            {t('finder.toolbar.new')}
          </NotionButton>
        )}

        {/* 快捷操作提示（桌面端） */}
        {!isSmallScreen && (
        <div className="mt-6 flex items-center gap-2 text-[11px] text-muted-foreground/40">
          <kbd className="px-1.5 py-0.5 rounded bg-muted/60 font-mono">{t('finder.empty.rightClick')}</kbd>
          <span>{t('finder.empty.contextMenuHint', '新建文件')}</span>
        </div>
        )}
      </div>
    );
  }

  // 列表模式 - Notion 风格的虚拟滚动列表
  if (viewMode === 'list') {
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <CustomScrollArea
          ref={scrollAreaRef}
          viewportRef={viewportRef}
          className="flex-1 bg-background h-full outline-none"
          onClick={handleContainerClick}
          onDoubleClick={handleContainerDoubleClick}
          onContextMenu={handleContainerContextMenu}
          onMouseDown={handleContainerMouseDown}
          tabIndex={0}
          onKeyDown={handleKeyboardNavigation}
          role="listbox"
          aria-multiselectable={true}
        >
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            {/* Notion 风格：添加少量内边距 */}
            {/* ★ 2026-06-12（审阅问题 FE-M3）：绑定 containerRef 使框选在列表模式可用 */}
            <div
              ref={containerRef}
              className="py-1"
              style={{
                height: `${listVirtualizer.getTotalSize() + 8}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {listVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index];
                if (!item) return null;

                return (
                  <div
                    key={item.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <FinderFileRow
                      item={item}
                      viewMode={viewMode}
                      isSelected={selectedIds.has(item.id)}
                      isActive={activeFileId === item.id}
                      isHighlighted={highlightedIds?.has(item.id)}
                      onSelect={onSelect}
                      onOpen={onOpen}
                      onContextMenu={onContextMenu}
                      enableDrag={enableDragDrop && editingId !== item.id}
                      isEditing={editingId === item.id}
                      onEditConfirm={onEditConfirm}
                      onEditCancel={onEditCancel}
                      compact={compact}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </CustomScrollArea>

        {/* Notion 风格的拖拽覆盖层 */}
        <DragOverlay dropAnimation={{
          duration: 200,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)', // transitions-dev 主缓动（WAAPI 不支持 var()）
        }}>
          {activeItem && (
            <div className="relative">
              <FinderFileItem
                item={activeItem}
                viewMode={viewMode}
                isSelected={true}
                onSelect={() => {}}
                onOpen={() => {}}
                onContextMenu={() => {}}
                isDragOverlay
                compact={compact}
              />
              {dragCount > 1 && (
                <div className={cn(
                  "absolute -top-2 -right-2 bg-primary text-primary-foreground",
                  "text-[11px] font-semibold rounded-full min-w-[20px] h-5 px-1.5",
                  "flex items-center justify-center shadow-notion-lg",
                  "finder-pop-in"
                )}>
                  {dragCount}
                </div>
              )}
            </div>
          )}
        </DragOverlay>

        {/* ★ 2026-06-12（审阅问题 FE-M3）：列表模式框选矩形 */}
        {isSelecting && selectionRect && (
          <SelectionBoxOverlay rect={selectionRect} />
        )}
      </DndContext>
    );
  }

  // Grid 模式 - Notion 风格的网格布局
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <CustomScrollArea
        ref={scrollAreaRef}
        viewportRef={viewportRef}
        className="flex-1 bg-background h-full outline-none"
        viewportClassName="py-3 pr-3 pl-1.5 sm:pl-3"
        onClick={handleContainerClick}
        onDoubleClick={handleContainerDoubleClick}
        onContextMenu={handleContainerContextMenu}
        onMouseDown={handleContainerMouseDown}
        tabIndex={0}
        onKeyDown={handleKeyboardNavigation}
        role="listbox"
        aria-multiselectable={true}
      >
        <SortableContext
          items={itemIds}
          strategy={rectSortingStrategy}
        >
          {/* ★ 网格模式虚拟滚动：外层容器用于 ResizeObserver */}
          <div 
            ref={gridContainerRef}
            className="w-full"
          >
            {/* ★ 虚拟滚动容器 */}
            <div
              ref={containerRef}
              className="relative"
              style={{
                height: `${gridVirtualizer.getTotalSize()}px`,
              }}
            >
              {gridVirtualizer.getVirtualItems().map((virtualRow) => {
                const startIndex = virtualRow.index * gridColumns;
                const rowItems = items.slice(startIndex, startIndex + gridColumns);
                
                return (
                  <div
                    key={virtualRow.key}
                    className="absolute top-0 left-0 right-0 grid gap-2 justify-items-start"
                    style={{
                      // 与列表模式一致：用 transform 定位虚拟行，避免 top 变化触发布局
                      transform: `translateY(${virtualRow.start}px)`,
                      height: `${GRID_ROW_HEIGHT}px`,
                      gridTemplateColumns: `repeat(${gridColumns}, ${GRID_ITEM_WIDTH}px)`,
                    }}
                  >
                    {rowItems.map(item => (
                      <FinderFileRow
                        key={item.id}
                        item={item}
                        viewMode={viewMode}
                        isSelected={selectedIds.has(item.id)}
                        isActive={activeFileId === item.id}
                        isHighlighted={highlightedIds?.has(item.id)}
                        onSelect={onSelect}
                        onOpen={onOpen}
                        onContextMenu={onContextMenu}
                        enableDrag={enableDragDrop && editingId !== item.id}
                        isEditing={editingId === item.id}
                        onEditConfirm={onEditConfirm}
                        onEditCancel={onEditCancel}
                        compact={compact}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </SortableContext>
      </CustomScrollArea>

      {/* Notion 风格的拖拽覆盖层 */}
      <DragOverlay dropAnimation={{
        duration: 200,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)', // transitions-dev 主缓动（WAAPI 不支持 var()）
      }}>
        {activeItem && (
          <div className="relative">
            <FinderFileItem
              item={activeItem}
              viewMode={viewMode}
              isSelected={true}
              onSelect={() => {}}
              onOpen={() => {}}
              onContextMenu={() => {}}
              isDragOverlay
              compact={compact}
            />
            {dragCount > 1 && (
              <div className={cn(
                "absolute -top-2 -right-2 bg-primary text-primary-foreground",
                "text-[11px] font-semibold rounded-full min-w-[20px] h-5 px-1.5",
                "flex items-center justify-center shadow-notion-lg",
                "finder-pop-in"
              )}>
                {dragCount}
              </div>
            )}
          </div>
        )}
      </DragOverlay>

      {/* ★ 框选选择框 */}
      {isSelecting && selectionRect && (
        <SelectionBoxOverlay rect={selectionRect} />
      )}
    </DndContext>
  );
}
