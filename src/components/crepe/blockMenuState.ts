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

export interface BlockMenuNavContext {
  key: string;
  /** 当前高亮索引，-1 表示尚未高亮任何项 */
  activeIndex: number;
  itemCount: number;
}

/**
 * 块菜单键盘导航的下一个高亮索引：↑↓ 循环、Home/End 跳首尾。
 * 返回 null 表示该键不属于导航键，调用方走原有分支。
 */
export function getNextCrepeBlockMenuIndex(context: BlockMenuNavContext): number | null {
  const { key, activeIndex, itemCount } = context;
  if (itemCount <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return activeIndex < 0 ? 0 : (activeIndex + 1) % itemCount;
    case 'ArrowUp':
      return activeIndex < 0 ? itemCount - 1 : (activeIndex - 1 + itemCount) % itemCount;
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    default:
      return null;
  }
}

/**
 * 块菜单输入过滤（typeahead）：从当前高亮项的下一项开始循环查找
 * label 以 query 为前缀（忽略大小写）的菜单项。找不到返回 null。
 */
export function findCrepeBlockMenuTypeaheadIndex(
  labels: readonly string[],
  query: string,
  activeIndex: number,
): number | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized || labels.length === 0) return null;
  const start = activeIndex < 0 ? 0 : (activeIndex + 1) % labels.length;
  for (let step = 0; step < labels.length; step += 1) {
    const index = (start + step) % labels.length;
    if (labels[index].toLowerCase().startsWith(normalized)) return index;
  }
  return null;
}
