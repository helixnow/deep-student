import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  MeasuringStrategy,
  UniqueIdentifier,
  DragOverlay,
  defaultDropAnimationSideEffects,
  DropAnimation,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Folder, FileText, Star } from 'lucide-react';
import { ReferenceIcon } from './ReferenceIcon';
import { TreeProvider } from './TreeContext';
import { TreeNode } from './TreeNode';
import { TreeData, TreeCallbacks, DragInfo } from './types';
import type { Modifier } from '@dnd-kit/core';
import './DndFileTree.css';

const LEVEL_INDENT = 20;
const BASE_INDENT = 8;
const DROP_INDICATOR_SIDE_GAP = 12;
const AUTO_EXPAND_DELAY_MS = 420;

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.5',
      },
    },
  }),
};

const restrictToVerticalAxis: Modifier = ({ transform }) => {
  if (!transform) return transform;
  return { ...transform, x: 0 };
};

interface DndFileTreeProps {
  treeData: TreeData;
  expandedIds?: string[];
  selectedIds?: string[];
  focusedId?: string;
  renamingId?: string | null;
  noteStatus?: Record<string, 'none' | 'pending' | 'ok'>;
  searchTerm?: string;
  highlightIds?: Set<string>;
  forcedExpandedIds?: string[] | null;
  disableExpandCollapse?: boolean;
  onExpand?: (id: string) => void;
  onCollapse?: (id: string) => void;
  onSelect?: (ids: string[]) => void;
  onFocus?: (id: string) => void;
  onRename?: (id: string, newName: string) => void;
  onDrop?: (dragInfo: DragInfo) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, event: React.MouseEvent) => void;
  onDelete?: (ids: string[]) => void;
  disableDrag?: boolean;
}

