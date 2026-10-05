import { describe, expect, it } from 'vitest';
import { buildDeckTree, flattenDeckTree } from '../library/deckTree';

const deck = (name: string, all: number, due = 0, fresh = 0, notEnqueued = 0) => ({
  name, all, due, new: fresh, notEnqueued,
});

describe('buildDeckTree', () => {
  it('nests `::` paths, sums subdecks into parents and keeps the ungrouped bucket last', () => {
    const tree = buildDeckTree([
      deck('', 4, 0, 0, 4),
      deck('英语', 2, 1),
      deck('数学::极限', 3, 2, 1),
      deck('数学', 1, 0, 0, 1),
      deck('数学::导数::链式法则', 2, 1, 1),
    ]);

    expect(tree.map((node) => node.path)).toEqual(['数学', '英语', '']);
    const math = tree[0];
    expect(math).toMatchObject({ label: '数学', depth: 0, all: 6, due: 3, new: 2, notEnqueued: 1 });
    expect(math.children.map((node) => [node.path, node.all])).toEqual([
      ['数学::导数', 2],
      ['数学::极限', 3],
    ]);
    expect(math.children[0].children[0]).toMatchObject({
      path: '数学::导数::链式法则',
      label: '链式法则',
      depth: 2,
      due: 1,
    });
    expect(tree[2]).toMatchObject({ label: '', all: 4, notEnqueued: 4, children: [] });
  });

  it('flattens depth-first in display order', () => {
    const rows = flattenDeckTree(buildDeckTree([deck('B::y', 1), deck('A', 1), deck('B::x', 1)]));
    expect(rows.map((node) => node.path)).toEqual(['A', 'B', 'B::x', 'B::y']);
  });

  it('sorts numbered decks naturally', () => {
    const tree = buildDeckTree([deck('第10章', 1), deck('第2章', 1), deck('第1章', 1)]);
    expect(tree.map((node) => node.label)).toEqual(['第1章', '第2章', '第10章']);
  });
});
