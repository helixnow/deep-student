export interface BlockMenuKeyContext {
  key: string;
  editorTarget: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** ProseMirror keeps the same doc object for selection-only transactions. */
export function isCrepeBlockMenuDocCurrent(currentDoc: unknown, openedDoc: unknown): boolean {
  return currentDoc === openedDoc;
}

export function shouldDismissCrepeBlockMenuForKey(context: BlockMenuKeyContext): boolean {
  if (context.key === 'Escape') return true;
  if (!context.editorTarget) return false;
  if (context.isComposing) return true;
  if (context.metaKey || context.ctrlKey || context.altKey) return false;
  return context.key.length === 1
    || context.key === 'Backspace'
    || context.key === 'Delete'
    || context.key === 'Enter';
}
