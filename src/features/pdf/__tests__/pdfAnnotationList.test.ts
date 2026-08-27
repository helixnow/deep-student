import { describe, expect, it } from 'vitest';

import {
  buildAnnotationSourceLine,
  buildAnnotationSummaryMarkdown,
  collectHighlightColors,
  filterHighlights,
  groupHighlightsByPage,
  resourceIdFromDstuPath,
  sortHighlightsForList,
  type AnnotationHighlight,
} from '../pdfAnnotationList';

const hl = (
  overrides: Partial<AnnotationHighlight> & Pick<AnnotationHighlight, 'id'>,
): AnnotationHighlight => ({
  pageIndex: 1,
  text: `text-${overrides.id}`,
  color: '#fef08a',
  rects: [{ x: 0.1, y: 0.5, width: 0.3, height: 0.02 }],
  createdAt: 0,
  coordVersion: 2,
  ...overrides,
});

describe('sortHighlightsForList', () => {
  it('orders by page, then in-page top, then createdAt', () => {
    const items = [
      hl({ id: 'p2-low', pageIndex: 2, rects: [{ x: 0, y: 0.8, width: 0.1, height: 0.02 }] }),
      hl({ id: 'p1-low', pageIndex: 1, rects: [{ x: 0, y: 0.9, width: 0.1, height: 0.02 }] }),
      hl({ id: 'p1-high', pageIndex: 1, rects: [{ x: 0, y: 0.1, width: 0.1, height: 0.02 }] }),
      hl({ id: 'p2-high', pageIndex: 2, rects: [{ x: 0, y: 0.2, width: 0.1, height: 0.02 }] }),
    ];
    expect(sortHighlightsForList(items).map((h) => h.id)).toEqual([
      'p1-high',
      'p1-low',
      'p2-high',
      'p2-low',
    ]);
  });

  it('falls back to createdAt when coord versions differ on the same page', () => {
    const legacy = hl({
      id: 'legacy',
      coordVersion: undefined,
      // 历史像素坐标：数值远大于 0–1 相对坐标，直接比较会永远排后
      rects: [{ x: 10, y: 40, width: 100, height: 14 }],
      createdAt: 1,
    });
    const v2 = hl({ id: 'v2', createdAt: 2, rects: [{ x: 0, y: 0.99, width: 0.1, height: 0.01 }] });
    expect(sortHighlightsForList([v2, legacy]).map((h) => h.id)).toEqual(['legacy', 'v2']);
  });

  it('sorts rect-less highlights to the end of the page (same coord space)', () => {
    // createdAt 反向设置：若错误落回 createdAt 兜底会把 no-rects 排前
    const noRects = hl({ id: 'no-rects', rects: [], createdAt: 1 });
    const normal = hl({ id: 'normal', createdAt: 2 });
    expect(sortHighlightsForList([noRects, normal]).map((h) => h.id)).toEqual([
      'normal',
      'no-rects',
    ]);
  });

  it('does not mutate the input array', () => {
    const items = [hl({ id: 'b', pageIndex: 2 }), hl({ id: 'a', pageIndex: 1 })];
    sortHighlightsForList(items);
    expect(items.map((h) => h.id)).toEqual(['b', 'a']);
  });
});

describe('groupHighlightsByPage', () => {
  it('groups consecutive items of the same page preserving order', () => {
    const sorted = sortHighlightsForList([
      hl({ id: 'a', pageIndex: 1 }),
      hl({ id: 'b', pageIndex: 3 }),
      hl({ id: 'c', pageIndex: 3, rects: [{ x: 0, y: 0.9, width: 0.1, height: 0.02 }] }),
    ]);
    const groups = groupHighlightsByPage(sorted);
    expect(groups.map((g) => g.page)).toEqual([1, 3]);
    expect(groups[1]!.items.map((h) => h.id)).toEqual(['b', 'c']);
  });

  it('returns empty array for empty input', () => {
    expect(groupHighlightsByPage([])).toEqual([]);
  });
});

