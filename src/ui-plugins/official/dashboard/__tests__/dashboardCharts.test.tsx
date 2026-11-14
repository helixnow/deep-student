/**
 * `dashboard.charts` (FE-B8): dstu.ui.dashboard owns the slot and contributes the two official charts. The overview
 * leaves out every chart whose `hasData` is false and shows one "no chart data yet" card when no chart shown on the
 * platform has data, whoever contributed it. The pre-slot DOM for each statistics state is covered by
 * src/components/dashboard/__tests__/dashboardDom.test.tsx (`overview.charts.txt`).
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { DashboardChart, DashboardChartProps } from '@/ui-plugins/official/dashboard/api';
import dashboardPlugin from '../index';

const h = vi.hoisted(() => ({
  enhanced: {} as Record<string, unknown>,
}));

vi.mock('@/features/learning-today/todayLearning', () => ({
  loadTodayLearning: vi.fn(async () => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] })),
}));
vi.mock('@/features/learning-today/openTodayReview', () => ({ openTodayReviewTarget: vi.fn() }));
vi.mock('@/features/todo/api', () => ({ listTodayItems: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@/components/dashboard/WeakConceptsStrip', () => ({ WeakConceptsStrip: () => null }));
vi.mock('@/components/dashboard/WeeklyReportActions', () => ({ WeeklyReportActions: () => null }));
vi.mock('@/hooks/useStatisticsData', () => ({
  useAllStatistics: () => ({ data: { enhanced: h.enhanced }, loading: false, error: null, isRefreshing: false, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useViewVisibility', () => ({ useViewVisibility: () => ({ isActive: true }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/components/layout', () => ({
  useMobileHeader: () => undefined,
  MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const WITH_DATA = { basic_stats: { total_mistakes: 3, tag_stats: { 代数: 2 } }, monthly_trend: [{ month: '2026-10', count: 3 }] };
const NO_DATA = { basic_stats: { total_mistakes: 0, tag_stats: {} }, monthly_trend: [] };
const EMPTY_CARD = '暂无图表数据';

function StreakChart({ statistics }: DashboardChartProps) {
  return <div className="sota-chart-card" data-testid="streak">streak {String(statistics.streak_days)}</div>;
}

function plugin(id: string, value: Omit<DashboardChart, 'component'>) {
  return defineUiPlugin({
    meta: { id, version: '0.1.0' },
    apply(ctx) {
      ctx.ui.contribute('dashboard.charts', { id: 'chart', order: 15, value: { component: StreakChart, ...value } });
    },
  });
}

const streak = plugin('example.streak', { hasData: (statistics) => Number(statistics.streak_days) > 0 });
const alwaysShown = plugin('example.always', {});
const phoneOnly = plugin('example.phone-only', { platforms: ['mobile'] });
const throwing = plugin('example.throwing', {
  hasData: () => {
    throw new Error('hasData exploded');
  },
});

let SOTADashboard: typeof import('@/components/SOTADashboardLite').SOTADashboard;

beforeAll(async () => {
  ({ SOTADashboard } = await import('@/components/SOTADashboardLite'));
}, 30_000);

beforeEach(() => {
  h.enhanced = { ...NO_DATA };
});

afterEach(() => cleanup());

async function dashboardKernel(kernel = new UiKernel()) {
  await kernel.install(dashboardPlugin, { origin: 'builtin' });
  return kernel;
}

async function renderOverview(kernel: UiKernel) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<UiKernelProvider kernel={kernel}><SOTADashboard /></UiKernelProvider>);
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

/** Chart area cells in order: chart titles, community charts by plugin and test id, the empty card by its title. */
function chartCells(container: HTMLElement): string[] {
  const area = container.querySelector('.sota-charts');
  if (!area) throw new Error('chart area not rendered');
  return Array.from(area.children).map((child) => {
    const plugin = child.getAttribute('data-ds-plugin');
    if (plugin) return `${plugin}:${child.querySelector('[data-testid]')?.getAttribute('data-testid')}`;
    return (child.querySelector('h3, .sota-chart-empty__title')?.textContent ?? child.tagName).trim();
  });
}

