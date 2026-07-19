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
import {
  collectDescendantIds,
  findItemById,
  flattenVisibleTree,
  isFolderItem,
  toExpandedSet,
} from './flatten';
import { resolveTreeKeyboardNav } from './keyboard';
import { TreeContextMenu } from './TreeContextMenu';
import { TreeRow } from './TreeRow';
import {
  AUTO_EXPAND_DELAY_MS,
  BASE_INDENT_PX,
  DROP_INDICATOR_SIDE_GAP_PX,
  LEVEL_INDENT_PX,
  NOTES_WORKSPACE_TREE_ROOT_ID,
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

export function NotesWorkspaceTree({
  items,
  expandedIds,
  selectedId,
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
  onOpen,
  onMove,
  onRename,
  onDelete,
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

  const [activeDragId, setActiveDragId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<NotesWorkspaceDropPosition>('inside');
  const [internalRenamingId, setInternalRenamingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const expandedSet = useMemo(() => toExpandedSet(expandedIds), [expandedIds]);
  const expandedRef = useRef(expandedSet);
  expandedRef.current = expandedSet;

  const rows = useMemo(
    () => flattenVisibleTree(items, expandedSet),
    [items, expandedSet],
  );
  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);

  const effectiveRenamingId = renamingId ?? internalRenamingId;

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

  const updateDropIndicator = useCallback((
    overRect: { top: number; height: number } | null | undefined,
    position: NotesWorkspaceDropPosition,
    targetId: string,
    depth: number,
  ) => {
    const indicator = dropIndicatorRef.current;
    const tree = treeRef.current;
    if (!indicator || !tree || !overRect) {
      if (indicator) indicator.style.display = 'none';
      return;
    }
    if (position === 'inside') {
      indicator.style.display = 'none';
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
  }, []);

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
    setActiveDragId(event.active.id);
    setOverId(null);
    setDropPosition('inside');
    dropPositionRef.current = 'inside';
    if (dropIndicatorRef.current) dropIndicatorRef.current.style.display = 'none';
    cancelAutoExpand();
    onSelect(String(event.active.id));
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setOverId(null);
      setDropPosition('inside');
      dropPositionRef.current = 'inside';
      cancelAutoExpand();
      if (dropIndicatorRef.current) dropIndicatorRef.current.style.display = 'none';
      return;
    }

    const targetId = String(over.id);
    setOverId(over.id);

    if (targetId === NOTES_WORKSPACE_TREE_ROOT_ID) {
      setDropPosition('inside');
      dropPositionRef.current = 'inside';
      cancelAutoExpand();
      if (dropIndicatorRef.current) dropIndicatorRef.current.style.display = 'none';
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

    if (isFolder && position === 'inside') {
      scheduleAutoExpand(targetId);
    } else {
      cancelAutoExpand();
    }

    const row = rows.find((entry) => entry.id === targetId);
    updateDropIndicator(over.rect, position, targetId, row?.depth ?? 0);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const position = dropPositionRef.current;
    setActiveDragId(null);
    setOverId(null);
    setDropPosition('inside');
    dropPositionRef.current = 'inside';
    cancelAutoExpand();
    if (dropIndicatorRef.current) dropIndicatorRef.current.style.display = 'none';

    if (!over || active.id === over.id) return;

    const dragId = String(active.id);
    const targetId = String(over.id);
    const dragItem = findItemById(items, dragId);
    if (!dragItem) return;

    if (isFolderItem(dragItem)) {
      const descendants = collectDescendantIds(items, dragId);
      if (isInvalidFolderDrop(dragId, targetId, position, descendants)) return;
    }

    onMove(dragId, targetId, position);
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
    setOverId(null);
    setDropPosition('inside');
    dropPositionRef.current = 'inside';
    cancelAutoExpand();
    if (dropIndicatorRef.current) dropIndicatorRef.current.style.display = 'none';
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

  const focusRow = useCallback((id: string) => {
    onSelect(id === NOTES_WORKSPACE_TREE_ROOT_ID ? null : id);
    requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector<HTMLElement>(
        id === NOTES_WORKSPACE_TREE_ROOT_ID
          ? `[data-nwt-id="${NOTES_WORKSPACE_TREE_ROOT_ID}"]`
          : `[data-nwt-id="${id}"]`,
      );
      el?.focus();
    });
  }, [onSelect]);

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (effectiveRenamingId) return;
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-nwt-item]')
      : null;
    if (!target) return;
    const currentId = target.dataset.nwtId;
    if (!currentId) return;

    if ((event.key === 'Delete' || event.key === 'Backspace') && currentId !== NOTES_WORKSPACE_TREE_ROOT_ID) {
      const item = findItemById(items, currentId);
      if (item && onDelete) {
        event.preventDefault();
        event.stopPropagation();
        onDelete(item);
      }
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
      onSelect(result.id);
      onToggleExpand(result.id);
      return;
    }
    if (result.type === 'open') {
      onSelect(result.id);
      onOpen(result.id);
      return;
    }
    if (result.type === 'rename') {
      beginRename(result.id);
    }
  };

  const activeDragItem = activeDragId ? findItemById(items, String(activeDragId)) : null;

  const resolvedRootLabel = rootLabel
    ?? t('workbench:notesWorkspace.tree.root');

  const rootDropInside = overId === NOTES_WORKSPACE_TREE_ROOT_ID && dropPosition === 'inside';

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
          onKeyDown={handleTreeKeyDown}
        >
          <div ref={dropIndicatorRef} className="nwt-drop-indicator" style={{ display: 'none' }} />

          {showRoot ? (
            <RootDropRow
              selected={selectedId === null}
              dropInside={rootDropInside}
              label={resolvedRootLabel}
              onSelect={() => onSelect(null)}
            />
          ) : null}

          {rows.map((row) => {
            const isOver = overId === row.id;
            const dropInside = Boolean(
              isOver && isFolderItem(row.item) && dropPosition === 'inside',
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
                selected={selectedId === row.id}
                active={activeId === row.id}
                renaming={effectiveRenamingId === row.id}
                dropInside={dropInside}
                dropPosition={isOver ? dropPosition : null}
                disableDrag={disableDrag}
                siblingCount={row.siblingCount}
                indexAmongSiblings={row.indexAmongSiblings}
                onSelect={onSelect}
                onOpen={onOpen}
                onToggleExpand={onToggleExpand}
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
              <div className="nwt-drag-overlay">
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
          onClose={() => setContextMenu(null)}
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
