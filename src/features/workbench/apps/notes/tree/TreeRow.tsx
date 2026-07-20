import React, { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CaretDown,
  FileText,
  FolderSimple,
  LinkSimple,
  DotsThree,
  Star,
  TreeStructure,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  BASE_INDENT_PX,
  LEVEL_INDENT_PX,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  LONG_PRESS_MS,
  RESOURCE_EXTRA_INDENT_PX,
  type NotesWorkspaceDropPosition,
  type NotesWorkspaceTreeContextMenuEvent,
  type NotesWorkspaceTreeItem,
} from './types';
import { isFolderItem } from './flatten';
import { setWorkbenchDragData } from '@/features/workbench/hooks/useDesktopDrop';
import { formatWikiLink } from '@/components/crepe/plugins/wikilink';

export interface TreeRowProps {
  item: NotesWorkspaceTreeItem;
  depth: number;
  expanded: boolean;
  selected: boolean;
  active: boolean;
  renaming: boolean;
  dropInside: boolean;
  dropPosition: NotesWorkspaceDropPosition | null;
  /** Row hovered as an invalid drop target (self / descendant of drag). */
  dropInvalid?: boolean;
  disableDrag?: boolean;
  /** Row belongs to the current multi-drag payload (dimmed like the active row). */
  dragMember?: boolean;
  /** Roving-tabindex owner; defaults to `selected` when omitted. */
  focusable?: boolean;
  siblingCount: number;
  indexAmongSiblings: number;
  onSelect: (id: string) => void;
  /**
   * When provided, replaces the default click behavior (select + toggle/open)
   * so the host component can implement modifier-aware multi-selection.
   */
  onRowClick?: (item: NotesWorkspaceTreeItem, event: React.MouseEvent) => void;
  onOpen: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onRenameCommit: (id: string, name: string) => void;
  onRenameCancel: () => void;
  onRenameStart: (id: string) => void;
  onContextMenu: (item: NotesWorkspaceTreeItem, event: NotesWorkspaceTreeContextMenuEvent) => void;
}