describe('dashboard.charts', () => {
  it('dstu.ui.dashboard declares the slot and contributes the official charts, revoked on unload', async () => {
    const kernel = await dashboardKernel();
    expect(kernel.slots.definitions().find((def) => def.name === 'dashboard.charts')?.cardinality).toBe('list');
    expect(kernel.slots.list('dashboard.charts').map((entry) => entry.id)).toEqual(['data-trend', 'top-tags']);
    expect(kernel.slots.list('dashboard.charts').every((entry) => entry.owner === 'dstu.ui.dashboard' && entry.origin === 'builtin')).toBe(true);

    await kernel.unload('dstu.ui.dashboard');
    expect(kernel.slots.list('dashboard.charts')).toEqual([]);
    await kernel.dispose();
  });

  it('official charts decide the empty card on their own: one card when neither has data', async () => {
    const kernel = await dashboardKernel();
    h.enhanced = { ...WITH_DATA };
    const loaded = await renderOverview(kernel);
    expect(chartCells(loaded.container)).toEqual(['数据趋势', '标签 Top 8']);
    loaded.unmount();

    h.enhanced = { ...NO_DATA };
    const { container } = await renderOverview(kernel);
    expect(chartCells(container)).toEqual([EMPTY_CARD]);
    await kernel.dispose();
  });

  it('a community chart with data replaces the empty card and gets the loaded statistics; unloading brings the card back', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(streak, { origin: 'community' });
    h.enhanced = { ...NO_DATA, streak_days: 4 };
    const { container, getByTestId } = await renderOverview(kernel);

    expect(chartCells(container)).toEqual(['example.streak:streak']);
    expect(getByTestId('streak').textContent).toBe('streak 4');

    await act(async () => {
      await kernel.unload('example.streak');
    });
    expect(chartCells(container)).toEqual([EMPTY_CARD]);
    await kernel.dispose();
  });

  it('a community chart without data is left out, next to official charts or before the empty card', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(streak, { origin: 'community' });
    h.enhanced = { ...WITH_DATA, streak_days: 0 };
    const loaded = await renderOverview(kernel);
    expect(chartCells(loaded.container)).toEqual(['数据趋势', '标签 Top 8']);
    loaded.unmount();

    h.enhanced = { ...NO_DATA, streak_days: 0 };
    const { container } = await renderOverview(kernel);
    expect(chartCells(container)).toEqual([EMPTY_CARD]);
    await kernel.dispose();
  });

  it('a chart without hasData always counts as having data, in slot order', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(alwaysShown, { origin: 'community' });
    h.enhanced = { ...WITH_DATA };
    const loaded = await renderOverview(kernel);
    expect(chartCells(loaded.container)).toEqual(['数据趋势', 'example.always:streak', '标签 Top 8']);
    loaded.unmount();

    h.enhanced = { ...NO_DATA };
    const { container } = await renderOverview(kernel);
    expect(chartCells(container)).toEqual(['example.always:streak']);
    await kernel.dispose();
  });

  it('a chart for another platform does not count: the empty card stays on desktop', async () => {
    const desktop = await dashboardKernel();
    await desktop.install(phoneOnly, { origin: 'community' });
    const onDesktop = await renderOverview(desktop);
    expect(chartCells(onDesktop.container)).toEqual([EMPTY_CARD]);
    onDesktop.unmount();
    await desktop.dispose();

    const mobile = await dashboardKernel(new UiKernel({ platform: { kind: 'mobile', os: 'ios', capabilities: [] } }));
    await mobile.install(phoneOnly, { origin: 'community' });
    const { container } = await renderOverview(mobile);
    expect(chartCells(container)).toEqual(['example.phone-only:streak']);
    await mobile.dispose();
  });

  it('a throwing hasData hides only that chart and is reported', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(throwing, { origin: 'community' });
    h.enhanced = { ...WITH_DATA };
    const loaded = await renderOverview(kernel);
    expect(chartCells(loaded.container)).toEqual(['数据趋势', '标签 Top 8']);
    expect(kernel.errors.list().map((report) => [report.pluginId, report.phase, report.slot, report.entryId])).toEqual([
      ['example.throwing', 'filter', 'dashboard.charts', 'chart'],
    ]);
    loaded.unmount();

    h.enhanced = { ...NO_DATA };
    const { container } = await renderOverview(kernel);
    expect(chartCells(container)).toEqual([EMPTY_CARD]);
    await kernel.dispose();
  });
});
