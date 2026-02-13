/**
 * Learning Hub 拖拽导入路由工具
 */

/** 不允许拖拽导入的特殊视图 ID */
export const DRAG_DROP_BLOCKED_VIEWS = ['trash', 'indexStatus', 'memory'] as const;

/**
 * 当前视图是否禁止拖拽导入
 */
export function isDragDropBlockedView(folderId: string | null | undefined): boolean {
  if (!folderId) return false;
  return DRAG_DROP_BLOCKED_VIEWS.includes(folderId as (typeof DRAG_DROP_BLOCKED_VIEWS)[number]);
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
