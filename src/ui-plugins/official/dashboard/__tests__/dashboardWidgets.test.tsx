/**
 * `dashboard.widgets` (FE-B8): dstu.ui.dashboard owns the slot, the official today cards come from dstu.ui.dashboard
 * and dstu.ui.learning-today, and community widgets are appended to the row and removed again when their plugin
 * unloads. The pre-FE-B8 DOM itself is covered by src/components/dashboard/__tests__/dashboardDom.test.tsx.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import type { DashboardWidgetProps } from '@/ui-plugins/official/dashboard/api';
import dashboardPlugin from '../index';
import learningTodayPlugin from '../../learning-today/index';

vi.mock('@/features/learning-today/todayLearning', () => ({
  loadTodayLearning: vi.fn(async () => ({ cards: 3, mistakes: 0, notes: 2, dueNotes: [] })),
}));
vi.mock('@/features/learning-today/openTodayReview', () => ({ openTodayReviewTarget: vi.fn() }));
vi.mock('@/features/todo/api', () => ({ listTodayItems: vi.fn(async () => [{ id: 'todo-1' }]) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@/components/dashboard/WeakConceptsStrip', async () => {
  const { createElement } = await import('react');
  return { WeakConceptsStrip: () => createElement('div', { 'data-testid': 'weak-concepts' }) };
});
vi.mock('@/components/dashboard/WeeklyReportActions', async () => {
  const { createElement } = await import('react');
  return { WeeklyReportActions: () => createElement('span', { 'data-testid': 'weekly-report' }) };
});

const OFFICIAL = [
  ['cards-due', 'dstu.ui.learning-today', 'row'],
  ['mistakes-due', 'dstu.ui.learning-today', 'row'],
  ['notes-due', 'dstu.ui.learning-today', 'row'],
  ['todo-due', 'dstu.ui.dashboard', 'row'],
  ['active-jobs', 'dstu.ui.dashboard', 'row'],
  ['weekly-report', 'dstu.ui.learning-today', 'header'],
  ['weak-concepts', 'dstu.ui.dashboard', 'below'],
];

function StudyStats({ today }: DashboardWidgetProps) {
  return <div data-testid="study-stats">due {today.cardsDue + today.mistakesDue + today.notesDue}</div>;
}

function QuickNote() {
  return <button type="button" data-testid="quick-note">quick note</button>;
}

function PhoneOnly() {
  return <div data-testid="phone-only" />;
}

function Broken(): React.ReactElement {
  throw new Error('widget exploded');
}

const studyStats = defineUiPlugin({
  meta: { id: 'example.study-stats', version: '0.1.0' },
  apply(ctx) {
    ctx.ui.i18n.addBundles({ 'zh-CN': { title: '学习统计' }, 'en-US': { title: 'Study stats' } });
    ctx.ui.contribute('dashboard.widgets', { id: 'study-stats', order: 900, value: { size: 'md', titleKey: 'title', component: StudyStats } });
    ctx.ui.contribute('dashboard.widgets', { id: 'quick-note', order: 25, value: { size: 'sm', component: QuickNote } });
    ctx.ui.contribute('dashboard.widgets', { id: 'phone-only', order: 26, value: { size: 'sm', platforms: ['mobile'], component: PhoneOnly } });
  },
});

function HeaderLink({ today }: DashboardWidgetProps) {
  return <a data-testid="header-link">notes {today.notesDue}</a>;
}

function Insight({ today }: DashboardWidgetProps) {
  return <p data-testid="insight">cards {today.cardsDue}</p>;
}

const aroundTheRow = defineUiPlugin({
  meta: { id: 'example.around-the-row', version: '0.1.0' },
  apply(ctx) {
    ctx.ui.contribute('dashboard.widgets', { id: 'header-link', order: 10, value: { placement: 'header', size: 'sm', component: HeaderLink } });
    ctx.ui.contribute('dashboard.widgets', { id: 'insight', order: 65, value: { placement: 'below', size: 'lg', component: Insight } });
  },
});

const broken = defineUiPlugin({
  meta: { id: 'example.broken-widget', version: '0.1.0' },
  apply(ctx) {
    ctx.ui.contribute('dashboard.widgets', { id: 'broken', order: 15, value: { size: 'sm', component: Broken } });
  },
});

let TodayCommandCenter: typeof import('@/components/dashboard/TodayCommandCenter').TodayCommandCenter;

beforeAll(async () => {
  ({ TodayCommandCenter } = await import('@/components/dashboard/TodayCommandCenter'));
}, 30_000);

afterEach(() => cleanup());

async function dashboardKernel() {
  const kernel = new UiKernel();
  await kernel.install(dashboardPlugin, { origin: 'builtin' });
  await kernel.install(learningTodayPlugin, { origin: 'builtin' });
  return kernel;
}

async function renderToday(kernel: UiKernel) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<UiKernelProvider kernel={kernel}><TodayCommandCenter /></UiKernelProvider>);
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

function row(container: HTMLElement): Element {
  const element = container.querySelector('.flex.flex-wrap.gap-3');
  if (!element) throw new Error('today row not rendered');
  return element;
}

/** Row items in order: official cards by label, community items by plugin/test id. */
function rowItems(container: HTMLElement): string[] {
  return Array.from(row(container).children).map((child) => {
    const plugin = child.getAttribute('data-ds-plugin');
    if (plugin) return `${plugin}:${child.querySelector('[data-ds-widget]')?.getAttribute('data-ds-widget') ?? child.querySelector('[data-testid]')?.getAttribute('data-testid')}`;
    return child.querySelector('.text-\\[13px\\]')?.textContent ?? child.tagName;
  });
}

