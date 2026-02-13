import React, { useRef, useCallback, useMemo, useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, FolderOpen, Plus, FileText, RefreshCw } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DndContext,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import type { DstuNode } from '@/dstu/types';
import type { ViewMode } from '../../stores/finderStore';
import { FinderFileItem, SortableFinderFileItem } from './FinderFileItem';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useSelectionBox, getSelectionBoxStyle, SelectionBoxRect } from './useSelectionBox';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// Notion 风格：更大的列表项高度
const LIST_ITEM_HEIGHT = 52;

// 网格模式虚拟滚动常量
const GRID_ITEM_MIN_WIDTH = 88;  // minmax(88px, 1fr)
const GRID_GAP = 8;              // gap-2 = 0.5rem = 8px
const GRID_ROW_HEIGHT = 120;     // 网格行高度（包含内容）
const GRID_PADDING = 12;         // p-3 = 0.75rem = 12px

/**
 * 选择框覆盖层组件 - 使用 Portal 渲染到 body 下避免父元素 transform 影响
 */
function SelectionBoxOverlay({ rect }: { rect: SelectionBoxRect }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lastDebugTimeRef = useRef<number>(0);
  
  useEffect(() => {
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
}: FinderFileListProps) {
  const { t } = useTranslation('learningHub');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);
  
  // ★ 网格模式虚拟滚动：容器宽度状态
  const [gridContainerWidth, setGridContainerWidth] = useState(0);
  
  // ★ 计算网格列数
  const gridColumns = useMemo(() => {
    // 计算可容纳的列数：(containerWidth + gap) / (minItemWidth + gap)
    // 这与 CSS grid auto-fill 的行为一致
    let availableWidth = gridContainerWidth;
    
    // ★ Fallback：如果容器宽度尚未测量，使用窗口宽度的估算值
    // 假设左侧边栏约 260px，减去 padding 后的主内容区域宽度
    if (availableWidth === 0 && typeof window !== 'undefined') {
      availableWidth = Math.max(window.innerWidth - 300, 400);
    }
    
    const cols = Math.floor((availableWidth + GRID_GAP) / (GRID_ITEM_MIN_WIDTH + GRID_GAP));
    return Math.max(1, cols);
  }, [gridContainerWidth]);
  
  // ★ 网格模式虚拟滚动：使用 useLayoutEffect 在绘制前获取初始宽度
  // 这比 useEffect 更早执行，可以避免首次渲染时显示单列布局
  useLayoutEffect(() => {
    if (viewMode !== 'grid') return;
    
    const container = gridContainerRef.current;
    if (!container) return;
    
    // 立即同步获取容器宽度（gridContainerRef 在 viewport 内部，已排除 padding）
    const initialWidth = container.getBoundingClientRect().width;
    if (initialWidth > 0) {
      setGridContainerWidth(initialWidth);
    }
  }, [viewMode]);

  // ★ 网格模式虚拟滚动：监听容器宽度变化（用于响应式调整）
  useEffect(() => {
    if (viewMode !== 'grid') return;
    
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
  }, [viewMode]);

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

  // DnD 传感器配置
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 拖动 8px 后激活
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
    window.dispatchEvent(new CustomEvent('finder-drag-debug', {
      detail: {
        type: 'drag_start',
        activeId: event.active.id,
        timestamp: Date.now(),
      }
    }));
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
    window.dispatchEvent(new CustomEvent('finder-drag-debug', {
      detail: {
        type: 'drag_end',
        activeId: active.id,
        overId: over?.id ?? null,
        timestamp: Date.now(),
      }
    }));

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

  // 容器点击
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget && onContainerClick) {
      onContainerClick();
    }
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

  // Notion 风格的加载状态
  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background">
        <div className="relative">
          {/* 优雅的加载动画 */}
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center animate-pulse">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground/70 animate-fade-in">
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
          <span className="text-2xl">⚠️</span>
        </div>
        <p className="text-sm font-medium text-destructive mb-1">{t('finder.error.title', '加载失败')}</p>
        <p className="text-xs text-muted-foreground/70 text-center max-w-[280px] mb-4">{error}</p>
        {onRetry && (
          <NotionButton
            variant="default"
            size="sm"
            onClick={onRetry}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
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
          <FolderOpen className="w-10 h-10 text-muted-foreground/40" strokeWidth={1.2} />
        </div>
        
        <p className="text-[15px] font-medium text-foreground/80 mb-1">
          {emptyMessage || t('finder.empty.folder')}
        </p>
        <p className="text-[13px] text-muted-foreground/60 text-center max-w-[240px]">
          {t('finder.empty.dropHint')}
        </p>
        
        {/* 快捷操作提示 */}
        <div className="mt-6 flex items-center gap-2 text-[11px] text-muted-foreground/40">
          <kbd className="px-1.5 py-0.5 rounded bg-muted/60 font-mono">{t('finder.empty.rightClick')}</kbd>
          <span>{t('finder.empty.contextMenuHint', '新建文件')}</span>
        </div>
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
          className="flex-1 bg-background h-full"
          onClick={handleContainerClick}
          onContextMenu={handleContainerContextMenu}
        >
          <SortableContext
            items={items.map(item => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {/* Notion 风格：添加少量内边距 */}
            <div
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
                    <SortableFinderFileItem
                      id={item.id}
                      item={item}
                      viewMode={viewMode}
                      isSelected={selectedIds.has(item.id)}
                      isActive={activeFileId === item.id}
                      onSelect={(mode) => onSelect(item.id, mode)}
                      onOpen={() => onOpen(item)}
                      onContextMenu={(e) => onContextMenu(e, item)}
                      enableDrag={enableDragDrop && editingId !== item.id}
                      isEditing={editingId === item.id}
                      onEditConfirm={(newName) => onEditConfirm?.(item.id, newName)}
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
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
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
                  "animate-pop-in"
                )}>
                  {dragCount}
                </div>
              )}
            </div>
          )}
        </DragOverlay>
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
        className="flex-1 bg-background h-full"
        viewportClassName="py-3 pr-3 pl-1.5 sm:pl-3"
        onClick={handleContainerClick}
        onDoubleClick={handleContainerDoubleClick}
        onContextMenu={handleContainerContextMenu}
        onMouseDown={handleMouseDown}
      >
        <SortableContext
          items={items.map(item => item.id)}
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
                    className="absolute left-0 right-0 grid gap-2"
                    style={{
                      top: `${virtualRow.start}px`,
                      height: `${GRID_ROW_HEIGHT}px`,
                      gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                    }}
                  >
                    {rowItems.map(item => (
                      <SortableFinderFileItem
                        key={item.id}
                        id={item.id}
                        item={item}
                        viewMode={viewMode}
                        isSelected={selectedIds.has(item.id)}
                        isActive={activeFileId === item.id}
                        onSelect={(mode) => onSelect(item.id, mode)}
                        onOpen={() => onOpen(item)}
                        onContextMenu={(e) => onContextMenu(e, item)}
                        enableDrag={enableDragDrop && editingId !== item.id}
                        isEditing={editingId === item.id}
                        onEditConfirm={(newName) => onEditConfirm?.(item.id, newName)}
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
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
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
                "animate-pop-in"
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
