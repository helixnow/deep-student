import { describe, expect, it } from 'vitest';
import { buildTableIntent } from '@/features/generative-ui/utils/buildTableIntent';

const COLUMNS = [
  { key: 'name', label: '姓名' },
  { key: 'score', label: '分数', align: 'right' as const },
];

describe('buildTableIntent', () => {
  it('builds a table block from columns + rows', () => {
    const intent = buildTableIntent({
      title: '成绩',
      columns: COLUMNS,
      rows: [{ name: 'Alice', score: 98 }],
      caption: '本周测验',
      labels: { metaTitle: '成绩表', emptyLabel: '暂无数据' },
    });

    expect(intent.version).toBe('1');
    expect(intent.meta?.title).toBe('成绩表');
    expect(intent.blocks).toHaveLength(1);
    expect(intent.blocks[0]?.type).toBe('table');
    expect(intent.blocks[0]?.props).toMatchObject({
      title: '成绩',
      columns: COLUMNS,
      rows: [{ name: 'Alice', score: 98 }],
      caption: '本周测验',
      emptyLabel: '暂无数据',
    });
  });

  it('drops row fields that are not in columns', () => {
    const intent = buildTableIntent({
      columns: COLUMNS,
      rows: [
        { name: 'Alice', score: 98, secret: 'hidden', extra: 1 },
        { name: 'Bob', note: 'ignore-me' },
      ],
      labels: { emptyLabel: '暂无数据' },
    });

    const rows = intent.blocks[0]?.props?.rows as Array<Record<string, string | number>>;
    expect(rows).toEqual([{ name: 'Alice', score: 98 }, { name: 'Bob' }]);
    expect(rows[0]).not.toHaveProperty('secret');
    expect(rows[0]).not.toHaveProperty('extra');
    expect(rows[1]).not.toHaveProperty('note');
  });

  it('keeps empty rows after dropping unknown fields', () => {
    const intent = buildTableIntent({
      columns: COLUMNS,
      rows: [{ orphan: 'only-unknown' }],
      labels: { emptyLabel: '空表' },
    });

    expect(intent.blocks[0]?.props?.rows).toEqual([{}]);
    expect(intent.blocks[0]?.props?.emptyLabel).toBe('空表');
  });
});