describe('filterHighlights / collectHighlightColors', () => {
  const items = [
    hl({ id: 'y1', color: '#fef08a', text: '细胞膜的结构' }),
    hl({ id: 'g1', color: '#bbf7d0', text: '线粒体是动力工厂' }),
    hl({ id: 'y2', color: '#FEF08A', text: '细胞核内含遗传物质' }),
  ];

  it('collects distinct colors case-insensitively in first-seen order', () => {
    expect(collectHighlightColors(items)).toEqual(['#fef08a', '#bbf7d0']);
  });

  it('filters by color (case-insensitive) and by text query together', () => {
    expect(filterHighlights(items, { colors: ['#fef08a'] }).map((h) => h.id)).toEqual([
      'y1',
      'y2',
    ]);
    expect(filterHighlights(items, { query: '细胞' }).map((h) => h.id)).toEqual(['y1', 'y2']);
    expect(
      filterHighlights(items, { colors: ['#FEF08A'], query: '遗传' }).map((h) => h.id),
    ).toEqual(['y2']);
  });

  it('empty filter returns a copy of everything', () => {
    const result = filterHighlights(items, {});
    expect(result.map((h) => h.id)).toEqual(['y1', 'g1', 'y2']);
    expect(result).not.toBe(items);
  });
});

describe('resourceIdFromDstuPath', () => {
  it('takes the last path segment', () => {
    expect(resourceIdFromDstuPath('/我的教材/tb_xyz789')).toBe('tb_xyz789');
    expect(resourceIdFromDstuPath('/file_1')).toBe('file_1');
  });

  it('returns null for empty/blank paths', () => {
    expect(resourceIdFromDstuPath(undefined)).toBeNull();
    expect(resourceIdFromDstuPath(null)).toBeNull();
    expect(resourceIdFromDstuPath('')).toBeNull();
    expect(resourceIdFromDstuPath('/')).toBeNull();
  });
});

describe('buildAnnotationSourceLine', () => {
  it('emits a pdfref:// markdown link when sourceId is known', () => {
    expect(
      buildAnnotationSourceLine({ label: '—— 摘自《x.pdf》第 3 页', sourceId: 'tb_1', page: 3 }),
    ).toBe('[—— 摘自《x.pdf》第 3 页](pdfref://tb_1?page=3)');
  });

  it('degrades to plain text without sourceId', () => {
    expect(
      buildAnnotationSourceLine({ label: '—— 摘自《x.pdf》第 3 页', sourceId: null, page: 3 }),
    ).toBe('—— 摘自《x.pdf》第 3 页');
  });
});

describe('buildAnnotationSummaryMarkdown', () => {
  const labels = {
    pageHeading: (page: number) => `第 ${page} 页`,
    sourceLine: (page: number) => `—— 摘自《x.pdf》第 ${page} 页`,
  };

  it('renders page sections with quote blocks and backlink source lines', () => {
    const md = buildAnnotationSummaryMarkdown({
      highlights: [
        hl({ id: 'b', pageIndex: 2, text: '第二页摘录' }),
        hl({ id: 'a', pageIndex: 1, text: '首页摘录\n跨行' }),
      ],
      sourceId: 'tb_1',
      labels,
    });
    expect(md).toBe(
      [
        '## 第 1 页',
        '',
        '> 首页摘录',
        '> 跨行',
        '',
        '[—— 摘自《x.pdf》第 1 页](pdfref://tb_1?page=1)',
        '',
        '## 第 2 页',
        '',
        '> 第二页摘录',
        '',
        '[—— 摘自《x.pdf》第 2 页](pdfref://tb_1?page=2)',
        '',
      ].join('\n'),
    );
  });

  it('degrades source lines to plain text without sourceId', () => {
    const md = buildAnnotationSummaryMarkdown({
      highlights: [hl({ id: 'a', pageIndex: 5, text: '摘录' })],
      sourceId: null,
      labels,
    });
    expect(md).toContain('—— 摘自《x.pdf》第 5 页');
    expect(md).not.toContain('pdfref://');
  });

  it('returns empty string for empty highlight list', () => {
    expect(buildAnnotationSummaryMarkdown({ highlights: [], sourceId: 'tb_1', labels })).toBe('');
  });
});
