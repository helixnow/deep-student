/**
 * 大纲窗口化渲染（大图性能）。
 *
 * 现有 `outline-cv`（content-visibility）只让浏览器跳过视口外行的绘制，
 * React 组件仍全量挂载；行数上千后 flatten→map→memo 比较本身成为瓶颈。
 * 本模块提供纯函数窗口计算：只挂载视口附近的行，其余用等高 spacer 占位。
 *
 * 设计约束：
 * - 行高可变（备注/图片/多行文本），使用与 spacer 一致的估算行高——
 *   窗口推导与占位高度自洽，滚动定位在估算误差内可用；
 * - pinned 行（聚焦/编辑中的行）必须保持挂载：编辑中的 textarea 一旦被
 *   窗口滑出卸载，未提交文本会随 blur 缺失而丢字。窗口外的 pinned 行
 *   拆分 spacer 单独渲染；
 * - 拖拽期间由调用方关闭窗口化（dnd-kit 需要全量 droppable 测量），
 *   与既有「拖拽期间关闭 outline-cv」策略一致。
 */

/** 行数达到该阈值才启用窗口化（低于它 content-visibility 已够用） */
export const OUTLINE_VIRTUALIZATION_THRESHOLD = 500;

/** 估算行高（px）：与 outline-cv 的 contain-intrinsic-size 同源（34px）+ 边距 */
export const OUTLINE_ESTIMATED_ROW_HEIGHT = 36;

/** 视口上下各多渲染的行数（滚动缓冲） */
export const OUTLINE_OVERSCAN_ROWS = 12;

export interface OutlineWindowParams {
  totalCount: number;
  scrollTop: number;
  viewportHeight: number;
  estimatedRowHeight?: number;
  overscan?: number;
  /** 必须保持挂载的行下标（聚焦/编辑行）；窗口外时单独渲染 */
  pinnedIndex?: number | null;
}

export type OutlineWindowBlock =
  | { type: 'spacer'; key: string; height: number }
  | { type: 'rows'; key: string; startIndex: number; endIndex: number };

export interface OutlineWindowResult {
  /** 主窗口 [startIndex, endIndex)（不含窗口外的 pinned 行） */
  startIndex: number;
  endIndex: number;
  /** 依序渲染的块序列（spacer 高度按估算行高换算） */
  blocks: OutlineWindowBlock[];
}

export function shouldVirtualizeOutline(totalCount: number): boolean {
  return totalCount >= OUTLINE_VIRTUALIZATION_THRESHOLD;
}

/**
 * 计算窗口化渲染块。返回的 blocks 覆盖 [0, totalCount) 全区间：
 * rows 块按原下标渲染行，spacer 块以估算行高占位。
 */
export function computeOutlineWindow(params: OutlineWindowParams): OutlineWindowResult {
  const {
    totalCount,
    scrollTop,
    viewportHeight,
    estimatedRowHeight = OUTLINE_ESTIMATED_ROW_HEIGHT,
    overscan = OUTLINE_OVERSCAN_ROWS,
    pinnedIndex = null,
  } = params;

  if (totalCount <= 0) {
    return { startIndex: 0, endIndex: 0, blocks: [] };
  }

  const rowHeight = Math.max(1, estimatedRowHeight);
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;

  const startIndex = Math.max(0, Math.min(totalCount, firstVisible - overscan));
  const endIndex = Math.max(startIndex, Math.min(totalCount, firstVisible + visibleCount + overscan));

  // 渲染区间集合：主窗口 + 窗口外的 pinned 行
  const ranges: Array<[number, number]> = [[startIndex, endIndex]];
  if (
    pinnedIndex != null &&
    pinnedIndex >= 0 &&
    pinnedIndex < totalCount &&
    (pinnedIndex < startIndex || pinnedIndex >= endIndex)
  ) {
    ranges.push([pinnedIndex, pinnedIndex + 1]);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const blocks: OutlineWindowBlock[] = [];
  let cursor = 0;
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeEnd <= rangeStart) continue;
    if (rangeStart > cursor) {
      blocks.push({
        type: 'spacer',
        key: `spacer-${cursor}`,
        height: (rangeStart - cursor) * rowHeight,
      });
    }
    blocks.push({
      type: 'rows',
      key: `rows-${rangeStart}`,
      startIndex: rangeStart,
      endIndex: rangeEnd,
    });
    cursor = rangeEnd;
  }
  if (cursor < totalCount) {
    blocks.push({
      type: 'spacer',
      key: `spacer-${cursor}`,
      height: (totalCount - cursor) * rowHeight,
    });
  }

  return { startIndex, endIndex, blocks };
}

/**
 * 目标行在窗口外时的滚动定位：按估算行高把目标行滚到视口中部。
 * 返回应设置的 scrollTop。
 */
export function estimateScrollTopForIndex(
  index: number,
  viewportHeight: number,
  estimatedRowHeight: number = OUTLINE_ESTIMATED_ROW_HEIGHT,
): number {
  return Math.max(0, index * estimatedRowHeight - viewportHeight / 2 + estimatedRowHeight / 2);
}
