import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'blocks.chart.empty' || key === 'a11y.chart_empty') return '暂无图表数据';
      if (key === 'blocks.chart.a11y_label' || key === 'a11y.chart_label') {
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
  formatChartTooltipValue,
  registerChartBlock,
  resolveChartAnimationActive,
} from '@/features/generative-ui/components/ChartBlock';
import { formatGenerativeNumber } from '@/features/generative-ui/utils/formatGenerativeNumber';
import { GENERATIVE_UI_COMPACT_MEDIA_QUERY } from '@/features/generative-ui/hooks/useGenerativeUICompact';
import { PREFERS_REDUCED_MOTION_QUERY } from '@/features/generative-ui/hooks/usePrefersReducedMotion';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { validateBlockProps } from '@/features/generative-ui/schema';

const CHART_BLOCK_SRC = path.resolve(
  __dirname,
  '../../../src/features/generative-ui/components/ChartBlock.tsx',
);

function mockMatchMedia(impl: (query: string) => boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: impl(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mockInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
}

function mockMutableReducedMotion(initialMatches: boolean): { setMatches: (matches: boolean) => void } {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const reducedMotionQuery = {
    get matches() {
      return matches;
    },
    media: PREFERS_REDUCED_MOTION_QUERY,
    onchange: null,
    addListener: vi.fn((listener: () => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: () => void) => listeners.delete(listener)),
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) =>
      query === PREFERS_REDUCED_MOTION_QUERY
        ? reducedMotionQuery
        : {
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          },
    ),
  });

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      listeners.forEach((listener) => listener());
    },
  };
}

function restoreDesktopViewport(): void {
  mockMatchMedia(() => false);
  mockInnerWidth(1280);
}

beforeAll(() => {
  registerChartBlock();
  restoreDesktopViewport();
});

afterEach(() => {
  restoreDesktopViewport();
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
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '暂无图表数据');
    expect(document.querySelector('[data-generative-chart]')?.getAttribute('data-empty')).toBe(
      'true',
    );
  });

  it('puts dir="auto" on the chart title', () => {
    render(<ChartBlock {...BASE_PROPS} title="趋势" kind="bar" />);
    const title = screen.getByRole('heading', { name: '趋势' });
    expect(title).toHaveAttribute('dir', 'auto');
  });

  it('puts dir="auto" on the empty-state label', () => {
    render(<ChartBlock kind="bar" categories={['Q1']} />);
    expect(screen.getByText('暂无图表数据')).toHaveAttribute('dir', 'auto');
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

describe('ChartBlock animation gating', () => {
  it('disables animation when compact or prefers-reduced-motion', () => {
    expect(resolveChartAnimationActive(false, false)).toBe(true);
    expect(resolveChartAnimationActive(true, false)).toBe(false);
    expect(resolveChartAnimationActive(false, true)).toBe(false);
    expect(resolveChartAnimationActive(true, true)).toBe(false);
  });

  it('keeps animation on desktop without reduced motion', () => {
    restoreDesktopViewport();
    render(<ChartBlock {...BASE_PROPS} kind="bar" />);
    expect(document.querySelector('[data-generative-chart]')).toHaveAttribute(
      'data-animation-active',
      'true',
    );
  });

  it('sets isAnimationActive=false when prefers-reduced-motion matches', () => {
    mockInnerWidth(1280);
    mockMatchMedia((query) => query.includes('prefers-reduced-motion'));
    render(<ChartBlock {...BASE_PROPS} kind="line" />);
    expect(document.querySelector('[data-generative-chart]')).toHaveAttribute(
      'data-animation-active',
      'false',
    );
    expect(window.matchMedia).toHaveBeenCalledWith(PREFERS_REDUCED_MOTION_QUERY);
  });

  it('disables animation when reduced-motion changes at runtime', () => {
    mockInnerWidth(1280);
    const media = mockMutableReducedMotion(false);
    render(<ChartBlock {...BASE_PROPS} kind="bar" />);

    const chart = document.querySelector('[data-generative-chart]');
    expect(chart).toHaveAttribute('data-animation-active', 'true');

    act(() => media.setMatches(true));

    expect(chart).toHaveAttribute('data-animation-active', 'false');
  });

  it('sets isAnimationActive=false in compact viewport', () => {
    mockInnerWidth(375);
    mockMatchMedia((query) => query === GENERATIVE_UI_COMPACT_MEDIA_QUERY);
    render(<ChartBlock {...BASE_PROPS} kind="pie" />);
    expect(document.querySelector('[data-generative-chart]')).toHaveAttribute(
      'data-animation-active',
      'false',
    );
  });

  it('wires resolve result to recharts isAnimationActive', () => {
    const source = readFileSync(CHART_BLOCK_SRC, 'utf8');
    expect(source).toContain('isAnimationActive={isAnimationActive}');
    expect(source).toContain('useGenerativeUICompact');
    expect(source).toContain('usePrefersReducedMotion');
  });
});

describe('formatChartTooltipValue', () => {
  it('formats numeric tooltip values with formatGenerativeNumber', () => {
    expect(formatChartTooltipValue(1200)).toBe(formatGenerativeNumber(1200));
  });
});
