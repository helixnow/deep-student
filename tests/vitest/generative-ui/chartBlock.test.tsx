import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'blocks.chart.empty') return '暂无图表数据';
      if (key === 'blocks.chart.a11y_label') {
        return `${params?.title ?? ''} ${params?.kind ?? ''} 图表`.trim();
      }
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  CHART_BLOCK_TYPE,
  ChartBlock,
  chartBlockPropsSchema,
  registerChartBlock,
} from '@/features/generative-ui/components/ChartBlock';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { validateBlockProps } from '@/features/generative-ui/schema';

beforeAll(() => {
  registerChartBlock();
});

const BASE_PROPS = {
  title: '季度销量',
  categories: ['Q1', 'Q2', 'Q3'],
  series: [{ name: 'A', values: [10, 20, 30] }],
};

describe('chartBlock schema', () => {
  it('accepts aligned bar/line/pie props', () => {
    for (const kind of ['bar', 'line', 'pie'] as const) {
      expect(chartBlockPropsSchema.safeParse({ ...BASE_PROPS, kind }).success).toBe(true);
    }
  });

  it('rejects series.values length that does not match categories', () => {
    const result = chartBlockPropsSchema.safeParse({
      kind: 'bar',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'A', values: [1] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects when one of multiple series is misaligned', () => {
    const result = chartBlockPropsSchema.safeParse({
      kind: 'line',
      categories: ['Q1', 'Q2', 'Q3'],
      series: [
        { name: 'A', values: [1, 2, 3] },
        { name: 'B', values: [4, 5] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('allows missing series for partial / empty render', () => {
    const result = chartBlockPropsSchema.safeParse({
      kind: 'bar',
      categories: ['Q1'],
    });
    expect(result.success).toBe(true);
  });
});

describe('ChartBlock render', () => {
  it.each(['bar', 'line', 'pie'] as const)('renders %s chart with a11y label', (kind) => {
    render(<ChartBlock {...BASE_PROPS} kind={kind} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('aria-label', expect.stringContaining('季度销量'));
    expect(img).toHaveAttribute('aria-label', expect.stringContaining(kind));
    expect(img.className).toContain('h-64');
    expect(document.querySelector('[data-generative-chart]')?.getAttribute('data-chart-kind')).toBe(
      kind,
    );
    expect(screen.getByText('季度销量')).toBeInTheDocument();
  });

  it('shows empty state when series is missing', () => {
    render(<ChartBlock kind="bar" categories={['Q1', 'Q2']} />);
    expect(screen.getByText('暂无图表数据')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('[data-generative-chart]')?.getAttribute('data-empty')).toBe(
      'true',
    );
  });
});

describe('chart registry + renderer', () => {
  it('registers chart with allowPartialRender', () => {
    const config = generativeUIRegistry.get(CHART_BLOCK_TYPE);
    expect(config).toBeDefined();
    expect(config?.allowPartialRender).toBe(true);
    expect(config?.propsSchema).toBe(chartBlockPropsSchema);
  });

  it.each(['bar', 'line', 'pie'] as const)(
    'renders %s through GenerativeUIRenderer after test-local register',
    (kind) => {
      const validation = validateBlockProps(chartBlockPropsSchema, { ...BASE_PROPS, kind });
      expect(validation.ok).toBe(true);

      render(
        <GenerativeUIRenderer
          intent={{
            version: '1',
            blocks: [{ type: 'chart', props: { ...BASE_PROPS, kind } }],
          }}
          showChrome={false}
        />,
      );

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('aria-label', expect.stringContaining(kind));
      expect(document.querySelector('[data-generative-chart]')?.getAttribute('data-chart-kind')).toBe(
        kind,
      );
    },
  );
});
