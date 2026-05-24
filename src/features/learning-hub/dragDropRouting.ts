/**
 * Learning Hub 拖拽导入路由工具
 */

import type { FinderPathLike, FinderViewKind } from './learningHubContracts';
import { getViewCapabilities } from './learningHubContracts';

/** 不允许拖拽导入的视图类型 */
export const DRAG_DROP_BLOCKED_VIEWS = ['favorites', 'trash', 'recent', 'indexStatus', 'memory', 'desktop'] as const;

/** 识别为 Markdown 笔记导入的扩展名 */
export const MARKDOWN_NOTE_EXTENSIONS = new Set(['md', 'markdown']);

/**
 * 当前视图是否禁止拖拽导入
 */
export function isDragDropBlockedView(pathOrViewKind: FinderPathLike | FinderViewKind | string | null | undefined): boolean {
  if (!pathOrViewKind) return false;
  const viewKind =
    typeof pathOrViewKind === 'string'
      ? (pathOrViewKind === 'root' ? 'folder' : pathOrViewKind)
      : pathOrViewKind.viewKind;

  return !getViewCapabilities(viewKind as FinderViewKind).canDragDrop;
}

/**
 * 消费“本次已走路径导入”的标记。
 *
 * 返回 true 表示当前 files 回调应被跳过（避免同一次拖拽重复导入）。
 */
export function consumePathsDropHandledFlag(flagRef: { current: boolean }): boolean {
  if (!flagRef.current) return false;
  flagRef.current = false;
  return true;
}

/**
 * 按是否应作为 Markdown 笔记导入进行分流。
 *
 * 当且仅当当前处于“笔记”视图时，`.md/.markdown` 会进入 `markdownItems`，
 * 其余文件维持原链路。
 */
export function partitionMarkdownNoteImports<T>(
  items: T[],
  getName: (item: T) => string,
  shouldImportMarkdownAsNotes: boolean,
): { markdownItems: T[]; otherItems: T[] } {
  if (!shouldImportMarkdownAsNotes) {
    return {
      markdownItems: [],
      otherItems: [...items],
    };
  }

  const markdownItems: T[] = [];
  const otherItems: T[] = [];

  for (const item of items) {
    const fileName = getName(item);
    const extension = (fileName.split('.').pop() || '').toLowerCase();
    if (MARKDOWN_NOTE_EXTENSIONS.has(extension)) {
      markdownItems.push(item);
    } else {
      otherItems.push(item);
    }
  }

  return { markdownItems, otherItems };
}

/**
 * 将失败文件列表压缩为便于通知展示的摘要。
 */
export function summarizeFailedMarkdownFiles(failedFiles: string[]): string | null {
  if (failedFiles.length === 0) {
    return null;
  }

  const preview = failedFiles.slice(0, 3).join('、');
  const remaining = failedFiles.length - 3;
  return remaining > 0 ? `${preview} +${remaining}` : preview;
}
