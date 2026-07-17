/** Workspace tree node kinds aligned with DSTU note / mindmap / folder. */
export type NotesWorkspaceTreeItemKind = 'folder' | 'note' | 'mindmap';

export type NotesWorkspaceDropPosition = 'before' | 'after' | 'inside';

/**
 * Flat-friendly nested item shape for the controlled tree.
 * Wiring maps `TreeFolder` + `DstuNode` into this structure.
 */
export interface NotesWorkspaceTreeItem {
  id: string;
  name: string;
  kind: NotesWorkspaceTreeItemKind;
  /** Present for folders; omit or empty for leaves. */
  children?: NotesWorkspaceTreeItem[];
  /** Optional favorite marker (notes). */
  favorite?: boolean;
  /**
   * Stable path used by the host for `collapsedFolderPaths` mapping.
   * Not required for rendering; documented for wiring.
   */
  path?: string;
  canRename?: boolean;
  canMove?: boolean;
}

export interface NotesWorkspaceTreeMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export type NotesWorkspaceTreeMenuHelpers = {
  /** Start inline rename for the current item (same as F2 / double-click). */
  beginRename: () => void;
};

export type NotesWorkspaceTreeMenuItemsFactory = (
  item: NotesWorkspaceTreeItem,
  helpers: NotesWorkspaceTreeMenuHelpers,
) => NotesWorkspaceTreeMenuItem[];

export interface NotesWorkspaceTreeContextMenuEvent {
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
}

/** Synthetic id for the library-root drop / select row. */
export const NOTES_WORKSPACE_TREE_ROOT_ID = '__nwt_root__';

export const AUTO_EXPAND_DELAY_MS = 420;
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 8;

export const LEVEL_INDENT_PX = 14;
export const BASE_INDENT_PX = 8;
export const RESOURCE_EXTRA_INDENT_PX = 17;
export const DROP_INDICATOR_SIDE_GAP_PX = 6;
export const ROW_HEIGHT_PX = 28;

export interface NotesWorkspaceTreeProps {
  items: NotesWorkspaceTreeItem[];
  /** Controlled expanded folder ids. */
  expandedIds: ReadonlySet<string> | readonly string[];
  /** Currently selected row id (folder or resource). */
  selectedId: string | null;
  /**
   * Currently open resource id (active tab). Visual emphasis only;
   * distinct from `selectedId` so hosts can keep folder selection + tab active.
   */
  activeId?: string | null;
  /** When set, forces that row into rename mode (controlled). */
  renamingId?: string | null;
  /** Show the library-root drop target row above items. Default true. */
  showRoot?: boolean;
  rootLabel?: string;
  /** Disable drag interactions. */
  disableDrag?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-busy'?: boolean;

  onToggleExpand: (id: string) => void;
  onSelect: (id: string | null) => void;
  /** Open a leaf (note/mindmap). Folders typically select + toggle via other handlers. */
  onOpen: (id: string) => void;
  /**
   * Move after drag-drop.
   * - `dragId`: dragged item id
   * - `targetId`: drop target id (`NOTES_WORKSPACE_TREE_ROOT_ID` for root)
   * - `position`: before / after / inside
   */
  onMove: (
    dragId: string,
    targetId: string,
    position: NotesWorkspaceDropPosition,
  ) => void;
  onRename: (id: string, newName: string) => void;
  /**
   * Optional: host notified when rename UI opens/closes so it can sync `renamingId`.
   * If omitted, rename mode is managed internally after double-click / F2 / menu.
   */
  onRenameStart?: (id: string) => void;
  onRenameEnd?: () => void;
  /**
   * Factory for context-menu entries. Component renders the menu shell;
   * all actions are callbacks (no API calls inside the tree).
   */
  getMenuItems?: NotesWorkspaceTreeMenuItemsFactory;
  /**
   * Optional hook when context menu opens (right-click / long-press).
   * Host may still use `getMenuItems` for rendering.
   */
  onContextMenuOpen?: (
    item: NotesWorkspaceTreeItem,
    event: NotesWorkspaceTreeContextMenuEvent,
  ) => void;
  /** Expand a folder when hover-drop auto-expand fires (defaults to onToggleExpand if collapsed). */
  onExpand?: (id: string) => void;
}

export type FlattenedTreeRow = {
  id: string;
  item: NotesWorkspaceTreeItem;
  depth: number;
  parentId: string | null;
  indexAmongSiblings: number;
  siblingCount: number;
};

export type ContextMenuState = {
  item: NotesWorkspaceTreeItem;
  x: number;
  y: number;
};

export type TreeTranslateFn = (
  key: string,
  options?: Record<string, unknown> & { defaultValue?: string },
) => string;

export type KeyboardNavResult =
  | { type: 'focus'; id: string }
  | { type: 'toggle'; id: string }
  | { type: 'open'; id: string }
  | { type: 'rename'; id: string }
  | { type: 'noop' };

export type DropPositionInput = {
  isFolder: boolean;
  isExpanded: boolean;
  hasChildren: boolean;
  overTop: number;
  overHeight: number;
  pointerY: number;
};
