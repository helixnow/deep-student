import type { DropPositionInput, NotesWorkspaceDropPosition } from './types';

/**
 * Pure drop-position calculator (ported from DndFileTree).
 *
 * - Folder: top ⅓ → before, middle ⅓ → inside, bottom ⅓ → after.
 *   When the folder is collapsed or empty, `after` is coerced to `inside`.
 * - Leaf: upper half → before, lower half → after.
 */
export function calculateDropPosition(input: DropPositionInput): NotesWorkspaceDropPosition {
  const { isFolder, isExpanded, hasChildren, overTop, overHeight, pointerY } = input;
  if (overHeight <= 0) {
    return isFolder ? 'inside' : 'after';
  }

  if (isFolder) {
    let pos: NotesWorkspaceDropPosition;
    if (pointerY < overTop + overHeight / 3) pos = 'before';
    else if (pointerY > overTop + (overHeight * 2) / 3) pos = 'after';
    else pos = 'inside';

    if (pos === 'after' && (!isExpanded || !hasChildren)) {
      pos = 'inside';
    }
    return pos;
  }

  const relativeY = pointerY - overTop;
  return relativeY < overHeight / 2 ? 'before' : 'after';
}

/**
 * Whether dropping `dragId` onto `targetId` at `position` is structurally invalid
 * (self-drop / dropping a folder into its own descendant). Host still owns business rules.
 */
export function isInvalidFolderDrop(
  dragId: string,
  targetId: string,
  position: NotesWorkspaceDropPosition,
  descendantIdsOfDrag: ReadonlySet<string>,
): boolean {
  if (dragId === targetId) return true;
  if (position === 'inside' && descendantIdsOfDrag.has(targetId)) return true;
  if ((position === 'before' || position === 'after') && descendantIdsOfDrag.has(targetId)) {
    return true;
  }
  return false;
}
