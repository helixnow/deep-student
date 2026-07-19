import { describe, expect, it } from 'vitest';

import {
  GRID_GAP,
  GRID_ITEM_WIDTH,
  GRID_ROW_HEIGHT,
  LIST_ITEM_HEIGHT,
  LIST_PADDING_TOP,
  hitTestGridSelection,
  hitTestListSelection,
  indicesToIds,
  type ClientRect,
  type GridLayout,
  type ListLayout,
} from '../selectionHitTest';
import { pruneSelectionAgainstItems } from '../../../stores/selectionPrune';

function listLayout(overrides: Partial<ListLayout> = {}): ListLayout {
  return {
    itemCount: 100,
    itemHeight: LIST_ITEM_HEIGHT,
    paddingTop: LIST_PADDING_TOP,
    scrollTop: 0,
    viewportTop: 100,
    viewportLeft: 0,
    ...overrides,
  };
}

function gridLayout(overrides: Partial<GridLayout> = {}): GridLayout {
  return {
    itemCount: 20,
    columns: 4,
    itemWidth: GRID_ITEM_WIDTH,
    rowHeight: GRID_ROW_HEIGHT,
    gap: GRID_GAP,
    padLeft: 12,
    padTop: 12,
    scrollTop: 0,
    viewportTop: 100,
    viewportLeft: 0,
    ...overrides,
  };
}

/** 在内容坐标系中构造 client 框（viewportTop=100, scrollTop 可覆盖） */
function boxFromContent(
  content: ClientRect,
  layout: { viewportTop: number; viewportLeft: number; scrollTop: number; scrollLeft?: number },
): ClientRect {
  const scrollLeft = layout.scrollLeft ?? 0;
  return {
    left: content.left + layout.viewportLeft - scrollLeft,
    top: content.top + layout.viewportTop - layout.scrollTop,
    right: content.right + layout.viewportLeft - scrollLeft,
    bottom: content.bottom + layout.viewportTop - layout.scrollTop,
  };
}

describe('hitTestListSelection', () => {
  it('returns index range across multiple rows', () => {
    const layout = listLayout();
    // contentY 覆盖 index 10–25：行顶 = padding + i*h
    const content: ClientRect = {
      left: 0,
      top: LIST_PADDING_TOP + 10 * LIST_ITEM_HEIGHT + 1,
      right: 200,
      bottom: LIST_PADDING_TOP + 26 * LIST_ITEM_HEIGHT - 1,
    };
    const box = boxFromContent(content, layout);
    expect(hitTestListSelection(box, layout)).toEqual(
      Array.from({ length: 16 }, (_, i) => 10 + i),
    );
  });

  it('hits offscreen rows without DOM (large scrollTop)', () => {
    const layout = listLayout({ scrollTop: 2000 });
    // 视口内框映射到 contentY ≈ 2000+，应对应 index 80–90
    const content: ClientRect = {
      left: 0,
      top: LIST_PADDING_TOP + 80 * LIST_ITEM_HEIGHT + 1,
      right: 200,
      bottom: LIST_PADDING_TOP + 91 * LIST_ITEM_HEIGHT - 1,
    };
    const box = boxFromContent(content, layout);
    expect(hitTestListSelection(box, layout)).toEqual(
      Array.from({ length: 11 }, (_, i) => 80 + i),
    );
  });

  it('returns empty when box is only in top padding', () => {
    const layout = listLayout();
    const content: ClientRect = {
      left: 0,
      top: 0,
      right: 200,
      bottom: LIST_PADDING_TOP - 1,
    };
    const box = boxFromContent(content, layout);
    expect(hitTestListSelection(box, layout)).toEqual([]);
  });
});

describe('hitTestGridSelection', () => {
  it('returns cells in row/col rectangle and ignores gap-only boxes', () => {
    const layout = gridLayout();
    const cellW = GRID_ITEM_WIDTH + GRID_GAP;
    const cellH = GRID_ROW_HEIGHT + GRID_GAP;

    // 盖住 (r1,c1)–(r2,c2) → indices 5,6,9,10
    const content: ClientRect = {
      left: layout.padLeft + 1 * cellW + 1,
      top: layout.padTop + 1 * cellH + 1,
      right: layout.padLeft + 2 * cellW + GRID_ITEM_WIDTH - 1,
      bottom: layout.padTop + 2 * cellH + GRID_ROW_HEIGHT - 1,
    };
    const box = boxFromContent(content, layout);
    expect(hitTestGridSelection(box, layout).sort((a, b) => a - b)).toEqual([5, 6, 9, 10]);

    // 框落在 (0,0) 与 (0,1) 之间的 gap
    const gapBox = boxFromContent(
      {
        left: layout.padLeft + GRID_ITEM_WIDTH + 1,
        top: layout.padTop + 10,
        right: layout.padLeft + GRID_ITEM_WIDTH + GRID_GAP - 1,
        bottom: layout.padTop + 40,
      },
      layout,
    );
    expect(hitTestGridSelection(gapBox, layout)).toEqual([]);
  });

  it('does not invent indices on a short last row', () => {
    const layout = gridLayout({ itemCount: 10, columns: 4 });
    const cellH = GRID_ROW_HEIGHT + GRID_GAP;
    // 第 3 行（r=2）：仅 index 8,9
    const content: ClientRect = {
      left: layout.padLeft + 1,
      top: layout.padTop + 2 * cellH + 1,
      right: layout.padLeft + 4 * (GRID_ITEM_WIDTH + GRID_GAP),
      bottom: layout.padTop + 2 * cellH + GRID_ROW_HEIGHT - 1,
    };
    const box = boxFromContent(content, layout);
    expect(hitTestGridSelection(box, layout).sort((a, b) => a - b)).toEqual([8, 9]);
  });
});

describe('indicesToIds + pruneSelectionAgainstItems', () => {
  it('maps indices to ids and prunes ghost selection', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(indicesToIds([0, 2], items)).toEqual(new Set(['a', 'c']));

    const pruned = pruneSelectionAgainstItems(
      new Set(['a', 'b', 'c']),
      [{ id: 'a' }, { id: 'c' }],
      'b',
    );
    expect(pruned.selectedIds).toEqual(new Set(['a', 'c']));
    expect(pruned.lastSelectedId).toBeNull();
    expect(pruned.changed).toBe(true);

    const preservedAnchor = pruneSelectionAgainstItems(
      new Set(['a', 'b', 'c']),
      [{ id: 'a' }, { id: 'c' }],
      'b',
      { preserveLastSelectedIfWasSelected: true },
    );
    expect(preservedAnchor.selectedIds).toEqual(new Set(['a', 'c']));
    expect(preservedAnchor.lastSelectedId).toBe('b');

    const empty = pruneSelectionAgainstItems(new Set(['a']), [], 'a');
    expect(empty.selectedIds.size).toBe(0);
    expect(empty.lastSelectedId).toBeNull();
    expect(empty.changed).toBe(true);

    const again = pruneSelectionAgainstItems(empty.selectedIds, [], empty.lastSelectedId);
    expect(again.changed).toBe(false);
  });
});
