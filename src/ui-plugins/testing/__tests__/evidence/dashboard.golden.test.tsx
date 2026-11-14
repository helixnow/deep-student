/**
 * FE-B8 evidence: the dashboard (总览, `SOTADashboardLite`) as the app mounts it, desktop 1440 and mobile 390.
 * The demo shell stubs this page, so the FE-A1 DOM/screenshot layers do not see it; this golden does.
 * - `dashboard.<viewport>.<state>.dom.txt`: DOM (plus the mobile top-bar config the page publishes) for
 *   loaded / empty / error / loading data, and the embedded form on desktop.
 * - `dashboard.json`: IPC call shapes per state and a hash of the page's inline stylesheet.
 * - `dashboard.actions.json`: what each button of the loaded desktop dashboard does (navigation callback,
 *   window events, IPC, downloads, the dialog it opens and what that dialog's buttons do).
 * Data comes from fixed IPC fixtures; the clock is fixed so the weekly report window is stable.
 */
import { createHash } from 'node:crypto';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getCtInvokeCalls, resetCtInvokeHandlers, setCtInvokeHandlers, type CtInvokeHandler } from '../../../../../tests/ct/mocks/tauri-core-mock';
import { serializeDom } from '../../dom-snapshot';
import { bootAppUi, callShape, expectGolden, type AppUi } from './harness';

vi.mock('react-i18next', () => import('./i18nMock'));

const BASE_TIME = new Date('2026-11-07T08:00:00+08:00').getTime();
const VIEWPORTS = { desktop: 1440, mobile: 390 } as const;
type Viewport = keyof typeof VIEWPORTS;

const LOADED: Record<string, CtInvokeHandler> = {
  get_enhanced_statistics: () => ({
    basic_stats: { total_mistakes: 1234, tag_stats: { 函数: 12, 导数: 8, 概率: 5, 数列: 3 } },
    recent_growth: 12,
    recent_additions: 7,
    quality_score: 86,
    image_stats: { total_files: 42, total_size_bytes: 5_242_880 },
    monthly_trend: [{ month: '2026-09', count: 10 }, { month: '2026-10', count: 20 }],
  }),
  fsrs_get_stats: () => ({ due: 5, total: 120 }),
  review_plan_get_stats: () => ({ due_today: 3, total_plans: 40 }),
  todo_list_today: () => [{ id: 'todo-1' }, { id: 'todo-2' }],
  list_document_sessions: () => [{ activeTasks: 2 }, { activeTasks: 0 }],
  mastery_get_overview: () => ({
    conceptCount: 3, weakCount: 2, avgScore: 0.5,
    weakest: [
      { conceptKey: '函数单调性', score: 0.31, total: 10, wrongCount: 7 },
      { conceptKey: 'item:untagged', score: 0.1, total: 2, wrongCount: 2 },
      { conceptKey: '等比数列', score: 0.55, total: 8, wrongCount: 3 },
    ],
  }),
  qbank_get_activity_heatmap: () => [{ date: '2026-11-05', count: 6, correct_count: 4 }],
  fsrs_get_review_statistics: () => ({ dailyReviews: [{ date: '2026-11-06', total: 9, again: 2 }] }),
  pomodoro_stats_overview: () => ({ daily: [{ date: '2026-11-06', focusSeconds: 1500, completedCount: 1 }] }),
  study_time_range: () => [{ date: '2026-11-04', seconds: 3600 }],
  // Folder picker behind the weekly report's "save as note".
  dstu_folder_get_tree: () => [
    { folder: { id: 'fld_reports01', parentId: null, title: '周报', isExpanded: false, sortOrder: 0, createdAt: 0, updatedAt: 0 }, children: [], items: [] },
  ],
};

const EMPTY: Record<string, CtInvokeHandler> = {
  get_enhanced_statistics: () => ({ basic_stats: { total_mistakes: 0, tag_stats: {} }, recent_additions: 0, quality_score: 0, image_stats: { total_files: 0 }, monthly_trend: [] }),
  fsrs_get_stats: () => ({ due: 0, total: 0 }),
  review_plan_get_stats: () => ({ due_today: 0, total_plans: 0 }),
  todo_list_today: () => [],
  list_document_sessions: () => [],
  mastery_get_overview: () => ({ conceptCount: 0, weakCount: 0, avgScore: 0, weakest: [] }),
};