function itemName(element: Element): string {
  const plugin = element.getAttribute('data-ds-plugin');
  if (plugin) return `${plugin}:${element.querySelector('[data-ds-widget]')?.getAttribute('data-ds-widget') ?? element.querySelector('[data-testid]')?.getAttribute('data-testid')}`;
  return element.getAttribute('data-testid') ?? element.tagName.toLowerCase();
}

/** The "today" section's children: the header with its items, the row, then whatever sits under the row. */
function sectionLayout(section: Element): string[] {
  return Array.from(section.children).map((child, index) => {
    if (index === 0) return `header: ${Array.from(child.children).map(itemName).join(' | ')}`;
    if (child.matches('.flex.flex-wrap.gap-3')) return 'row';
    return itemName(child);
  });
}

describe('dashboard.widgets', () => {
  it('dstu.ui.dashboard declares the slot; the official cards come from their feature plugins, revoked on unload', async () => {
    const kernel = await dashboardKernel();
    expect(kernel.slots.definitions().find((def) => def.name === 'dashboard.widgets')?.cardinality).toBe('list');
    expect(kernel.slots.list('dashboard.widgets').map((entry) => [entry.id, entry.owner, entry.value.placement ?? 'row'])).toEqual(OFFICIAL);
    expect(kernel.slots.list('dashboard.widgets').every((entry) => entry.origin === 'builtin' && entry.value.size === 'sm')).toBe(true);

    await kernel.unload('dstu.ui.learning-today');
    expect(kernel.slots.list('dashboard.widgets').map((entry) => entry.id)).toEqual(['todo-due', 'active-jobs', 'weak-concepts']);
    await kernel.dispose();
  });

  it('places header links next to the title and strips under the row, community ones included, until unload', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(aroundTheRow, { origin: 'community' });
    const { container } = await renderToday(kernel);
    const section = container.querySelector('.mb-6')!;
    const header = section.querySelector('.mb-2.flex.items-baseline')!;

    expect(sectionLayout(section)).toEqual([
      'header: h2 | example.around-the-row:header-link | weekly-report',
      'row',
      'example.around-the-row:insight',
      'weak-concepts',
    ]);
    expect(rowItems(container)).toEqual(['到期卡片', '错题复习', '待复习笔记', '今日待办', '运行中任务']);
    const insight = section.querySelector('[data-ds-plugin="example.around-the-row"] > section[data-ds-widget="insight"]');
    expect(insight?.className).toBe('flex basis-full flex-col gap-2');
    expect(insight?.querySelector('[data-testid="insight"]')?.textContent).toBe('cards 3');
    expect(header.querySelector('[data-testid="header-link"]')?.textContent).toBe('notes 2');

    await act(async () => {
      await kernel.unload('example.around-the-row');
    });
    expect(sectionLayout(section)).toEqual(['header: h2 | weekly-report', 'row', 'weak-concepts']);
    await kernel.dispose();
  });

  it('appends community widgets in order, frames md widgets with their title, and removes them on unload', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(studyStats, { origin: 'community' });
    const { container, getByTestId, queryByTestId } = await renderToday(kernel);

    expect(rowItems(container)).toEqual([
      '到期卡片', '错题复习', 'example.study-stats:quick-note', '待复习笔记', '今日待办', '运行中任务',
      'example.study-stats:study-stats',
    ]);
    expect(queryByTestId('phone-only')).toBeNull();
    const frame = container.querySelector('[data-ds-plugin="example.study-stats"] > section[data-ds-widget="study-stats"]');
    expect(frame?.querySelector('h3')?.textContent).toMatch(/^(学习统计|Study stats)$/);
    expect(getByTestId('study-stats').textContent).toBe('due 5');

    await act(async () => {
      await kernel.unload('example.study-stats');
    });
    expect(container.querySelector('[data-ds-plugin]')).toBeNull();
    expect(rowItems(container)).toEqual(['到期卡片', '错题复习', '待复习笔记', '今日待办', '运行中任务']);
    await kernel.dispose();
  });

  it('shows platform-restricted widgets on their platform only', async () => {
    const kernel = new UiKernel({ platform: { kind: 'mobile', os: 'ios', capabilities: [] } });
    await kernel.install(dashboardPlugin, { origin: 'builtin' });
    await kernel.install(studyStats, { origin: 'community' });
    const { getByTestId } = await renderToday(kernel);
    expect(getByTestId('phone-only')).toBeTruthy();
    await kernel.dispose();
  });

  it('isolates a failing community widget and reports it', async () => {
    const kernel = await dashboardKernel();
    await kernel.install(broken, { origin: 'community' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = await renderToday(kernel);
      expect(rowItems(container)).toEqual([
        '到期卡片', 'example.broken-widget:undefined', '错题复习', '待复习笔记', '今日待办', '运行中任务',
      ]);
      expect(kernel.errors.list().map((report) => [report.pluginId, report.slot, report.entryId])).toEqual([
        ['example.broken-widget', 'dashboard.widgets', 'broken'],
      ]);
    } finally {
      error.mockRestore();
      await kernel.dispose();
    }
  });
});
