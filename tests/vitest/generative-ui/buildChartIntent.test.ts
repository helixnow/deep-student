import { describe, expect, it } from 'vitest';
import { buildChartIntent } from '@/features/generative-ui/utils/buildChartIntent';
import { chartBlockPropsSchema } from '@/features/generative-ui/components/ChartBlock';

describe('buildChartIntent', () => {
  it('builds a chart block with aligned series', () => {
    const intent = buildChartIntent({
      title: '季度销量',
      kind: 'bar',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'A', values: [10, 20] }],
      unit: '件',
      labels: { metaTitle: '销量图' },
    });

    expect(intent.version).toBe('1');
    expect(intent.meta?.title).toBe('销量图');
    expect(intent.blocks).toHaveLength(1);
    expect(intent.blocks[0]?.type).toBe('chart');
    expect(intent.blocks[0]?.props).toMatchObject({
      title: '季度销量',
      kind: 'bar',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'A', values: [10, 20] }],
      unit: '件',
    });
    expect(chartBlockPropsSchema.safeParse(intent.blocks[0]?.props).success).toBe(true);
  });

  it('pads shorter series.values with 0 to match categories', () => {
    const intent = buildChartIntent({
      kind: 'line',
      categories: ['Q1', 'Q2', 'Q3'],
      series: [{ name: 'A', values: [1] }],
      labels: {},
    });

    const series = intent.blocks[0]?.props?.series as Array<{ values: number[] }>;
    expect(series[0]?.values).toEqual([1, 0, 0]);
    expect(chartBlockPropsSchema.safeParse(intent.blocks[0]?.props).success).toBe(true);
  });

  it('truncates longer series.values to categories length', () => {
    const intent = buildChartIntent({
      kind: 'pie',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'A', values: [1, 2, 3, 4] }],
      labels: {},
    });

    const series = intent.blocks[0]?.props?.series as Array<{ values: number[] }>;
    expect(series[0]?.values).toEqual([1, 2]);
    expect(chartBlockPropsSchema.safeParse(intent.blocks[0]?.props).success).toBe(true);
  });

  it('aligns each series independently', () => {
    const intent = buildChartIntent({
      kind: 'bar',
      categories: ['A', 'B', 'C'],
      series: [
        { name: 'short', values: [1] },
        { name: 'long', values: [9, 8, 7, 6] },
      ],
      labels: {},
    });

    const series = intent.blocks[0]?.props?.series as Array<{ name: string; values: number[] }>;
    expect(series).toEqual([
      { name: 'short', values: [1, 0, 0] },
      { name: 'long', values: [9, 8, 7] },
    ]);
  });

  it('omits series when input series is empty so empty state can render', () => {
    const intent = buildChartIntent({
      kind: 'bar',
      categories: ['Q1'],
      series: [],
      labels: { metaTitle: '空图' },
    });

    expect(intent.blocks[0]?.props).not.toHaveProperty('series');
    expect(chartBlockPropsSchema.safeParse(intent.blocks[0]?.props).success).toBe(true);
  });
});
