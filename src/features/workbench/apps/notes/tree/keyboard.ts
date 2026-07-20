import type {
  FlattenedTreeRow,
  KeyboardNavResult,
  NotesWorkspaceTreeItem,
} from './types';
import { isFolderItem } from './flatten';
import { NOTES_WORKSPACE_TREE_ROOT_ID } from './types';

export type KeyboardNavInput = {
  key: string;
  currentId: string;
  rows: readonly FlattenedTreeRow[];
  expandedIds: ReadonlySet<string>;
  /** Include synthetic root as navigable first row when present. */
  includeRoot?: boolean;
  rootSelected?: boolean;
};

/**
 * Pure keyboard navigation for the workspace tree.
 * Host / component applies the returned intent (focus / toggle / open / rename).
 */
export function resolveTreeKeyboardNav(input: KeyboardNavInput): KeyboardNavResult {
  const { key, currentId, rows, expandedIds, includeRoot = false } = input;
  const navigableIds = includeRoot
    ? [NOTES_WORKSPACE_TREE_ROOT_ID, ...rows.map((row) => row.id)]
    : rows.map((row) => row.id);

  const index = navigableIds.indexOf(currentId);
  if (index < 0) return { type: 'noop' };

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const currentRow = rowById.get(currentId) ?? null;
  const currentItem: NotesWorkspaceTreeItem | null = currentRow?.item ?? null;

  const focusAt = (nextIndex: number): KeyboardNavResult => {
    const id = navigableIds[Math.max(0, Math.min(navigableIds.length - 1, nextIndex))];
    return id ? { type: 'focus', id } : { type: 'noop' };
  };

  switch (key) {
    case 'ArrowDown':
      return focusAt(index + 1);
    case 'ArrowUp':
      return focusAt(index - 1);
    case 'Home':
      return focusAt(0);
    case 'End':
      return focusAt(navigableIds.length - 1);
    case 'ArrowRight': {
      if (currentId === NOTES_WORKSPACE_TREE_ROOT_ID) {
        return focusAt(index + 1);
      }
      if (!currentItem || !isFolderItem(currentItem)) return { type: 'noop' };
      if (!expandedIds.has(currentItem.id)) {
        return { type: 'toggle', id: currentItem.id };
      }
      if (currentItem.children?.length) {
        return focusAt(index + 1);
      }
      return { type: 'noop' };
    }
    case 'ArrowLeft': {
      if (currentId === NOTES_WORKSPACE_TREE_ROOT_ID) return { type: 'noop' };
      if (currentItem && isFolderItem(currentItem) && expandedIds.has(currentItem.id)) {
        return { type: 'toggle', id: currentItem.id };
      }
      if (currentRow?.parentId) {
        return { type: 'focus', id: currentRow.parentId };
      }
      if (includeRoot) {
        return { type: 'focus', id: NOTES_WORKSPACE_TREE_ROOT_ID };
      }
      return { type: 'noop' };
    }
    case 'Enter': {
      if (currentId === NOTES_WORKSPACE_TREE_ROOT_ID) {
        return { type: 'focus', id: NOTES_WORKSPACE_TREE_ROOT_ID };
      }
      if (!currentItem) return { type: 'noop' };
      if (isFolderItem(currentItem)) {
        return { type: 'toggle', id: currentItem.id };
      }
      return { type: 'open', id: currentItem.id };
    }
    case 'F2': {
      if (!currentItem || currentItem.canRename === false) return { type: 'noop' };
      if (currentId === NOTES_WORKSPACE_TREE_ROOT_ID) return { type: 'noop' };
      return { type: 'rename', id: currentItem.id };
    }
    default:
      return { type: 'noop' };
  }
}

export type TypeaheadInput = {
  /** Accumulated lowercase-insensitive query buffer. */
  query: string;
  currentId: string;
  rows: readonly FlattenedTreeRow[];
};

/**
 * Type-ahead resolution over visible rows (Obsidian-like):
 * - single char cycles to the next matching row after the current one (wraps);
 * - multi-char buffer keeps matching from the current row so the focus stays
 *   put while the user refines the prefix.
 * Returns the matching row id or null when nothing matches.
 */
export function resolveTypeaheadTarget(input: TypeaheadInput): string | null {
  const { query, currentId, rows } = input;
  const normalized = query.toLowerCase();
  if (!normalized || rows.length === 0) return null;

  const currentIndex = rows.findIndex((row) => row.id === currentId);
  const start = currentIndex === -1
    ? 0
    : currentIndex + (normalized.length === 1 ? 1 : 0);

  for (let offset = 0; offset < rows.length; offset++) {
    const row = rows[(start + offset) % rows.length];
    if (row.item.name.toLowerCase().startsWith(normalized)) {
      return row.id;
    }
  }
  return null;
}

/**
 * Visible-row range between `anchorId` and `targetId` (inclusive, in row
 * order). Falls back to `[targetId]` when either end is not visible.
 * The synthetic root row is never part of a range.
 */
export function resolveRangeSelection(
  rows: readonly FlattenedTreeRow[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const ids = rows.map((row) => row.id);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex === -1) return [];
  const anchorIndex = anchorId ? ids.indexOf(anchorId) : -1;
  if (anchorIndex === -1) return [targetId];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return ids.slice(start, end + 1);
}
