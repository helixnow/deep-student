import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  closestCenter,
  defaultDropAnimationSideEffects,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { FileText, FolderSimple, TreeStructure } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import { cn } from '@/lib/utils';
import { calculateDropPosition, isInvalidFolderDrop } from './dropPosition';
import { animateTreeRowsExit, collectVisibleSubtreeRowIds } from './collapseMotion';
import {
  collectDescendantIds,
  excludeNestedIds,
  findItemById,
  flattenVisibleTree,
  isFolderItem,
  toExpandedSet,
} from './flatten';
import {
  resolveRangeSelection,
  resolveTreeKeyboardNav,
  resolveTypeaheadTarget,
} from './keyboard';
import { TreeContextMenu } from './TreeContextMenu';
import { TreeRow } from './TreeRow';
import {
  AUTO_EXPAND_DELAY_MS,
  BASE_INDENT_PX,
  DROP_INDICATOR_SIDE_GAP_PX,
  LEVEL_INDENT_PX,
  NOTES_WORKSPACE_TREE_ROOT_ID,
  TYPEAHEAD_TTL_MS,
  type ContextMenuState,
  type NotesWorkspaceDropPosition,
  type NotesWorkspaceTreeItem,
  type NotesWorkspaceTreeProps,
} from './types';
import './NotesWorkspaceTree.css';

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.5' } },
  }),
};

const restrictToVerticalAxis: Modifier = ({ transform }) => {
  if (!transform) return transform;
  return { ...transform, x: 0 };
};

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x, y };
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 176)),
    y: Math.max(8, Math.min(y, window.innerHeight - 160)),
  };
}

function collectExpandableFolderIds(
  items: readonly NotesWorkspaceTreeItem[],
): string[] {
  const ids: string[] = [];
  const visit = (nodes: readonly NotesWorkspaceTreeItem[]) => {
    for (const node of nodes) {
      if (isFolderItem(node) && node.children?.length) {
        ids.push(node.id);
        visit(node.children);
      }
    }
  };
  visit(items);
  return ids;
}

