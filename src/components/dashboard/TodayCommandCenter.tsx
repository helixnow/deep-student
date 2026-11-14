/**
 * ★ 5.1 首页「今日指挥中心」行动区
 *
 * 仪表盘从纯回顾性统计升级为可行动入口：
 * - 今日到期复习 n（直达学习资源）
 * - 今日待办 m（直达待办页）
 * - 运行中制卡任务 k（直达任务页）
 *
 * 数据加载失败时静默降级（显示 0 / 不显示徽标），不阻塞统计区渲染。
 * 标题旁的入口（周报）、卡片行、行下方的条（薄弱知识点）都来自 `dashboard.widgets` 槽位，按 placement 分区；
 * 计数在这里统一加载后传给每个小部件。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { loadTodayLearning } from '@/features/learning-today/todayLearning';
import '@/features/learning-today/dashboardWidgets';
import { SlotOutlet } from '@/ui-kernel/outlet';
import { useOptionalUiKernel, useT } from '@/ui-kernel/react';
import type { SlotEntry } from '@/ui-kernel/slots';
import './coreWidgets';
import { useUnattachedDashboardWidgets, type DashboardView, type DashboardWidget, type TodayCounts } from '@/ui-plugins/official/dashboard/api';

interface TodayCommandCenterProps {
  onNavigate?: (view: DashboardView) => void;
}

const REFRESH_INTERVAL_MS = 60_000;

async function loadCounts(): Promise<TodayCounts> {
  // 三条复习线统一口径（卡片 / 错题 / 笔记），见 learning-today/todayLearning
  const [learning, todoDue, activeJobs] = await Promise.all([
    loadTodayLearning().catch(() => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] })),
    import('@/features/todo/api')
      .then((m) => m.listTodayItems(false))
      .then((items) => items.length)
      .catch(() => 0),
    invoke<Array<{ activeTasks?: number }>>('list_document_sessions', { limit: 100 })
      .then((sessions) => sessions.filter((s) => (s.activeTasks ?? 0) > 0).length)
      .catch(() => 0),
  ]);
  return { cardsDue: learning.cards, mistakesDue: learning.mistakes, notesDue: learning.notes, todoDue, activeJobs };
}

const FRAME_CLASS = {
  md: 'flex min-w-[280px] flex-[2_1_360px] flex-col gap-2',
  lg: 'flex basis-full flex-col gap-2',
} as const;

const WidgetTitle: React.FC<{ titleKey: string }> = ({ titleKey }) => {
  const t = useT();
  return <h3 className="text-ui font-medium text-muted-foreground">{t(titleKey)}</h3>;
};

/** `md` / `lg` widgets get a row frame (and their title when a kernel scope can translate it). */
function renderWidget(entry: SlotEntry<DashboardWidget>, props: React.ComponentProps<DashboardWidget['component']>, titled: boolean) {
  const { size, titleKey, component: Widget } = entry.value;
  if (size === 'sm') return <Widget {...props} />;
  return (
    <section className={FRAME_CLASS[size]} data-ds-widget={entry.id}>
      {titled && titleKey && <WidgetTitle titleKey={titleKey} />}
      <Widget {...props} />
    </section>
  );
}

export const TodayCommandCenter: React.FC<TodayCommandCenterProps> = ({ onNavigate }) => {
  const { t } = useTranslation('data');
  const [counts, setCounts] = useState<TodayCounts | null>(null);
  const kernel = useOptionalUiKernel();
  const platform = kernel?.platform.kind;
  const unattached = useUnattachedDashboardWidgets();

  const refresh = useCallback(() => {
    loadCounts().then(setCounts).catch(() => setCounts({ cardsDue: 0, mistakesDue: 0, notesDue: 0, todoDue: 0, activeJobs: 0 }));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  if (!counts) return null;

  const nothingToDo = counts.cardsDue === 0 && counts.mistakesDue === 0 && counts.notesDue === 0
    && counts.todoDue === 0 && counts.activeJobs === 0;

  const widgets = (placement: NonNullable<DashboardWidget['placement']>) => (
    <SlotOutlet
      name="dashboard.widgets"
      entries={unattached}
      filter={(entry) => (entry.value.placement ?? 'row') === placement
        && (!platform || !entry.value.platforms || entry.value.platforms.includes(platform))}
      render={(entry) => renderWidget(entry, { today: counts, onNavigate }, !!kernel)}
    />
  );

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t('today_center.title')}</h2>
        {nothingToDo && (
          <span className="text-[12px] text-muted-foreground/60">{t('today_center.all_clear')}</span>
        )}
        {widgets('header')}
      </div>
      <div className="flex flex-wrap gap-3">{widgets('row')}</div>
      {widgets('below')}
    </div>
  );
};
