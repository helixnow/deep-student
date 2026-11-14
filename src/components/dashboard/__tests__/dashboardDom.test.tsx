/**
 * FE-B8 evidence: dashboard DOM (today command center and the statistics overview, desktop and phone) and what
 * each card opens.
 *
 * `renderDashboard` is the assembly under test: the app's UI kernel (official plugins contribute the cards to
 * `dashboard.widgets` and `dashboard.stats`). The serialized DOM and the click log must stay equal to the goldens captured before FE-B8,
 * when the components rendered their cards inline; so must a window without a UI kernel. `overview.charts.txt` is the
 * chart area for each statistics state (which charts have data, the "no data yet" card), captured while the overview
 * still rendered its charts inline; desktop, mobile, embedded and a window without a UI kernel all match it.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { serializeDom } from '@/ui-plugins/testing/dom-snapshot';

const h = vi.hoisted(() => {
  const loaded = {
    basic_stats: { total_mistakes: 1234, tag_stats: { 代数: 5, 几何: 3 } as Record<string, unknown> | null },
    recent_growth: 12,
    recent_additions: 7,
    quality_score: 88,
    image_stats: { total_files: 4, total_size_bytes: 2048000 },
    monthly_trend: [{ month: '2026-09', count: 3 }] as unknown,
  };
  /** What get_enhanced_statistics returns (Rust commands.rs and the host qbank plugin): image statistics only. */
  const backendReply = {
    image_stats: { total_files: 3, total_size_bytes: 1572864, file_types: { png: 2, jpg: 1 }, oldest_file: 1767225600, newest_file: 1794000000 },
    timestamp: '2026-11-07T02:00:00.123456+00:00',
  };
  return {
    log: [] as string[],
    counts: { cards: 3, mistakes: 0, notes: 2, todo: 1, jobs: 1 },
    smallScreen: false,
    loaded,
    backendReply,
    data: { enhanced: loaded } as { enhanced?: unknown } | null,
  };
});

vi.mock('@/features/learning-today/todayLearning', () => ({
  loadTodayLearning: vi.fn(async () => ({ cards: h.counts.cards, mistakes: h.counts.mistakes, notes: h.counts.notes, dueNotes: [] })),
}));
vi.mock('@/features/learning-today/openTodayReview', () => ({
  openTodayReviewTarget: vi.fn((target: string) => h.log.push(`openTodayReviewTarget:${target}`)),
}));
vi.mock('@/features/todo/api', () => ({
  listTodayItems: vi.fn(async () => Array.from({ length: h.counts.todo }, (_, i) => ({ id: `todo-${i}` }))),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'list_document_sessions') return [{ activeTasks: h.counts.jobs }, { activeTasks: 0 }];
    if (cmd === 'mastery_get_overview') {
      return { conceptCount: 3, weakCount: 1, avgScore: 0.6, weakest: [{ conceptKey: '导数', score: 0.32, total: 6, wrongCount: 4 }] };
    }
    throw new Error(`unexpected invoke ${cmd}`);
  }),
}));
vi.mock('@/hooks/useStatisticsData', () => ({
  useAllStatistics: () => ({
    data: h.data,
    loading: false,
    error: null,
    isRefreshing: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('@/hooks/useViewVisibility', () => ({ useViewVisibility: () => ({ isActive: true }) }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: h.smallScreen }) }));
vi.mock('@/components/layout', () => ({
  useMobileHeader: () => undefined,
  MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="mobile-sliding-layout">{children}</div>,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div data-testid="custom-scroll-area">{children}</div>,
}));

const GOLDEN_DIR = 'src/components/dashboard/__tests__/__golden__';
const CAPTURE = process.env.FE_B8_CAPTURE_GOLDEN === '1';

let kernel: UiKernel | undefined;

/** Assembly: how the app mounts the dashboard surfaces. */
async function renderDashboard(ui: React.ReactElement, withKernel = true) {
  if (withKernel && !kernel) {
    const { createAppUiKernel } = await import('@/ui-kernel/bootstrap');
    kernel = await createAppUiKernel();
  }
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(kernel && withKernel ? <UiKernelProvider kernel={kernel}>{ui}</UiKernelProvider> : ui);
  });
  return result;
}

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, current, { flag: 'wx' });
  }
  return fs.readFileSync(file, 'utf8');
}

const onNavigate = (view: string) => h.log.push(`onNavigate:${view}`);

/** Statistics states for the chart area: which charts have data, and the "no data yet" card. */
const CHART_STATES: [string, () => { enhanced?: unknown } | null][] = [
  ['both charts', () => ({ enhanced: h.loaded })],
  ['trend only', () => ({ enhanced: { ...h.loaded, basic_stats: { ...h.loaded.basic_stats, tag_stats: {} } } })],
  ['tags only', () => ({ enhanced: { ...h.loaded, monthly_trend: [] } })],
  ['no chart data', () => ({ enhanced: { ...h.loaded, basic_stats: { total_mistakes: 0, tag_stats: {} }, monthly_trend: [] } })],
  ['malformed chart data', () => ({ enhanced: { ...h.loaded, basic_stats: { total_mistakes: 0, tag_stats: null }, monthly_trend: { month: '2026-09' } } })],
  ['statistics without enhanced', () => ({})],
  ['no statistics', () => null],
];

/** What the overview renders after the statistics grid (the chart area). */
function chartArea(container: HTMLElement): string {
  const content = container.querySelector('.sota-unified-content');
  if (!content) throw new Error('overview content not rendered');
  const clone = content.cloneNode(true) as Element;
  while (clone.firstChild) {
    const first = clone.firstChild;
    first.remove();
    if (first instanceof Element && first.classList.contains('sota-stats-grid')) break;
  }
  return serializeDom(clone);
}

