import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { useGenerativeUICompact } from '../hooks/useGenerativeUICompact';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { generativeUIRegistry } from '../registry';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';

export function resolveChartAnimationActive(
  compact: boolean,
  prefersReducedMotion: boolean,
): boolean {
  return !compact && !prefersReducedMotion;
}

export const CHART_KINDS = ['bar', 'line', 'pie'] as const;

export const chartSeriesSchema = z.object({
  name: z.string().max(40),
  values: z.array(z.number()),
});

export const chartBlockPropsSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().max(120).optional(),
    kind: z.enum(CHART_KINDS),
    categories: z.array(z.string()).min(1).max(24),
    series: z.array(chartSeriesSchema).min(1).max(8).optional(),
    unit: z.string().max(16).optional(),
  })
  .refine(
    (data) =>
      (data.series ?? []).every((item) => item.values.length === data.categories.length),
    { message: 'series.values.length must equal categories.length', path: ['series'] },
  );

export type ChartKind = (typeof CHART_KINDS)[number];
export type ChartSeries = z.infer<typeof chartSeriesSchema>;
export type ChartBlockProps = z.infer<typeof chartBlockPropsSchema>;

export const CHART_BLOCK_TYPE = 'chart';

/** 语义色，禁止裸 hex */
const SERIES_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--info))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
  'hsl(var(--accent-foreground))',
  'hsl(var(--muted-foreground))',
  'hsl(var(--secondary-foreground))',
] as const;

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  color: 'hsl(var(--popover-foreground))',
};

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))' } as const;

export function formatChartTooltipValue(value: unknown, unit?: string): string {
  const suffix = unit ? ` ${unit}` : '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return `${String(value)}${suffix}`;
  }
  return `${formatGenerativeNumber(numeric)}${suffix}`;
}

function seriesKey(item: ChartSeries, index: number): string {
  return item.name.trim() || `series-${index}`;
}

function toCartesianRows(categories: string[], series: ChartSeries[]): Record<string, string | number>[] {
  return categories.map((category, categoryIndex) => {
    const row: Record<string, string | number> = { category };
    series.forEach((item, seriesIndex) => {
      row[seriesKey(item, seriesIndex)] = item.values[categoryIndex] ?? 0;
    });
    return row;
  });
}

function toPieRows(categories: string[], series: ChartSeries[]): Array<{ name: string; value: number }> {
  const primary = series[0];
  if (!primary) return [];
  return categories.map((name, index) => ({
    name,
    value: primary.values[index] ?? 0,
  }));
}

function ChartGraphic({
  kind,
  categories,
  series,
  unit,
  isAnimationActive,
}: {
  kind: ChartKind;
  categories: string[];
  series: ChartSeries[];
  unit?: string;
  isAnimationActive: boolean;
}) {
  const cartesian = useMemo(() => toCartesianRows(categories, series), [categories, series]);
  const pieRows = useMemo(() => toPieRows(categories, series), [categories, series]);

  if (kind === 'pie') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value) => [formatChartTooltipValue(value, unit), undefined]}
          />
          <Legend />
          <Pie data={pieRows} dataKey="value" nameKey="name" isAnimationActive={isAnimationActive}>
            {pieRows.map((entry, index) => (
              <Cell key={entry.name} fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (kind === 'line') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={cartesian}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="category" tick={AXIS_TICK} stroke="hsl(var(--border))" />
          <YAxis tick={AXIS_TICK} stroke="hsl(var(--border))" />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value) => [formatChartTooltipValue(value, unit), undefined]}
          />
          <Legend />
          {series.map((item, index) => (
            <Line
              key={seriesKey(item, index)}
              type="monotone"
              dataKey={seriesKey(item, index)}
              name={item.name || seriesKey(item, index)}
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              dot={false}
              isAnimationActive={isAnimationActive}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={cartesian}>
        <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="category" tick={AXIS_TICK} stroke="hsl(var(--border))" />
        <YAxis tick={AXIS_TICK} stroke="hsl(var(--border))" />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => [formatChartTooltipValue(value, unit), undefined]}
        />
        <Legend />
        {series.map((item, index) => (
          <Bar
            key={seriesKey(item, index)}
            dataKey={seriesKey(item, index)}
            name={item.name || seriesKey(item, index)}
            fill={SERIES_COLORS[index % SERIES_COLORS.length]}
            isAnimationActive={isAnimationActive}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartBlock({ id, title, kind, categories, series, unit }: ChartBlockProps) {
  const { t } = useTranslation('generativeUi');
  const compact = useGenerativeUICompact();
  const prefersReducedMotion = usePrefersReducedMotion();
  const isAnimationActive = resolveChartAnimationActive(compact, prefersReducedMotion);
  const resolvedSeries = series ?? [];
  const isEmpty = resolvedSeries.length === 0;
  const a11yLabel = t('a11y.chart_label', {
    title: title?.trim() || kind,
    kind,
  });
  const emptyA11yLabel = t('a11y.chart_empty');

  return (
    <Card
      className="min-w-0"
      data-testid="generative-ui-chart"
      data-generative-chart
      data-chart-id={id}
      data-chart-kind={kind}
      data-empty={isEmpty || undefined}
      data-animation-active={isAnimationActive ? 'true' : 'false'}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle dir="auto" className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0 space-y-2' : 'pt-4 space-y-2'}>
        {unit && !isEmpty ? (
          <p className="text-xs text-muted-foreground" dir="auto">{unit}</p>
        ) : null}
        {isEmpty ? (
          <div role="img" aria-label={emptyA11yLabel}>
            <p className="text-sm text-muted-foreground" dir="auto">{t('blocks.chart.empty')}</p>
          </div>
        ) : (
          <div role="img" aria-label={a11yLabel} className="h-64 w-full">
            <ChartGraphic
              kind={kind}
              categories={categories}
              series={resolvedSeries}
              unit={unit}
              isAnimationActive={isAnimationActive}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 测试 / 按需注册。不写入 blocks/index.ts，避免破坏 EXPECTED_BLOCK_TYPES。 */
export function registerChartBlock(): void {
  generativeUIRegistry.register({
    type: CHART_BLOCK_TYPE,
    component: ChartBlock,
    propsSchema: chartBlockPropsSchema,
    description: '图表：限定 bar/line/pie，categories + series',
    allowPartialRender: true,
  });
}