const ERROR: Record<string, CtInvokeHandler> = {
  ...EMPTY,
  get_enhanced_statistics: () => Promise.reject(new Error('database is locked')),
};

function installMatchMedia(width: number) {
  const evaluate = (query: string) => query.split(/\s*,\s*/).some((part) => part.split(/\s+and\s+/).every((clause) => {
    const min = /min-width:\s*([\d.]+)px/.exec(clause);
    const max = /max-width:\s*([\d.]+)px/.exec(clause);
    if (min) return width >= Number(min[1]);
    if (max) return width <= Number(max[1]);
    if (/pointer:\s*coarse/.test(clause)) return width < 768;
    if (/prefers-reduced-motion/.test(clause)) return true;
    return false;
  }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: evaluate(query), media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }),
  });
}

/** jsdom has no layout; report a fixed box so recharts' ResponsiveContainer renders its charts. */
class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const contentRect = { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 300, width: 640, height: 300, toJSON() { return this; } };
    this.callback([{ target, contentRect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

/** What the charts plot: axis ticks and series shapes per chart card (the DOM golden keeps svg opaque). */
function chartSummary(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.sota-chart-card')).map((card) => ({
    title: card.querySelector('h3')?.textContent?.trim() ?? '',
    ticks: Array.from(card.querySelectorAll('.recharts-cartesian-axis-tick-value')).map((tick) => tick.textContent ?? ''),
    series: Array.from(card.querySelectorAll('.recharts-area-area, .recharts-area-curve, .recharts-bar-rectangle path, .recharts-bar-rectangle rect'))
      .map((shape) => `${shape.getAttribute('class') ?? shape.tagName} ${shape.getAttribute('d') ?? ''}`.replace(/\s+/g, ' ').trim()),
  }));
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** Reads the top-bar config the page publishes for the `dashboard` view. */
function HeaderProbe({ use }: { use: () => { config: { title?: string; showMenu?: boolean; rightActions?: React.ReactNode; hidden?: boolean } } }) {
  const { config } = use();
  return (
    <div data-evidence="mobile-header" data-title={config.title ?? ''} data-show-menu={String(!!config.showMenu)} data-hidden={String(!!config.hidden)}>
      {config.rightActions}
    </div>
  );
}

let app: AppUi;
let clock = 0;
const realMatchMedia = window.matchMedia;
const realInnerWidth = window.innerWidth;

async function mountDashboard(viewport: Viewport, handlers: Record<string, CtInvokeHandler>, props: { embedded?: boolean } = {}) {
  // Each mount is a later "boot" for the statistics cache (5 min TTL).
  clock += 1;
  vi.setSystemTime(BASE_TIME + clock * 3_600_000);
  installMatchMedia(VIEWPORTS[viewport]);
  setCtInvokeHandlers(handlers);
  const navigations: unknown[] = [];
  const [{ LazySOTADashboard: Dashboard }, layout] = await Promise.all([
    import('@/lazyComponents'),
    import('@/components/layout/MobileHeaderContext'),
  ]);
  const view = render(app.wrap(
    <layout.MobileHeaderProvider>
      <layout.MobileHeaderActiveViewSync activeView="dashboard" />
      <React.Suspense fallback={<div data-evidence="suspense-fallback" />}>
        <Dashboard embedded={props.embedded} onBack={() => navigations.push(['back'])} onNavigate={(target) => navigations.push(['navigate', target])} />
      </React.Suspense>
      <HeaderProbe use={layout.useMobileHeaderContext} />
    </layout.MobileHeaderProvider>,
  ));
  await settle(view.container);
  return { view, navigations };
}

/** Until the lazy page is in and the DOM has stopped changing for a few rounds. */
async function settle(container: HTMLElement) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await flush(2);
    if (container.querySelector('.sota-dashboard')) break;
    if (Date.now() > deadline) throw new Error('dashboard did not mount');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  let previous = '';
  for (let stable = 0; stable < 3;) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const current = serializeDom(container);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
}

