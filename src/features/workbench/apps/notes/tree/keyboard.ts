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