async function chartAreas(ui: () => React.ReactElement, withKernel = true): Promise<string> {
  const sections: string[] = [];
  for (const [state, data] of CHART_STATES) {
    h.data = data();
    const { container, unmount } = await renderDashboard(ui(), withKernel);
    await settle();
    sections.push(`## ${state}\n${chartArea(container)}`);
    unmount();
  }
  return `${sections.join('\n')}\n`;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let TodayCommandCenter: typeof import('../TodayCommandCenter').TodayCommandCenter;
let SOTADashboard: typeof import('../../SOTADashboardLite').SOTADashboard;

beforeAll(async () => {
  ({ TodayCommandCenter } = await import('../TodayCommandCenter'));
  ({ SOTADashboard } = await import('../../SOTADashboardLite'));
  await import('@/ui-kernel/bootstrap');
}, 30_000);

afterAll(async () => {
  await kernel?.dispose();
});

beforeEach(() => {
  h.log.length = 0;
  h.counts = { cards: 3, mistakes: 0, notes: 2, todo: 1, jobs: 1 };
  h.smallScreen = false;
  h.data = { enhanced: h.loaded };
});

afterEach(() => cleanup());

describe('dashboard DOM (FE-B8)', () => {
  // First: once the official plugins attach, announcements go to the kernel for the rest of the process.
  it('renders the same today command center in a window without a UI kernel', async () => {
    const { container } = await renderDashboard(<TodayCommandCenter onNavigate={onNavigate} />, false);
    await settle();
    expect(`${serializeDom(container)}\n`).toBe(golden('today-center.due.txt', ''));
  });

  it('renders the same statistics overview in a window without a UI kernel', async () => {
    const { container } = await renderDashboard(<SOTADashboard onNavigate={onNavigate} />, false);
    await settle();
    expect(`${serializeDom(container)}\n`).toBe(golden('overview.desktop.txt', ''));
  });

  it('renders the same chart area for every statistics state in a window without a UI kernel', async () => {
    const current = await chartAreas(() => <SOTADashboard onNavigate={onNavigate} />, false);
    expect(current).toBe(golden('overview.charts.txt', current));
  });

  it('renders the same overview from the backend statistics reply in a window without a UI kernel', async () => {
    h.data = { enhanced: h.backendReply };
    const { container } = await renderDashboard(<SOTADashboard onNavigate={onNavigate} />, false);
    await settle();
    expect(`${serializeDom(container)}\n`).toBe(golden('overview.backend-reply.txt', ''));
  });

  it('renders the today command center with due work', async () => {
    const { container } = await renderDashboard(<TodayCommandCenter onNavigate={onNavigate} />);
    await settle();
    const current = `${serializeDom(container)}\n`;
    expect(current).toBe(golden('today-center.due.txt', current));
  });

  it('renders the today command center when everything is done', async () => {
    h.counts = { cards: 0, mistakes: 0, notes: 0, todo: 0, jobs: 0 };
    const { container } = await renderDashboard(<TodayCommandCenter onNavigate={onNavigate} />);
    await settle();
    const current = `${serializeDom(container)}\n`;
    expect(current).toBe(golden('today-center.clear.txt', current));
  });

  it('opens the same target from every today card', async () => {
    const { container } = await renderDashboard(<TodayCommandCenter onNavigate={onNavigate} />);
    await settle();
    const row = container.querySelector('.flex.flex-wrap.gap-3');
    if (!row) throw new Error('today action row not rendered');
    const cards = Array.from(row.querySelectorAll<HTMLButtonElement>(':scope > button, :scope > [data-ds-plugin] > button'));
    const clicks = cards.map((card) => {
      h.log.length = 0;
      fireEvent.click(card);
      return { card: within(card).getAllByText(/./)[0]?.textContent ?? '', calls: [...h.log] };
    });
    const current = `${JSON.stringify(clicks, null, 2)}\n`;
    expect(current).toBe(golden('today-center.clicks.json', current));
  });

  it.each([
    ['desktop', false],
    ['mobile', true],
  ])('renders the statistics overview on %s', async (name, small) => {
    h.smallScreen = small;
    const { container } = await renderDashboard(<SOTADashboard onNavigate={onNavigate} />);
    await settle();
    expect(screen.getAllByText('1.2K').length).toBeGreaterThan(0);
    const current = `${serializeDom(container)}\n`;
    expect(current).toBe(golden(`overview.${name}.txt`, current));
  });

  it('renders the overview from the backend statistics reply: only the resource-file card has data', async () => {
    h.data = { enhanced: h.backendReply };
    const { container } = await renderDashboard(<SOTADashboard onNavigate={onNavigate} />);
    await settle();
    const current = `${serializeDom(container)}\n`;
    expect(current).toBe(golden('overview.backend-reply.txt', current));
  });

  it('renders the embedded statistics overview', async () => {
    const { container } = await renderDashboard(<SOTADashboard embedded onNavigate={onNavigate} />);
    await settle();
    const current = `${serializeDom(container)}\n`;
    expect(current).toBe(golden('overview.embedded.txt', current));
  });

  it.each([
    ['desktop', false, false],
    ['mobile', true, false],
    ['embedded', false, true],
  ])('renders the chart area for every statistics state on %s', async (_name, small, embedded) => {
    h.smallScreen = small;
    const current = await chartAreas(() => <SOTADashboard embedded={embedded} onNavigate={onNavigate} />);
    expect(current).toBe(golden('overview.charts.txt', current));
  });
});