function snapshot(container: HTMLElement): string {
  return serializeDom(container);
}

function styleHash(container: HTMLElement): string | null {
  const style = container.querySelector('style');
  return style ? createHash('sha256').update(style.textContent ?? '').digest('hex').slice(0, 16) : null;
}

function shapes(): string[] {
  return [...new Set(getCtInvokeCalls().map((call) => callShape(call.command, call.payload)))].sort();
}

/** Window CustomEvents (type + detail keys) dispatched while `run` executes. */
async function traceEvents(run: () => void | Promise<void>): Promise<string[]> {
  const events: string[] = [];
  const original = window.dispatchEvent.bind(window);
  window.dispatchEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    events.push(detail && typeof detail === 'object' ? `${event.type}{${Object.keys(detail).sort().join(',')}}=${JSON.stringify(detail)}` : event.type);
    return original(event);
  };
  try {
    await run();
  } finally {
    window.dispatchEvent = original;
  }
  return events.filter((type) => !/^(resize|scroll|focus|blur|storage)/.test(type));
}

describe('FE-B8 evidence: dashboard', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BASE_TIME);
    vi.stubGlobal('ResizeObserver', SizedResizeObserver);
    localStorage.clear();
    app = await bootAppUi();
  });
  afterEach(() => {
    cleanup();
    resetCtInvokeHandlers();
  });
  afterAll(async () => {
    await app.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realInnerWidth });
  });

  it('renders the same dashboard for each viewport and data state', async () => {
    const evidence: Record<string, unknown> = {};
    const cases: [Viewport, string, Record<string, CtInvokeHandler>, { embedded?: boolean }?][] = [
      ['desktop', 'loaded', LOADED], ['desktop', 'empty', EMPTY], ['desktop', 'error', ERROR], ['desktop', 'embedded', LOADED, { embedded: true }],
      ['mobile', 'loaded', LOADED], ['mobile', 'empty', EMPTY], ['mobile', 'error', ERROR],
    ];
    for (const [viewport, state, handlers, props] of cases) {
      const { view } = await mountDashboard(viewport, handlers, props);
      expectGolden(`dashboard.${viewport}.${state}.dom.txt`, snapshot(view.container));
      evidence[`${viewport}.${state}`] = { ipc: shapes(), style: styleHash(view.container), charts: chartSummary(view.container) };
      view.unmount();
      cleanup();
    }
    // Loading: the statistics request never settles while captured; released afterwards so no request stays in flight.
    for (const viewport of ['desktop', 'mobile'] as const) {
      let release: (value: unknown) => void = () => {};
      const pending = new Promise((resolve) => { release = resolve; });
      const { view } = await mountDashboard(viewport, { ...LOADED, get_enhanced_statistics: () => pending });
      expectGolden(`dashboard.${viewport}.loading.dom.txt`, snapshot(view.container));
      evidence[`${viewport}.loading`] = { ipc: shapes() };
      release(LOADED.get_enhanced_statistics!('get_enhanced_statistics'));
      await flush();
      view.unmount();
      cleanup();
    }
    expectGolden('dashboard.json', evidence);
  }, 60_000);

  it('keeps what each dashboard action does', async () => {
    const downloads: string[] = [];
    const realCreateObjectURL = URL.createObjectURL;
    const realRevokeObjectURL = URL.revokeObjectURL;
    const realAnchorClick = HTMLAnchorElement.prototype.click;
    const blobs = new Map<string, Blob>();
    URL.createObjectURL = (blob: Blob) => { const url = `blob:evidence/${blobs.size}`; blobs.set(url, blob); return url; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      downloads.push(`${this.download} ${blob?.type ?? this.href} ${blob?.size ?? 0}B`);
    };
    try {
      const { view, navigations } = await mountDashboard('desktop', LOADED);
      // App-wide stores some actions open instead of navigating; their hosts live outside the page.
      const [dueMistakes, fsrs] = await Promise.all([
        import('@/features/learning-today/dueMistakesReview'),
        import('@/features/flashcards/store/fsrsReviewStore'),
      ]);
      const probe = (): Record<string, unknown> => ({
        dueMistakesReviewOpen: dueMistakes.isDueMistakesReviewOpen(),
        flashcardsScreen: fsrs.useFsrsReviewStore.getState().screen,
      });

      const trace = async (click: () => void): Promise<Record<string, unknown>> => {
        const before = new Set(document.querySelectorAll('[role=dialog]'));
        const stateBefore = probe();
        navigations.length = 0;
        downloads.length = 0;
        setCtInvokeHandlers(LOADED);
        const events = await traceEvents(async () => { click(); await settleBody(); });
        const result: Record<string, unknown> = { navigations: [...navigations], events, ipc: shapes() };
        const stateAfter = probe();
        const changed = Object.keys(stateAfter).filter((key) => stateAfter[key] !== stateBefore[key]);
        if (changed.length) result.state = Object.fromEntries(changed.map((key) => [key, [stateBefore[key], stateAfter[key]]]));
        dueMistakes.closeDueMistakesReview();
        if (downloads.length) result.downloads = [...downloads];
        const dialog = Array.from(document.querySelectorAll('[role=dialog]')).find((node) => !before.has(node));
        if (dialog) result.dialog = serializeDom(dialog);
        return result;
      };
      const closeDialogs = async () => {
        for (let i = 0; i < 3 && document.querySelector('[role=dialog]'); i++) {
          fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
          await settleBody();
        }
        return !document.querySelector('[role=dialog]');
      };
      const pageButtons = () => Array.from(view.container.querySelectorAll<HTMLButtonElement>('.sota-dashboard button, [data-evidence=mobile-header] button'));
      const dialogButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button'));

      const buttons = pageButtons().map((button, index) => `${index}:${accessibleName(button)}`);
      const actions: Record<string, unknown> = {};
      for (const [index, key] of buttons.entries()) {
        const target = pageButtons()[index];
        if (!target || `${index}:${accessibleName(target)}` !== key) throw new Error(`dashboard button ${key} moved during the walk`);
        if (target.disabled) { actions[key] = { disabled: true }; continue; }
        const result = await trace(() => fireEvent.click(target));
        if (result.dialog) {
          // One level down: every button of the dialog the action opened, each from a fresh open.
          const inner = dialogButtons().map((button, i) => `${i}:${accessibleName(button)}`);
          const innerActions: Record<string, unknown> = {};
          for (const [i, innerKey] of inner.entries()) {
            if (!document.querySelector('[role=dialog]')) {
              await trace(() => fireEvent.click(pageButtons()[index]!));
            }
            const button = dialogButtons()[i];
            if (!button || `${i}:${accessibleName(button)}` !== innerKey) throw new Error(`dialog button ${innerKey} moved`);
            innerActions[innerKey] = button.disabled ? { disabled: true } : await trace(() => fireEvent.click(button));
            await closeDialogs();
          }
          result.dialogActions = innerActions;
          result.dialogClosesOnEscape = await (async () => {
            await trace(() => fireEvent.click(pageButtons()[index]!));
            return closeDialogs();
          })();
        }
        actions[key] = result;
      }
      expect(buttons.length).toBeGreaterThan(0);
      expectGolden('dashboard.actions.json', { buttons, actions });
      view.unmount();
    } finally {
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
      HTMLAnchorElement.prototype.click = realAnchorClick;
    }
  }, 120_000);
});

function accessibleName(element: HTMLElement): string {
  return (element.getAttribute('aria-label') || element.textContent || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
}

/** Until the whole document (portals included) has stopped changing for a few rounds. */
async function settleBody() {
  const deadline = Date.now() + 10_000;
  let previous = '';
  for (let stable = 0; stable < 3 && Date.now() < deadline;) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const current = serializeDom(document.body);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
}