export function TreeRow({
  item,
  depth,
  expanded,
  selected,
  active,
  renaming,
  dropInside,
  dropPosition,
  dropInvalid,
  disableDrag,
  dragMember,
  focusable,
  siblingCount,
  indexAmongSiblings,
  onSelect,
  onRowClick,
  onOpen,
  onToggleExpand,
  onRenameCommit,
  onRenameCancel,
  onRenameStart,
  onContextMenu,
}: TreeRowProps) {
  const { t } = useTranslation('workbench');
  const folder = isFolderItem(item);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(item.name);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const cancelRenameOnBlur = useRef(false);

  const canMove = item.canMove !== false && !disableDrag;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    disabled: !canMove || renaming,
    data: { item },
  });

  useEffect(() => {
    if (renaming) {
      setEditValue(item.name);
      cancelRenameOnBlur.current = false;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, item.name]);

  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const paddingLeft = folder
    ? BASE_INDENT_PX + depth * LEVEL_INDENT_PX
    : BASE_INDENT_PX + RESOURCE_EXTRA_INDENT_PX + depth * LEVEL_INDENT_PX;

  const commitRename = () => {
    const next = editValue.trim();
    if (!next || next === item.name) {
      onRenameCancel();
      return;
    }
    onRenameCommit(item.id, next);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(item.id);
    onContextMenu(item, event);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    longPressTimer.current = setTimeout(() => {
      onSelect(item.id);
      onContextMenu(item, {
        clientX: touch.clientX,
        clientY: touch.clientY,
        preventDefault: () => {},
      });
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const start = touchStartPos.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    if (
      Math.abs(touch.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE_PX
      || Math.abs(touch.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      cancelLongPress();
    }
  };

  const ariaLabel = folder
    ? t('workbench:notesWorkspace.tree.folder', { name: item.name })
    : item.kind === 'mindmap'
      ? t('workbench:notesWorkspace.tree.mindmap', { name: item.name })
      : t('workbench:notesWorkspace.tree.note', { name: item.name });

  return (
    <div
      ref={setNodeRef}
      className={folder ? 'nwt-row nwt-row--folder' : 'nwt-row'}
      data-nwt-item
      data-nwt-id={item.id}
      data-nwt-folder={folder ? 'true' : undefined}
      data-depth={depth + 1}
      data-expanded={folder ? (expanded ? 'true' : 'false') : undefined}
      data-selected={selected ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      data-drop-inside={dropInside ? 'true' : 'false'}
      data-drop-position={dropPosition ?? undefined}
      data-drop-invalid={dropInvalid ? 'true' : undefined}
      data-dragging={isDragging || dragMember ? 'true' : undefined}
      data-kind={item.kind}
      style={{
        paddingLeft,
        transform: isDragging ? CSS.Transform.toString(transform) : undefined,
        transition: isDragging ? transition : undefined,
      }}
      onClick={(event) => {
        if (onRowClick) {
          onRowClick(item, event);
          return;
        }
        onSelect(item.id);
        if (folder) onToggleExpand(item.id);
        else onOpen(item.id);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (item.canRename === false) return;
        onRenameStart(item.id);
      }}
      onContextMenu={handleContextMenu}
      onTouchStart={onTouchStart}
      onTouchEnd={cancelLongPress}
      onTouchCancel={cancelLongPress}
      onTouchMove={onTouchMove}
      {...attributes}
      {...(renaming ? {} : listeners)}
      // Keep tree semantics; sortable attributes default role="button".
      role="treeitem"
      tabIndex={(focusable ?? selected) ? 0 : -1}
      aria-level={depth + 1}
      aria-setsize={siblingCount}
      aria-posinset={indexAmongSiblings + 1}
      aria-selected={selected}
      aria-expanded={folder ? expanded : undefined}
      aria-label={ariaLabel}
    >
      {folder ? (
        <span
          className={expanded ? 'nwt-caret' : 'nwt-caret is-collapsed'}
          aria-hidden
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand(item.id);
          }}
        >
          <CaretDown size={12} />
        </span>
      ) : (
        <span className="nwt-caret-spacer" aria-hidden />
      )}
      <span className="nwt-icon" aria-hidden>
        {folder ? (
          <FolderSimple size={15} weight="fill" />
        ) : item.kind === 'mindmap' ? (
          <TreeStructure size={15} />
        ) : (
          <FileText size={15} />
        )}
      </span>
      {renaming ? (
        <input
          ref={inputRef}
          className="nwt-rename-input"
          value={editValue}
          aria-label={t('workbench:notesWorkspace.tree.renameInput')}
          onChange={(event) => setEditValue(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelRenameOnBlur.current = true;
              onRenameCancel();
            }
          }}
          onBlur={() => {
            if (cancelRenameOnBlur.current) {
              cancelRenameOnBlur.current = false;
              return;
            }
            commitRename();
          }}
        />
      ) : (
        <span className="nwt-row-label">{item.name}</span>
      )}
      {item.favorite ? <Star className="nwt-favorite" size={12} weight="fill" aria-hidden /> : null}
      {!renaming ? (
        <button
          type="button"
          className="nwt-row-more"
          tabIndex={-1}
          title={t('workbench:notesWorkspace.tree.moreActions', 'More actions')}
          aria-label={t('workbench:notesWorkspace.tree.moreActions', 'More actions')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            handleContextMenu({
              clientX: rect.right,
              clientY: rect.bottom,
              preventDefault: () => {},
              stopPropagation: () => {},
            } as React.MouseEvent);
          }}
        >
          <DotsThree size={15} weight="bold" aria-hidden />
        </button>
      ) : null}
      {!folder && item.kind === 'note' && !renaming ? (
        <span
          className="nwt-link-drag"
          draggable
          role="button"
          tabIndex={-1}
          title={t('workbench:notesWorkspace.tree.dragLink', 'Drag link into note')}
          aria-label={t('workbench:notesWorkspace.tree.dragLink', 'Drag link into note')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.stopPropagation();
            setWorkbenchDragData(event.dataTransfer, {
              resourceId: item.id,
              resourceType: item.kind,
              title: item.name,
            });
            event.dataTransfer.setData('text/plain', formatWikiLink(item.name));
          }}
        >
          <LinkSimple size={12} aria-hidden />
        </span>
      ) : null}
    </div>
  );
}
