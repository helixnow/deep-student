/**
 * Learning Hub 拖拽导入路由工具
 */

import type { FinderPathLike, FinderViewKind } from './learningHubContracts';
import { getViewCapabilities } from './learningHubContracts';

/** 不允许拖拽导入的视图类型 */
export const DRAG_DROP_BLOCKED_VIEWS = ['favorites', 'trash', 'recent', 'indexStatus', 'memory', 'desktop'] as const;

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
