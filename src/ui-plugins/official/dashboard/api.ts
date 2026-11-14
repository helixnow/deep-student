/**
 * The dashboard's contribution points (FE-B8), all declared by `dstu.ui.dashboard`:
 * - `dashboard.widgets`: the "today" section: header links, the card row and the strips below it;
 * - `dashboard.stats`: the statistics cards of the overview grid;
 * - `dashboard.charts`: the chart cards below the grid.
 *
 * Official cards live with the dashboard chunk and announce themselves on the contribution point of the plugin that
 * owns them (`dstu.ui.dashboard` for todo / jobs, the weak concepts and the statistics, `dstu.ui.learning-today` for
 * the three review lines and the weekly report); the plugin mirrors every announcement into the slot. Nothing in this
 * module imports a card.
 */
import { useSyncExternalStore, type ComponentType } from 'react';
import type { SlotEntry, UiPlatformKind, UiPlugin } from '@/ui-sdk';
import { createLazyContributionPoint, type LazyContributionPoint } from '@/ui-sdk/lazy';

export type DashboardView = 'learning-hub' | 'todo' | 'task-dashboard' | 'flashcards';

/** Counts loaded once per refresh by the dashboard for every card (failures read as 0). */
export interface TodayCounts {
  cardsDue: number;
  mistakesDue: number;
  notesDue: number;
  todoDue: number;
  activeJobs: number;
}

export interface DashboardWidgetProps {
  today: TodayCounts;
  onNavigate?: (view: DashboardView) => void;
}

export interface DashboardWidget {
  /**
   * Where the widget goes in the "today" section: `header` next to the section title (small links), `row` (the
   * default) the card row, `below` full width under the row.
   */
  placement?: 'header' | 'row' | 'below';
  /** `sm`: the component is itself an item (an action card, a header link); `md` / `lg`: half / full row frame. */
  size: 'sm' | 'md' | 'lg';
  /** Frame title for `md` / `lg`, in the contributing plugin's i18n namespace. */
  titleKey?: string;
  /** Shown everywhere when omitted. */
  platforms?: readonly UiPlatformKind[];
  component: ComponentType<DashboardWidgetProps>;
}

/** `get_enhanced_statistics` as the overview reads it; the payload is untyped upstream, so every field is optional. */
export interface DashboardStatistics {
  basic_stats?: { total_mistakes?: number; tag_stats?: Record<string, unknown> };
  recent_growth?: number;
  recent_additions?: number;
  quality_score?: number;
  image_stats?: { total_files?: number; total_size_bytes?: number };
  [field: string]: unknown;
}

export interface DashboardStatProps {
  /** The statistics loaded by the overview (refreshed every minute while it is visible). */
  statistics: DashboardStatistics | undefined;
}

export interface DashboardStat {
  /** Shown everywhere when omitted. */
  platforms?: readonly UiPlatformKind[];
  /** One grid cell. */
  component: ComponentType<DashboardStatProps>;
}

export interface DashboardChartProps {
  /** The statistics loaded by the overview; the chart area is only rendered once they have loaded. */
  statistics: DashboardStatistics;
}

export interface DashboardChart {
  /** Shown everywhere when omitted. */
  platforms?: readonly UiPlatformKind[];
  /**
   * Whether the chart has anything to plot; a chart without data is left out. When no chart shown on this platform
   * has data, the overview shows a single "no chart data yet" card instead. Omitted: always has data.
   */
  hasData?: (statistics: DashboardStatistics) => boolean;
  /** One chart card. */
  component: ComponentType<DashboardChartProps>;
}

declare module '@/ui-kernel/slot-map' {
  interface SlotMap {
    'dashboard.widgets': DashboardWidget;
    'dashboard.stats': DashboardStat;
    'dashboard.charts': DashboardChart;
  }
}

export interface DashboardAnnouncement<T> {
  id: string;
  order: number;
  value: T;
}

export type DashboardWidgetAnnouncement = DashboardAnnouncement<DashboardWidget>;
export type DashboardStatAnnouncement = DashboardAnnouncement<DashboardStat>;
export type DashboardChartAnnouncement = DashboardAnnouncement<DashboardChart>;

/** Without a UI kernel (lightweight windows, bare tests) the dashboard renders the announcements of a slot directly. */
function unattachedList<T>(slot: string) {
  let entries: readonly SlotEntry<T>[] = [];
  const listeners = new Set<() => void>();
  const update = (next: readonly SlotEntry<T>[]) => {
    entries = next;
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const get = () => entries;
  return {
    point(owner: string): LazyContributionPoint<DashboardAnnouncement<T>> {
      return createLazyContributionPoint<DashboardAnnouncement<T>>(`${slot} (${owner})`, ({ id, order, value }) => {
        const entry: SlotEntry<T> = { id, order, value, owner, origin: 'builtin' };
        update([...entries, entry].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
        return () => update(entries.filter((candidate) => candidate !== entry));
      });
    },
    use(): readonly SlotEntry<T>[] {
      return useSyncExternalStore(subscribe, get, get);
    },
  };
}

const widgets = unattachedList<DashboardWidget>('dashboard.widgets');
const stats = unattachedList<DashboardStat>('dashboard.stats');
const charts = unattachedList<DashboardChart>('dashboard.charts');

export function useUnattachedDashboardWidgets(): readonly SlotEntry<DashboardWidget>[] {
  return widgets.use();
}

export function useUnattachedDashboardStats(): readonly SlotEntry<DashboardStat>[] {
  return stats.use();
}

export function useUnattachedDashboardCharts(): readonly SlotEntry<DashboardChart>[] {
  return charts.use();
}

export const dashboardCoreWidgets = widgets.point('dstu.ui.dashboard');
export const learningTodayWidgets = widgets.point('dstu.ui.learning-today');
export const dashboardCoreStats = stats.point('dstu.ui.dashboard');
export const dashboardCoreCharts = charts.point('dstu.ui.dashboard');

type PluginContext = Parameters<UiPlugin['apply']>[0];

/** For the owning plugin's `apply`. */
export function contributeAnnouncedWidgets(ctx: PluginContext, point: LazyContributionPoint<DashboardWidgetAnnouncement>): void {
  ctx.effect(() => point.attach(({ id, order, value }) => {
    ctx.ui.contribute('dashboard.widgets', { id, order, value });
  }), 'dashboard.widgets');
}

/** For the owning plugin's `apply`. */
export function contributeAnnouncedStats(ctx: PluginContext, point: LazyContributionPoint<DashboardStatAnnouncement>): void {
  ctx.effect(() => point.attach(({ id, order, value }) => {
    ctx.ui.contribute('dashboard.stats', { id, order, value });
  }), 'dashboard.stats');
}

/** For the owning plugin's `apply`. */
export function contributeAnnouncedCharts(ctx: PluginContext, point: LazyContributionPoint<DashboardChartAnnouncement>): void {
  ctx.effect(() => point.attach(({ id, order, value }) => {
    ctx.ui.contribute('dashboard.charts', { id, order, value });
  }), 'dashboard.charts');
}
