/**
 * 图表块 — 对齐 series/categories 长度后构建意图
 */

import type { GenerativeUIIntent } from '../types';
import type { ChartKind, ChartSeries } from '../components/ChartBlock';

export interface ChartIntentLabels {
  metaTitle?: string;
}

export interface ChartSeriesInput {
  name: string;
  values: number[];
}

export interface ChartIntentInput {
  id?: string;
  title?: string;
  kind: ChartKind;
  categories: string[];
  series?: ChartSeriesInput[];
  unit?: string;
  labels: ChartIntentLabels;
}

function alignValues(values: number[], length: number): number[] {
  if (values.length === length) return values.slice();
  if (values.length > length) return values.slice(0, length);
  return values.concat(Array.from({ length: length - values.length }, () => 0));
}

export function buildChartIntent(input: ChartIntentInput): GenerativeUIIntent {
  const categories = input.categories.slice(0, 24);
  const series: ChartSeries[] = (input.series ?? []).slice(0, 8).map((item) => ({
    name: item.name.slice(0, 40),
    values: alignValues(item.values, categories.length),
  }));

  return {
    version: '1',
    meta: input.labels.metaTitle
      ? {
          title: input.labels.metaTitle,
        }
      : undefined,
    blocks: [
      {
        type: 'chart',
        id: input.id,
        props: {
          title: input.title?.slice(0, 120),
          kind: input.kind,
          categories,
          ...(series.length > 0 ? { series } : {}),
          unit: input.unit?.slice(0, 16),
        },
      },
    ],
  };
}
