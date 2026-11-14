/**
 * `dashboard.stats` (FE-B8): dstu.ui.dashboard owns the slot and contributes the five official statistics cards;
 * community cards join the overview grid in order and leave it when their plugin unloads. The pre-FE-B8 DOM itself is
 * covered by src/components/dashboard/__tests__/dashboardDom.test.tsx.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { DashboardStatProps } from '@/ui-plugins/official/dashboard/api';
import dashboardPlugin from '../index';

vi.mock('@/features/learning-today/todayLearning', () => ({
  loadTodayLearning: vi.fn(async () => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] })),
}));
vi.mock('@/features/learning-today/openTodayReview', () => ({ openTodayReviewTarget: vi.fn() }));
vi.mock('@/features/todo/api', () => ({ listTodayItems: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@/components/dashboard/WeakConceptsStrip', () => ({ WeakConceptsStrip: () => null }));
vi.mock('@/components/dashboard/WeeklyReportActions', () => ({ WeeklyReportActions: () => null }));
vi.mock('@/hooks/useStatisticsData', () => ({
  useAllStatistics: () => ({
    data: { enhanced: { basic_stats: { total_mistakes: 12, tag_stats: { 代数: 1 } }, recent_additions: 3, quality_score: 90 } },
    loading: false,
    error: null,
    isRefreshing: false,
    refresh: vi.fn(),
  }),
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

const OFFICIAL = ['learning-records', 'tags-count', 'recent-additions', 'data-quality', 'resource-files'];
const OFFICIAL_TITLES = ['学习记录', '标签体系', '近7天新增', '数据质量', '资源文件'];

function StreakStat({ statistics }: DashboardStatProps) {
  return <div data-testid="streak">records {String(statistics?.basic_stats?.total_mistakes)}</div>;
}

function PhoneOnly() {
  return <div data-testid="phone-only" />;
}

function Broken(): React.ReactElement {
  throw new Error('stat exploded');
}

const streak = defineUiPlugin({
  meta: { id: 'example.streak', version: '0.1.0' },
  apply(ctx) {
    ctx.ui.contribute('dashboard.stats', { id: 'streak', order: 25, value: { component: StreakStat } });
    ctx.ui.contribute('dashboard.stats', { id: 'phone-only', order: 900, value: { platforms: ['mobile'], component: PhoneOnly } });
  },
});

const broken = defineUiPlugin({
  meta: { id: 'example.broken-stat', version: '0.1.0' },
  apply(ctx) {
    ctx.ui.contribute('dashboard.stats', { id: 'broken', order: 15, value: { component: Broken } });
  },
});

let SOTADashboard: typeof import('@/components/SOTADashboardLite').SOTADashboard;

beforeAll(async () => {
  ({ SOTADashboard } = await import('@/components/SOTADashboardLite'));
}, 30_000);

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

/** Grid cells in order: official cards by title, community cards by plugin and test id. */
function gridItems(container: HTMLElement): string[] {
  const grid = container.querySelector('.sota-stats-grid');
  if (!grid) throw new Error('statistics grid not rendered');
  return Array.from(grid.children).map((child) => {
    const plugin = child.getAttribute('data-ds-plugin');
    if (plugin) return `${plugin}:${child.querySelector('[data-testid]')?.getAttribute('data-testid')}`;
    return child.querySelector('.text-base')?.firstChild?.textContent ?? child.tagName;
  });
}

describe('dashboard.stats', () => {
  it('dstu.ui.dashboard declares the slot and contributes the official cards, revoked on unload', async () => {
    const kernel = await dashboardKernel();
    expect(kernel.slots.definitions().find((def) => def.name === 'dashboard.stats')?.cardinality).toBe('list');
    expect(kernel.slots.list('dashboard.stats').map((entry) => entry.id)).toEqual(OFFICIAL);
    expect(kernel.slots.list('dashboard.stats').every((entry) => entry.owner === 'dstu.ui.dashboard' && entry.origin === 'builtin')).toBe(true);

    await kernel.unload('dstu.ui.dashboard');
    expect(kernel.slots.list('dashboard.stats')).toEqual([]);
    await kernel.dispose();
  });

  it('appends community cards in order with the loaded statistics, and removes them on unload', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(streak, { origin: 'community' });
    const { container, getByTestId, queryByTestId } = await renderOverview(kernel);

    expect(gridItems(container)).toEqual([
      OFFICIAL_TITLES[0], OFFICIAL_TITLES[1], 'example.streak:streak', ...OFFICIAL_TITLES.slice(2),
    ]);
    expect(getByTestId('streak').textContent).toBe('records 12');
    expect(queryByTestId('phone-only')).toBeNull();

    await act(async () => {
      await kernel.unload('example.streak');
    });
    expect(container.querySelector('.sota-stats-grid [data-ds-plugin]')).toBeNull();
    expect(gridItems(container)).toEqual(OFFICIAL_TITLES);
    await kernel.dispose();
  });

  it('shows platform-restricted cards on their platform only', async () => {
    const kernel = await dashboardKernel(new UiKernel({ platform: { kind: 'mobile', os: 'ios', capabilities: [] } }));
    await kernel.install(streak, { origin: 'community' });
    const { getByTestId } = await renderOverview(kernel);
    expect(getByTestId('phone-only')).toBeTruthy();
    await kernel.dispose();
  });

  it('isolates a failing community card and reports it', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(broken, { origin: 'community' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = await renderOverview(kernel);
      expect(gridItems(container)).toEqual([OFFICIAL_TITLES[0], 'example.broken-stat:undefined', ...OFFICIAL_TITLES.slice(1)]);
      expect(kernel.errors.list().map((report) => [report.pluginId, report.slot, report.entryId])).toEqual([
        ['example.broken-stat', 'dashboard.stats', 'broken'],
      ]);
    } finally {
      error.mockRestore();
      await kernel.dispose();
    }
  });
});