export function DndFileTree({
  treeData,
  expandedIds,
  selectedIds,
  focusedId,
  renamingId = null,
  noteStatus,
  searchTerm,
  highlightIds,
  forcedExpandedIds,
  disableExpandCollapse = false,
  onExpand,
  onCollapse,
  onSelect,
  onFocus,
  onRename,
  onDrop,
  onDoubleClick,
  onContextMenu,
  onDelete,
  disableDrag = false,
}: DndFileTreeProps) {
  const { t } = useTranslation('notes');
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside'>('inside');
  const treeRef = useRef<HTMLDivElement | null>(null);
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandCandidateRef = useRef<string | null>(null);
  
  // Use local state for expandedIds if not controlled externally
  const [localExpandedIds, setLocalExpandedIds] = useState<string[]>(expandedIds ?? []);
  
  // Effect to sync prop expandedIds to localExpandedIds only if provided (controlled mode)
  useEffect(() => {
    if (expandedIds !== undefined) {
      setLocalExpandedIds(expandedIds);
    }
  }, [expandedIds]);

  const expandedIdsRef = useRef<string[]>(forcedExpandedIds ?? localExpandedIds);
  const selectedIdsRef = useRef<string[]>(selectedIds ?? []);
  const draggedIdsRef = useRef<string[]>([]);
  const effectiveExpandedIds = forcedExpandedIds ?? localExpandedIds;
  const effectiveSelectedIds = selectedIds ?? [];
  const normalizedSearchTerm = searchTerm?.trim().toLowerCase() ?? '';
  const interactionsLocked = disableExpandCollapse && Boolean(normalizedSearchTerm);

  useEffect(() => {
    expandedIdsRef.current = effectiveExpandedIds;
  }, [effectiveExpandedIds]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  // Wrap external callbacks to update local state
  const handleExpand = useCallback((id: string) => {
    setLocalExpandedIds(prev => [...prev, id]);
    onExpand?.(id);
  }, [onExpand]);

  const handleCollapse = useCallback((id: string) => {
    setLocalExpandedIds(prev => prev.filter(expandedId => expandedId !== id));
    onCollapse?.(id);
  }, [onCollapse]);

  // 配置拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const flattenedNodes = useMemo(() => {
    const expandedSet = new Set(effectiveExpandedIds);
    const result: Array<{ id: string; depth: number }> = [];

    const visit = (nodeId: string, depth: number) => {
      const node = treeData[nodeId];
      if (!node) return;
      if (nodeId !== 'root') {
        result.push({ id: nodeId, depth });
      }
      if (!node.children || node.children.length === 0) return;
      
      // Only expand children if the current node is expanded or if it's the root
      if (nodeId !== 'root' && !expandedSet.has(nodeId)) return;
      
      const nextDepth = nodeId === 'root' ? depth : depth + 1;
      node.children.forEach((childId) => visit(childId, nextDepth));
    };

    visit('root', 0);
    return result;
  }, [treeData, effectiveExpandedIds]);

  const visibleNodeIds = useMemo(
    () => flattenedNodes.map((item) => item.id),
    [flattenedNodes],
  );

  const virtualizer = useVirtualizer({
    count: flattenedNodes.length,
    getScrollElement: () => treeRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [flattenedNodes, virtualizer]);

  const cancelAutoExpand = useCallback(() => {
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    autoExpandCandidateRef.current = null;
  }, []);

  const scheduleAutoExpand = useCallback((targetId: string) => {
    if (!handleExpand || interactionsLocked) return;
    if (expandedIdsRef.current.includes(targetId)) {
      cancelAutoExpand();
      return;
    }
    if (autoExpandCandidateRef.current === targetId) {
      return;
    }

    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
    }

    autoExpandCandidateRef.current = targetId;
    autoExpandTimerRef.current = setTimeout(() => {
      autoExpandTimerRef.current = null;
      const alreadyExpanded = expandedIdsRef.current.includes(targetId);
      autoExpandCandidateRef.current = null;
      if (!alreadyExpanded) {
        handleExpand(targetId);
      }
    }, AUTO_EXPAND_DELAY_MS);
  }, [cancelAutoExpand, handleExpand, interactionsLocked]);

  useEffect(() => {
    return cancelAutoExpand;
  }, [cancelAutoExpand]);

  // 计算拖放位置
  const calculateDropPosition = useCallback((event: DragOverEvent) => {
    if (!event.over) return 'inside';

    const overNode = treeData[String(event.over.id)];
    if (!overNode) return 'inside';

    const overRect = event.over.rect;
    const overTop = overRect?.top ?? 0;
    const overHeight = overRect?.height ?? 0;

    const activeRect = event.active.rect.current;
    const translatedRect = (activeRect as any)?.translated ?? activeRect;
    const translatedTop = (translatedRect as any)?.top ?? 0;
    const translatedHeight = (translatedRect as any)?.height ?? 0;
    const pointerMiddleY = translatedTop + translatedHeight / 2;

    if (overNode.isFolder) {
      // 文件夹：顶部1/3放 before，底部1/3放 after，中间放 inside
      let pos: 'before' | 'after' | 'inside';
      if (pointerMiddleY < overTop + overHeight / 3) pos = 'before';
      else if (pointerMiddleY > overTop + (overHeight * 2) / 3) pos = 'after';
      else pos = 'inside';

      // 优化：当目标文件夹未展开或为空时，将“after”解释为“inside”（更符合直觉）
      if (pos === 'after') {
        const isExpanded = effectiveExpandedIds.includes(String(event.over.id));
        const hasChildren = Array.isArray(overNode.children) && overNode.children.length > 0;
        if (!isExpanded || !hasChildren) {
          pos = 'inside';
        }
      }
      return pos;
    } else {
      // 文件：半分区分 before/after
      const relativeY = pointerMiddleY - overTop;
      return relativeY < overHeight / 2 ? 'before' : 'after';
    }
  }, [treeData, effectiveExpandedIds]);

  // 处理拖拽开始
  const handleDragStart = (event: DragStartEvent) => {
    if (disableDrag) return;
    const { active } = event;
    setActiveId(active.id);
    const activeIdStr = String(active.id);
    const currentSelection = selectedIdsRef.current.filter((id) => id !== 'root');
    if (currentSelection.includes(activeIdStr)) {
      draggedIdsRef.current = currentSelection.length ? currentSelection : [activeIdStr];
    } else {
      draggedIdsRef.current = [activeIdStr];
      onSelect?.([activeIdStr]);
    }
    if (dropIndicatorRef.current) {
      dropIndicatorRef.current.style.display = 'none';
    }
    cancelAutoExpand();
  };

  // 处理拖拽移动
  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;

    if (!over) {
      setOverId(null);
      setDropPosition('inside');
      cancelAutoExpand();
      return;
    }

    setOverId(over.id);
    const position = calculateDropPosition(event);
    setDropPosition(position);

    const overNode = treeData[String(over.id)];
    if (overNode?.isFolder && position === 'inside' && !interactionsLocked) {
      scheduleAutoExpand(String(over.id));
    } else {
      cancelAutoExpand();
    }

    // 更新拖放指示器位置
    if (dropIndicatorRef.current && over.rect) {
      const indicator = dropIndicatorRef.current;
      const rect = over.rect;
      const containerTop = treeRef.current?.getBoundingClientRect().top ?? 0;

      if (rect && typeof rect.top === 'number' && typeof rect.height === 'number') {
        if (position === 'before') {
          indicator.style.top = `${rect.top - containerTop}px`;
          indicator.style.display = 'block';
        } else if (position === 'after') {
          indicator.style.top = `${rect.top + rect.height - containerTop}px`;
          indicator.style.display = 'block';
        } else {
          indicator.style.display = 'none';
        }
      } else {
        indicator.style.display = 'none';
      }

      if (indicator.style.display === 'block') {
        const targetItem = treeRef.current?.querySelector<HTMLElement>(`[data-tree-id="${String(over.id)}"]`);
        if (targetItem) {
          const depthAttr = targetItem.getAttribute('data-tree-depth');
          const depth = depthAttr ? parseInt(depthAttr, 10) || 0 : 0;
          const indentLeft = Math.max(BASE_INDENT + depth * LEVEL_INDENT, DROP_INDICATOR_SIDE_GAP);
          indicator.style.left = `${indentLeft}px`;
          indicator.style.right = `${DROP_INDICATOR_SIDE_GAP}px`;
        } else {
          indicator.style.left = `${DROP_INDICATOR_SIDE_GAP}px`;
          indicator.style.right = `${DROP_INDICATOR_SIDE_GAP}px`;
        }
      }
    }
  };

  // 处理拖拽结束
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    setActiveId(null);
    setOverId(null);
    setDropPosition('inside');
    cancelAutoExpand();

    // 隐藏拖放指示器
    if (dropIndicatorRef.current) {
      dropIndicatorRef.current.style.display = 'none';
    }
    
    if (!over || active.id === over.id) {
      draggedIdsRef.current = [];
      return;
    }


    // 调用onDrop回调
    if (onDrop) {
      const draggedIds =
        draggedIdsRef.current.length > 0
          ? Array.from(new Set(draggedIdsRef.current))
          : [String(active.id)];
      onDrop({
        draggedIds,
        targetId: String(over.id),
        position: dropPosition,
      });
    }
    draggedIdsRef.current = [];
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setOverId(null);
    setDropPosition('inside');
    cancelAutoExpand();
    if (dropIndicatorRef.current) {
      dropIndicatorRef.current.style.display = 'none';
    }
    draggedIdsRef.current = [];
  };

  const matchesSet = useMemo(() => highlightIds ?? new Set<string>(), [highlightIds]);
  const virtualItems = virtualizer.getVirtualItems();
  const totalNodes = flattenedNodes.length;

  const callbacks: TreeCallbacks = {
    onExpand: handleExpand,
    onCollapse: handleCollapse,
    onSelect,
    onFocus,
    onRename,
    onDrop,
    onDoubleClick,
    onContextMenu,
    onDelete,
  };


  return (
    <TreeProvider
      treeData={treeData}
      initialExpanded={effectiveExpandedIds}
      initialSelected={selectedIds}
      focusedId={focusedId ?? null}
      renamingId={renamingId}
      forcedExpandedIds={forcedExpandedIds ?? null}
      callbacks={callbacks}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        measuring={{
          droppable: {
            strategy: MeasuringStrategy.Always,
          },
        }}
        modifiers={[restrictToVerticalAxis]}
        autoScroll={{ enabled: true, threshold: { x: 1, y: 0.25 } }}
      >
        <SortableContext
          items={visibleNodeIds}
          strategy={verticalListSortingStrategy}
        >
          <div
            className="rct-tree"
            role="tree"
            aria-multiselectable="true"
            ref={treeRef}
            aria-label={t('notes:tree.aria.tree')}
          >
            {/* 拖放指示器线 */}
            <div
              ref={dropIndicatorRef}
              className="dnd-drop-indicator"
              style={{ display: 'none' }}
            />
            
            {totalNodes === 0 ? (
              <div className="p-4 text-center text-muted-foreground">
                {t('notes:tree.empty')}
              </div>
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: 'relative',
                }}
              >
                {virtualItems.map((virtualItem) => {
                  const item = flattenedNodes[virtualItem.index];
                  if (!item) return null;
                  const node = treeData[item.id];
                  if (!node) return null;
                  const isMatch = matchesSet.has(item.id);
                  return (
                    <div
                      key={item.id}
                      style={{
                        position: 'absolute',
                        top: virtualItem.start,
                        left: 0,
                        right: 0,
                        height: virtualItem.size,
                      }}
                    >
                  <TreeNode
                    ref={virtualizer.measureElement}
                    id={item.id}
                    node={node}
                    depth={item.depth}
                    dataIndex={virtualItem.index}
                    draggingId={activeId ? String(activeId) : null}
                    overId={overId ? String(overId) : null}
                    dropPosition={dropPosition}
                    status={noteStatus?.[item.id]}
                    searchTerm={normalizedSearchTerm}
                    isSearchMatch={isMatch}
                    disableToggle={interactionsLocked}
                    disableDrag={interactionsLocked || disableDrag}
                  />
                </div>
                  );
                })}
              </div>
            )}
          </div>
        </SortableContext>

        {createPortal(
          <DragOverlay dropAnimation={dropAnimationConfig}>
            {activeId && treeData[String(activeId)] ? (() => {
              const node = treeData[String(activeId)];
              const isFavorite = !node.isFolder && !!node.data?.note?.is_favorite;
              const isReference = node.nodeType === 'reference';
              const sourceDb = node.referenceData?.referenceNode?.sourceDb;
              const previewType = node.referenceData?.referenceNode?.previewType;
              const dragCount = draggedIdsRef.current.length;
              return (
                <div className="dnd-drag-overlay">
                  <span className="dnd-drag-overlay-icon">
                    {node.isFolder ? (
                      <Folder className="w-4 h-4 text-primary fill-primary/20" />
                    ) : isReference && sourceDb ? (
                      <ReferenceIcon sourceDb={sourceDb} previewType={previewType} size="sm" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                    )}
                  </span>
                  <span className="dnd-drag-overlay-title">
                    {node.title}
                    {isFavorite && (
                      <Star className="w-3 h-3 ml-1.5 text-warning fill-warning inline-block" />
                    )}
                  </span>
                  {dragCount > 1 && (
                    <span className="dnd-drag-overlay-badge">{dragCount}</span>
                  )}
                </div>
              );
            })() : null}
          </DragOverlay>,
          document.body
        )}
      </DndContext>
    </TreeProvider>
  );
}
