/**
 * Finder 框选几何命中（纯函数，不依赖 DOM 扫描）
 *
 * List：固定行高索引区间；Grid：行列矩形 + 单元格内容 AABB（排除 gap 空隙）。
 */

export const LIST_ITEM_HEIGHT = 40;
export const LIST_PADDING_TOP = 4; // py-1

export const GRID_ITEM_WIDTH = 88;
export const GRID_ROW_HEIGHT = 120;
export const GRID_GAP = 8;

export type ClientRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type ListLayout = {
  itemCount: number;
  itemHeight: number;
  paddingTop: number;
  scrollTop: number;
  viewportTop: number;
  viewportLeft: number;
};

export type GridLayout = {
  itemCount: number;
  columns: number;
  itemWidth: number;
  rowHeight: number;
  gap: number;
  padLeft: number;
  padTop: number;
  scrollTop: number;
  scrollLeft?: number;
  viewportTop: number;
  viewportLeft: number;
};

/** 贴边 epsilon，避免刚好落在边界时多选下一行/列 */
const EDGE_EPS = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rectsIntersect(a: ClientRect, b: ClientRect): boolean {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
}

function toContentRect(
  box: ClientRect,
  viewportTop: number,
  viewportLeft: number,
  scrollTop: number,
  scrollLeft = 0,
): ClientRect {
  return {
    left: box.left - viewportLeft + scrollLeft,
    top: box.top - viewportTop + scrollTop,
    right: box.right - viewportLeft + scrollLeft,
    bottom: box.bottom - viewportTop + scrollTop,
  };
}

/**
 * List 命中：返回与选择框相交的行索引（闭区间）。
 */
export function hitTestListSelection(box: ClientRect, layout: ListLayout): number[] {
  const { itemCount, itemHeight, paddingTop, scrollTop, viewportTop, viewportLeft } = layout;
  if (itemCount <= 0 || itemHeight <= 0) return [];

  const content = toContentRect(box, viewportTop, viewportLeft, scrollTop);
  const y0 = content.top - paddingTop;
  const y1 = content.bottom - paddingTop;

  let iMin = Math.floor(y0 / itemHeight);
  let iMax = Math.floor((y1 - EDGE_EPS) / itemHeight);
  iMin = clamp(iMin, 0, itemCount - 1);
  iMax = clamp(iMax, 0, itemCount - 1);

  // 框完全落在内容区外（如仅 padding / 底部空白）
  if (y1 <= 0 || y0 >= itemCount * itemHeight) return [];
  if (iMin > iMax) return [];

  const indices: number[] = [];
  for (let i = iMin; i <= iMax; i += 1) {
    indices.push(i);
  }
  return indices;
}

/**
 * Grid 命中：返回与选择框相交的单元格索引。
 * gap 空隙不计命中——对单元格内容矩形 (itemWidth × rowHeight) 再做 AABB。
 */
export function hitTestGridSelection(box: ClientRect, layout: GridLayout): number[] {
  const {
    itemCount,
    columns,
    itemWidth,
    rowHeight,
    gap,
    padLeft,
    padTop,
    scrollTop,
    scrollLeft = 0,
    viewportTop,
    viewportLeft,
  } = layout;

  if (itemCount <= 0 || columns <= 0 || itemWidth <= 0 || rowHeight <= 0) return [];

  const content = toContentRect(box, viewportTop, viewportLeft, scrollTop, scrollLeft);
  const x0 = content.left - padLeft;
  const x1 = content.right - padLeft;
  const y0 = content.top - padTop;
  const y1 = content.bottom - padTop;

  const cellW = itemWidth + gap;
  const cellH = rowHeight + gap;
  const rowCount = Math.ceil(itemCount / columns);

  let c0 = Math.floor(x0 / cellW);
  let c1 = Math.floor((x1 - EDGE_EPS) / cellW);
  let r0 = Math.floor(y0 / cellH);
  let r1 = Math.floor((y1 - EDGE_EPS) / cellH);

  c0 = clamp(c0, 0, columns - 1);
  c1 = clamp(c1, 0, columns - 1);
  r0 = clamp(r0, 0, rowCount - 1);
  r1 = clamp(r1, 0, rowCount - 1);

  if (c0 > c1 || r0 > r1) return [];
  // 框完全在 padding / 内容外
  if (x1 <= 0 || y1 <= 0) return [];
  if (x0 >= columns * cellW - gap || y0 >= rowCount * cellH - gap) return [];

  const contentBox: ClientRect = {
    left: x0,
    top: y0,
    right: x1,
    bottom: y1,
  };

  const indices: number[] = [];
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const cellContent: ClientRect = {
        left: c * cellW,
        top: r * cellH,
        right: c * cellW + itemWidth,
        bottom: r * cellH + rowHeight,
      };
      if (!rectsIntersect(contentBox, cellContent)) continue;
      const idx = r * columns + c;
      if (idx < itemCount) {
        indices.push(idx);
      }
    }
  }
  return indices;
}

export function indicesToIds(
  indices: number[],
  items: ReadonlyArray<{ id: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const index of indices) {
    const item = items[index];
    if (item) ids.add(item.id);
  }
  return ids;
}