export function NotesWorkspaceTree({
  items,
  expandedIds,
  selectedId,
  selectedIds: controlledSelectedIds,
  activeId = null,
  renamingId = null,
  showRoot = true,
  rootLabel,
  disableDrag = false,
  className,
  'aria-label': ariaLabel,
  'aria-busy': ariaBusy,
  onToggleExpand,
  onSelect,
  onSelectionChange,
  onOpen,
  onMove,
  onMoveMany,
  onRename,
  onDelete,
  onDeleteMany,
  onRenameStart,
  onRenameEnd,
  getMenuItems,
  onContextMenuOpen,
  onExpand,
}: NotesWorkspaceTreeProps) {
  const { t } = useTranslation('workbench');
  const sensors = useTouchFriendlyDndSensors();
  const treeRef = useRef<HTMLDivElement | null>(null);
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandCandidateRef = useRef<string | null>(null);
  const dropPositionRef = useRef<NotesWorkspaceDropPosition>('inside');
  const dropInvalidRef = useRef(false);
  const draggedIdsRef = useRef<string[]>([]);
  const draggedDescendantsRef = useRef<ReadonlySet<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(selectedId);
  const lastLeadRef = useRef<string | null>(selectedId);
  const typeaheadBufferRef = useRef('');
  const typeaheadDeadlineRef = useRef(0);

  const [activeDragId, setActiveDragId] = useState<UniqueIdentifier | null>(null);
  const [draggedIds, setDraggedIds] = useState<string[]>([]);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<NotesWorkspaceDropPosition>('inside');
  const [dropInvalid, setDropInvalid] = useState(false);
  const [internalRenamingId, setInternalRenamingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [internalSelectedIds, setInternalSelectedIds] = useState<ReadonlySet<string> | null>(null);

  const expandedSet = useMemo(() => toExpandedSet(expandedIds), [expandedIds]);
  const expandedRef = useRef(expandedSet);
  expandedRef.current = expandedSet;

  const rows = useMemo(
    () => flattenVisibleTree(items, expandedSet),
    [items, expandedSet],
  );
  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);

  const effectiveRenamingId = renamingId ?? internalRenamingId;

  // Effective multi-selection: controlled prop wins; otherwise the internal
  // set once a multi interaction happened; otherwise mirror `selectedId`.
  const selectionSet = useMemo<ReadonlySet<string>>(() => {
    if (controlledSelectedIds) return toExpandedSet(controlledSelectedIds);
    if (internalSelectedIds) return internalSelectedIds;
    return selectedId ? new Set([selectedId]) : new Set();
  }, [controlledSelectedIds, internalSelectedIds, selectedId]);
  const selectionRef = useRef(selectionSet);
  selectionRef.current = selectionSet;

  // Host-driven selectedId changes (not echoes of our own onSelect calls)
  // collapse the internal multi-selection back to the single row.
  useEffect(() => {
    if (selectedId === lastLeadRef.current) return;
    lastLeadRef.current = selectedId;
    selectionAnchorRef.current = selectedId;
    setInternalSelectedIds(null);
    setFocusedId(selectedId);
  }, [selectedId]);

  const applySelection = useCallback((ids: readonly string[], anchor: string | null) => {
    selectionAnchorRef.current = anchor;
    setInternalSelectedIds(new Set(ids));
    onSelectionChange?.([...ids]);
  }, [onSelectionChange]);

  const notifyLead = useCallback((id: string | null) => {
    lastLeadRef.current = id;
    onSelect(id);
  }, [onSelect]);

  const cancelAutoExpand = useCallback(() => {
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    autoExpandCandidateRef.current = null;
  }, []);

  useEffect(() => cancelAutoExpand, [cancelAutoExpand]);

  const expandFolder = useCallback((id: string) => {
    if (expandedRef.current.has(id)) return;
    if (onExpand) onExpand(id);
    else onToggleExpand(id);
  }, [onExpand, onToggleExpand]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  /**
   * 折叠动画版 toggle：折叠展开中的文件夹时，先对其可见后代行播
   * 高度收拢退场（WAAPI，见 collapseMotion.ts），动画结束再提交给宿主；
   * 展开路径立即提交，行入场沿用 CSS 的 nwt-row-reveal 淡入。
   * 批量展开/折叠（toggleExpandAll）不走此路径——嵌套子树会重复动画。
   */
  const toggleExpandAnimated = useCallback((id: string) => {
    if (expandedRef.current.has(id)) {
      const item = findItemById(items, id);
      if (item && isFolderItem(item)) {
        animateTreeRowsExit(
          treeRef.current,
          collectVisibleSubtreeRowIds(rowsRef.current, id),
          () => onToggleExpand(id),
        );
        return;
      }
    }
    onToggleExpand(id);
  }, [items, onToggleExpand]);

  const scheduleAutoExpand = useCallback((targetId: string) => {
    if (expandedRef.current.has(targetId)) {
      cancelAutoExpand();
      return;
    }
    if (autoExpandCandidateRef.current === targetId) return;
    if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current);
    autoExpandCandidateRef.current = targetId;
    autoExpandTimerRef.current = setTimeout(() => {
      autoExpandTimerRef.current = null;
      autoExpandCandidateRef.current = null;
      if (!expandedRef.current.has(targetId)) {
        expandFolder(targetId);
      }
    }, AUTO_EXPAND_DELAY_MS);
  }, [cancelAutoExpand, expandFolder]);

  const hideDropIndicator = useCallback(() => {
    const indicator = dropIndicatorRef.current;
    if (!indicator) return;
    indicator.style.display = 'none';
    indicator.dataset.invalid = 'false';
  }, []);

  const updateDropIndicator = useCallback((
    overRect: { top: number; height: number } | null | undefined,
    position: NotesWorkspaceDropPosition,
    targetId: string,
    depth: number,
    invalid: boolean,
  ) => {
    const indicator = dropIndicatorRef.current;
    const tree = treeRef.current;
    if (!indicator || !tree || !overRect) {
      hideDropIndicator();
      return;
    }
    if (position === 'inside') {
      hideDropIndicator();
      return;
    }
    const containerTop = tree.getBoundingClientRect().top;
    indicator.style.display = 'block';
    indicator.style.top = position === 'before'
      ? `${overRect.top - containerTop}px`
      : `${overRect.top + overRect.height - containerTop}px`;
    const indentLeft = Math.max(
      BASE_INDENT_PX + depth * LEVEL_INDENT_PX,
      DROP_INDICATOR_SIDE_GAP_PX,
    );
    indicator.style.left = `${indentLeft}px`;
    indicator.style.right = `${DROP_INDICATOR_SIDE_GAP_PX}px`;
    indicator.dataset.targetId = targetId;
    indicator.dataset.invalid = invalid ? 'true' : 'false';
  }, [hideDropIndicator]);

  const resolvePointerY = (event: DragOverEvent): number => {
    const activeRect = event.active.rect.current;
    const translated = (activeRect as { translated?: { top?: number; height?: number } } | null)?.translated
      ?? (activeRect as { top?: number; height?: number } | null);
    const top = translated?.top ?? 0;
    const height = translated?.height ?? 0;
    return top + height / 2;
  };

  const handleDragStart = (event: DragStartEvent) => {
    if (disableDrag) return;
    const dragId = String(event.active.id);
    setActiveDragId(event.active.id);
    setOverId(null);
    setDropPosition('inside');
    dropPositionRef.current = 'inside';
    setDropInvalid(false);
    dropInvalidRef.current = false;
    hideDropIndicator();
    cancelAutoExpand();

    const selection = selectionRef.current;
    let dragged: string[];
    if (selection.has(dragId) && selection.size > 1) {
      dragged = excludeNestedIds(items, selection);
    } else {
      dragged = [dragId];
      applySelection([dragId], dragId);
      notifyLead(dragId);
    }
    draggedIdsRef.current = dragged;
    setDraggedIds(dragged);

    const descendants = new Set<string>();
    for (const id of dragged) {
      const item = findItemById(items, id);
      if (item && isFolderItem(item)) {
        for (const childId of collectDescendantIds(items, id)) {
          descendants.add(childId);
        }
      }
    }
    draggedDescendantsRef.current = descendants;
  };

  const isInvalidDropTarget = useCallback((
    targetId: string,
    position: NotesWorkspaceDropPosition,
  ): boolean => {
    if (targetId === NOTES_WORKSPACE_TREE_ROOT_ID) return false;
    const dragged = draggedIdsRef.current;
    if (dragged.includes(targetId)) return true;
    if (dragged.length === 1) {
      const dragItem = findItemById(items, dragged[0]);
      if (dragItem && isFolderItem(dragItem)) {
        return isInvalidFolderDrop(
          dragged[0],
          targetId,
          position,
          draggedDescendantsRef.current,
        );
      }
      return false;
    }
    return draggedDescendantsRef.current.has(targetId);
  }, [items]);

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setOverId(null);
      setDropPosition('inside');
      dropPositionRef.current = 'inside';
      setDropInvalid(false);
      dropInvalidRef.current = false;
      cancelAutoExpand();
      hideDropIndicator();
      return;
    }

    const targetId = String(over.id);
    setOverId(over.id);

    if (targetId === NOTES_WORKSPACE_TREE_ROOT_ID) {
      setDropPosition('inside');
      dropPositionRef.current = 'inside';
      setDropInvalid(false);
      dropInvalidRef.current = false;
      cancelAutoExpand();
      hideDropIndicator();
      return;
    }

    const targetItem = findItemById(items, targetId);
    if (!targetItem) return;

    const isFolder = isFolderItem(targetItem);
    const position = calculateDropPosition({
      isFolder,
      isExpanded: expandedSet.has(targetId),
      hasChildren: Boolean(targetItem.children?.length),
      overTop: over.rect.top,
      overHeight: over.rect.height,
      pointerY: resolvePointerY(event),
    });
    setDropPosition(position);
    dropPositionRef.current = position;

    const invalid = isInvalidDropTarget(targetId, position);
    setDropInvalid(invalid);
    dropInvalidRef.current = invalid;

    if (isFolder && position === 'inside' && !invalid) {
      scheduleAutoExpand(targetId);
    } else {
      cancelAutoExpand();
    }

    const row = rows.find((entry) => entry.id === targetId);
    updateDropIndicator(over.rect, position, targetId, row?.depth ?? 0, invalid);
  };

  const resetDragState = () => {
    setActiveDragId(null);
    setDraggedIds([]);
    setOverId(null);
    setDropPosition('inside');
    dropPositionRef.current = 'inside';
    setDropInvalid(false);
    cancelAutoExpand();
    hideDropIndicator();
    draggedIdsRef.current = [];
    draggedDescendantsRef.current = new Set();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const position = dropPositionRef.current;
    const targetId = over ? String(over.id) : null;
    const invalid = dropInvalidRef.current
      || (targetId !== null && isInvalidDropTarget(targetId, position));
    const dragged = draggedIdsRef.current.length
      ? [...draggedIdsRef.current]
      : [String(active.id)];
    resetDragState();
    dropInvalidRef.current = false;

    if (targetId === null || invalid) return;
    if (dragged.includes(targetId)) return;

    if (onMoveMany) {
      onMoveMany(dragged, targetId, position);
      return;
    }
    // `after` inserts each id right after the target, so iterate in reverse
    // to keep the original visual order in the destination.
    const ordered = position === 'after' ? [...dragged].reverse() : dragged;
    for (const dragId of ordered) {
      onMove(dragId, targetId, position);
    }
  };

  const handleDragCancel = () => {
    resetDragState();
    dropInvalidRef.current = false;
  };

  const beginRename = useCallback((id: string) => {
    const item = findItemById(items, id);
    if (!item || item.canRename === false) return;
    if (onRenameStart) onRenameStart(id);
    else setInternalRenamingId(id);
  }, [items, onRenameStart]);

  const endRename = useCallback(() => {
    if (onRenameEnd) onRenameEnd();
    setInternalRenamingId(null);
  }, [onRenameEnd]);

  const commitRename = useCallback((id: string, name: string) => {
    onRename(id, name);
    endRename();
  }, [endRename, onRename]);

  const focusRowDom = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector<HTMLElement>(`[data-nwt-id="${id}"]`);
      el?.focus();
    });
  }, []);

  const openMenu = useCallback((
    item: NotesWorkspaceTreeItem,
    event: { clientX: number; clientY: number; preventDefault?: () => void },
  ) => {
    event.preventDefault?.();
    onContextMenuOpen?.(item, event);
    if (!getMenuItems) return;
    const menuItems = getMenuItems(item, {
      beginRename: () => beginRename(item.id),
    });
    if (!menuItems.length) return;
    const pos = clampMenuPosition(event.clientX, event.clientY);
    setContextMenu({ item, x: pos.x, y: pos.y });
  }, [beginRename, getMenuItems, onContextMenuOpen]);

  const closeMenu = useCallback(() => {
    setContextMenu((current) => {
      if (current) focusRowDom(current.item.id);
      return null;
    });
  }, [focusRowDom]);

  const focusRow = useCallback((id: string) => {
    const lead = id === NOTES_WORKSPACE_TREE_ROOT_ID ? null : id;
    applySelection(lead ? [lead] : [], lead);
    setFocusedId(lead);
    notifyLead(lead);
    focusRowDom(id);
  }, [applySelection, focusRowDom, notifyLead]);

  const handleRowClick = useCallback((
    item: NotesWorkspaceTreeItem,
    event: React.MouseEvent,
  ) => {
    if (event.shiftKey) {
      const anchor = selectionAnchorRef.current ?? selectedId ?? item.id;
      const range = resolveRangeSelection(rows, anchor, item.id);
      applySelection(range, anchor);
      setFocusedId(item.id);
      notifyLead(item.id);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectionRef.current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      const ordered = visibleIds.filter((id) => next.has(id));
      applySelection(ordered, item.id);
      setFocusedId(item.id);
      if (next.has(item.id)) notifyLead(item.id);
      return;
    }
    applySelection([item.id], item.id);
    setFocusedId(item.id);
    notifyLead(item.id);
    if (isFolderItem(item)) toggleExpandAnimated(item.id);
    else onOpen(item.id);
  }, [applySelection, notifyLead, onOpen, toggleExpandAnimated, rows, selectedId, visibleIds]);

  const handleRootSelect = useCallback(() => {
    applySelection([], null);
    setFocusedId(null);
    notifyLead(null);
  }, [applySelection, notifyLead]);

  const deleteSelection = useCallback((currentId: string) => {
    if (!onDelete && !onDeleteMany) return false;
    const selection = selectionRef.current;
    const batchIds = selection.has(currentId) && selection.size > 1
      ? visibleIds.filter((id) => selection.has(id))
      : [currentId];
    const batchItems = batchIds
      .map((id) => findItemById(items, id))
      .filter((item): item is NotesWorkspaceTreeItem => item !== null);
    if (!batchItems.length) return false;
    if (batchItems.length > 1 && onDeleteMany) {
      onDeleteMany(batchItems);
      return true;
    }
    if (!onDelete) {
      onDeleteMany?.(batchItems);
      return true;
    }
    for (const item of batchItems) {
      onDelete(item);
    }
    return true;
  }, [items, onDelete, onDeleteMany, visibleIds]);

  const extendSelectionTo = useCallback((currentId: string, targetIndex: number) => {
    const clamped = Math.max(0, Math.min(visibleIds.length - 1, targetIndex));
    const targetId = visibleIds[clamped];
    if (!targetId) return;
    const anchor = selectionAnchorRef.current
      ?? (currentId !== NOTES_WORKSPACE_TREE_ROOT_ID ? currentId : targetId);
    const range = resolveRangeSelection(rows, anchor, targetId);
    applySelection(range, anchor);
    setFocusedId(targetId);
    notifyLead(targetId);
    focusRowDom(targetId);
  }, [applySelection, focusRowDom, notifyLead, rows, visibleIds]);

  const toggleExpandAll = useCallback(() => {
    const folderIds = collectExpandableFolderIds(items);
    if (!folderIds.length) return;
    const collapsed = folderIds.filter((id) => !expandedRef.current.has(id));
    if (collapsed.length) {
      for (const id of collapsed) expandFolder(id);
      return;
    }
    for (const id of folderIds) {
      if (expandedRef.current.has(id)) onToggleExpand(id);
    }
  }, [expandFolder, items, onToggleExpand]);

  const handleTypeahead = useCallback((currentId: string, char: string): boolean => {
    const now = Date.now();
    typeaheadBufferRef.current = now <= typeaheadDeadlineRef.current
      ? typeaheadBufferRef.current + char
      : char;
    typeaheadDeadlineRef.current = now + TYPEAHEAD_TTL_MS;
    const target = resolveTypeaheadTarget({
      query: typeaheadBufferRef.current,
      currentId,
      rows,
    });
    if (target && target !== currentId) {
      focusRow(target);
    }
    return target !== null;
  }, [focusRow, rows]);

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (effectiveRenamingId) return;
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-nwt-item]')
      : null;
    if (!target) return;
    const currentId = target.dataset.nwtId;
    if (!currentId) return;

    if ((event.key === 'Delete' || event.key === 'Backspace') && currentId !== NOTES_WORKSPACE_TREE_ROOT_ID) {
      if (deleteSelection(currentId)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End')) {
      const index = visibleIds.indexOf(currentId);
      let targetIndex: number;
      if (event.key === 'Home') targetIndex = 0;
      else if (event.key === 'End') targetIndex = visibleIds.length - 1;
      else if (index === -1) targetIndex = event.key === 'ArrowDown' ? 0 : visibleIds.length - 1;
      else targetIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
      event.preventDefault();
      extendSelectionTo(currentId, targetIndex);
      return;
    }

    const wantsMenuKey = event.key === 'ContextMenu'
      || (event.key === 'Enter' && event.altKey)
      || (event.key === 'F10' && event.shiftKey);
    if (wantsMenuKey && currentId !== NOTES_WORKSPACE_TREE_ROOT_ID) {
      const item = findItemById(items, currentId);
      if (item) {
        event.preventDefault();
        const rect = target.getBoundingClientRect();
        openMenu(item, {
          clientX: rect.left + Math.min(rect.width / 2, 160),
          clientY: rect.bottom,
          preventDefault: () => {},
        });
      }
      return;
    }

    if (event.key === '*' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      toggleExpandAll();
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      handleTypeahead(currentId, event.key);
      return;
    }

    const result = resolveTreeKeyboardNav({
      key: event.key,
      currentId,
      rows,
      expandedIds: expandedSet,
      includeRoot: showRoot,
    });

    if (result.type === 'noop') return;
    event.preventDefault();

    if (result.type === 'focus') {
      focusRow(result.id);
      return;
    }
    if (result.type === 'toggle') {
      applySelection([result.id], result.id);
      setFocusedId(result.id);
      notifyLead(result.id);
      toggleExpandAnimated(result.id);
      return;
    }
    if (result.type === 'open') {
      applySelection([result.id], result.id);
      setFocusedId(result.id);
      notifyLead(result.id);
      onOpen(result.id);
      return;
    }
    if (result.type === 'rename') {
      beginRename(result.id);
    }
  };

  const activeDragItem = activeDragId ? findItemById(items, String(activeDragId)) : null;
  const draggedIdSet = useMemo(() => new Set(draggedIds), [draggedIds]);

  const resolvedRootLabel = rootLabel
    ?? t('workbench:notesWorkspace.tree.root');

  const rootDropInside = overId === NOTES_WORKSPACE_TREE_ROOT_ID && dropPosition === 'inside';
  const focusTargetId = focusedId ?? selectedId;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      modifiers={[restrictToVerticalAxis]}
      autoScroll={{ enabled: true, threshold: { x: 1, y: 0.25 }, ...SHELL_SAFE_AUTO_SCROLL }}
    >
      <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
        <div
          ref={treeRef}
          className={cn('nwt-tree', className)}
          role="tree"
          aria-label={ariaLabel ?? t('workbench:notesWorkspace.tree.aria')}
          aria-busy={ariaBusy}
          aria-multiselectable="true"
          onKeyDown={handleTreeKeyDown}
        >
          <div ref={dropIndicatorRef} className="nwt-drop-indicator" style={{ display: 'none' }} />

          {showRoot ? (
            <RootDropRow
              selected={selectedId === null}
              dropInside={rootDropInside}
              label={resolvedRootLabel}
              onSelect={handleRootSelect}
            />
          ) : null}

          {rows.map((row) => {
            const isOver = overId === row.id;
            const dropInside = Boolean(
              isOver && isFolderItem(row.item) && dropPosition === 'inside' && !dropInvalid,
            );
            // When the library-root row is shown, offset depth so aria-level /
            // indent treat root as level 1 and first real items as level 2.
            const depth = showRoot ? row.depth + 1 : row.depth;
            return (
              <TreeRow
                key={row.id}
                item={row.item}
                depth={depth}
                expanded={expandedSet.has(row.id)}
                selected={selectionSet.has(row.id)}
                active={activeId === row.id}
                renaming={effectiveRenamingId === row.id}
                dropInside={dropInside}
                dropPosition={isOver ? dropPosition : null}
                dropInvalid={isOver && dropInvalid}
                disableDrag={disableDrag}
                dragMember={activeDragId !== null && draggedIdSet.has(row.id)}
                focusable={focusTargetId === row.id}
                siblingCount={row.siblingCount}
                indexAmongSiblings={row.indexAmongSiblings}
                onSelect={onSelect}
                onRowClick={handleRowClick}
                onOpen={onOpen}
                onToggleExpand={toggleExpandAnimated}
                onRenameCommit={commitRename}
                onRenameCancel={endRename}
                onRenameStart={beginRename}
                onContextMenu={openMenu}
              />
            );
          })}
        </div>
      </SortableContext>

      {typeof document !== 'undefined'
        ? createPortal(
          <DragOverlay dropAnimation={dropAnimationConfig}>
            {activeDragItem ? (
              <div className="nwt-drag-overlay" data-invalid={dropInvalid ? 'true' : undefined}>
                <span className="nwt-icon" aria-hidden>
                  {isFolderItem(activeDragItem) ? (
                    <FolderSimple size={15} weight="fill" />
                  ) : activeDragItem.kind === 'mindmap' ? (
                    <TreeStructure size={15} />
                  ) : (
                    <FileText size={15} />
                  )}
                </span>
                <span className="nwt-drag-overlay-title">{activeDragItem.name}</span>
                {draggedIds.length > 1 ? (
                  <span className="nwt-drag-overlay-badge">{draggedIds.length}</span>
                ) : null}
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )
        : null}

      {contextMenu && getMenuItems ? (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getMenuItems(contextMenu.item, {
            beginRename: () => beginRename(contextMenu.item.id),
          })}
          onClose={closeMenu}
        />
      ) : null}
    </DndContext>
  );
}

function RootDropRow({
  selected,
  dropInside,
  label,
  onSelect,
}: {
  selected: boolean;
  dropInside: boolean;
  label: string;
  onSelect: () => void;
}) {
  const { setNodeRef } = useDroppable({
    id: NOTES_WORKSPACE_TREE_ROOT_ID,
    data: { isRoot: true },
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      className="nwt-root"
      role="treeitem"
      tabIndex={selected ? 0 : -1}
      data-nwt-item
      data-nwt-id={NOTES_WORKSPACE_TREE_ROOT_ID}
      data-depth={1}
      data-selected={selected ? 'true' : 'false'}
      data-drop-inside={dropInside ? 'true' : 'false'}
      aria-selected={selected}
      aria-level={1}
      onClick={onSelect}
    >
      <FolderSimple size={14} weight="fill" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export default NotesWorkspaceTree;
