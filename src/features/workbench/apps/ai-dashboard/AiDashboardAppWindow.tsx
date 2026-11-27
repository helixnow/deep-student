/**
 * AI 学习仪表盘应用窗口（Generative UI Round 13）
 *
 * 桌面 `DesktopAiBriefingWidget` 的全屏版：同一数据源（闪卡到期 / 待办 / 制卡任务），
 * 另加错题复习与笔记复习（todayLearningStore，与首页「今日学习」同口径），
 * 经 `buildAiDashboardIntent` 渲染结构化简报，ActionBar 走 workbenchLearningHandlers。
 *
 * 性能与口径治理（S4-11）：
 * - 首帧立即渲染标题、区间切换与三张核心 KPI 指标卡（0ms 白屏），
 *   重型 `GenerativeUIPanel`（含 Recharts / 18 个 GenUI 块）改为 `React.lazy` + rAF + `startTransition` 渐进挂载，
 *   彻底避免开窗瞬间的同步 4.9s 主线程冻结与 `todoAgendaSource` 冷启动二次挂载抖动；
 * - 学习时长口径统一通过 `reconcileStudyWindow` 聚合在场计时（含当日实时未刷盘秒数）、
 *   番茄专注时长与 FSRS 复习时长（ms → s 换算），单日取保守最大值防双算；
 *   当区间内仅有非计时学习活动且累计计时 < 1 分钟时，honest 切换展示「学习活跃度 · N 次活动」，
 *   彻底消除「学习时长 不到 1 分钟」与「活跃 2 天」在同一张卡片内自相矛盾。
 */
import React, {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ChartBar } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/SegmentedControl';
import { formatStudyDuration } from '@/components/LearningHeatmap/formatStudyDuration';
import {
  reconcileStudyWindow,
  type FsrsDailyReviewEntry,
  type PomodoroDailyEntry,
} from '@/components/LearningHeatmap/studyTimeReconciliation';
import { formatLocalDateYmd, useLearningHeatmap } from '@/hooks/useLearningHeatmap';
import { LlmUsageApi, type UsageSummary } from '@/api/llmUsageApi';
import { getTodoStatsOverview, type TodoStatsOverview } from '@/features/todo/api';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { workbenchBus } from '../../core/workbenchBus';
import { buildAiDashboardIntent } from '@/features/generative-ui/utils/buildAiDashboardIntent';
import { createWorkbenchLearningHandlers } from '@/features/generative-ui/handlers/workbenchLearningHandlers';
import {
  getFlashcardsDueCount,
  subscribeFlashcardsDueCount,
} from '../system/flashcardsDueSource';
import {
  getTodoAgendaSnapshot,
  subscribeTodoAgenda,
} from '../system/todoAgendaSource';
import {
  getActiveAnkiTaskCount,
  subscribeAnkiTaskCount,
} from '../system/ankiTaskSource';
import {
  getTodayLearningSnapshot,
  subscribeTodayLearning,
} from '@/features/learning-today/todayLearningStore';
import { formatLocalDateKey } from '../../components/DesktopAgendaWidget';
import type { AppWindowProps } from '../../core/types';
import { useWbSysSize } from '../system/useWbSysSize';
import { WbSysFade, WbSysSkeleton } from '../system/SystemWindowShared';
import './AiDashboardAppWindow.css';

const LazyGenerativeUIPanel = lazy(() =>
  import('@/features/generative-ui/components/GenerativeUIPanel').then((m) => ({
    default: m.GenerativeUIPanel,
  })),
);

type InsightRangeDays = '1' | '7' | '30';

interface PomodoroOverviewReply {
  daily?: PomodoroDailyEntry[];
}

interface FsrsReviewStatsReply {
  dailyReviews?: FsrsDailyReviewEntry[];
}

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

const AiDashboardAppWindow: React.FC<AppWindowProps> = ({ onTitleChange }) => {
  const { t } = useTranslation(['workbench', 'generativeUi', 'stats']);
  const { ref } = useWbSysSize();
  const [rangeDays, setRangeDays] = useState<InsightRangeDays>('7');
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [todoStats, setTodoStats] = useState<TodoStatsOverview | null>(null);
  const [pomodoroDaily, setPomodoroDaily] = useState<PomodoroDailyEntry[] | null>(null);
  const [fsrsDailyReviews, setFsrsDailyReviews] = useState<FsrsDailyReviewEntry[] | null>(null);
  const [panelReady, setPanelReady] = useState(false);
  const hasMountedPanelRef = useRef(false);

  const dueCount = useSyncExternalStore(subscribeFlashcardsDueCount, getFlashcardsDueCount, () => 0);
  const agenda = useSyncExternalStore(subscribeTodoAgenda, getTodoAgendaSnapshot, getTodoAgendaSnapshot);
  const activeTasks = useSyncExternalStore(subscribeAnkiTaskCount, getActiveAnkiTaskCount, () => 0);
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  // 取近 2 个月，避免 2 月（28/29 天）或大小月切换时 30 天统计区间被截断
  const heatmap = useLearningHeatmap(2);

  const numericDays = Number(rangeDays);
  const ready = !agenda.isLoading;

  // 延迟一帧在 transition 中挂载重型 GenerativeUIPanel（含 Recharts / 18 个 GenUI 块），
  // 让标题与核心 KPI 卡在 0ms 首帧立即呈现，同时避免 todoAgendaSource 冷启动双次挂载抖动。
  useEffect(() => {
    if (!ready) return;
    if (hasMountedPanelRef.current) return;
    const markReady = () => {
      hasMountedPanelRef.current = true;
      startTransition(() => {
        setPanelReady(true);
      });
    };
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      markReady();
      return;
    }
    const rafId = window.requestAnimationFrame(markReady);
    return () => window.cancelAnimationFrame(rafId);
  }, [ready]);

  useEffect(() => {
    let cancelled = false;
    const endDate = new Date();
    const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - (numericDays - 1));
    const endKey = formatLocalDateYmd(endDate);
    const startKey = formatLocalDateYmd(startDate);

    void Promise.all([
      LlmUsageApi.getSummary(startKey, endKey).catch(() => null),
      getTodoStatsOverview(numericDays).catch(() => null),
      invoke<PomodoroOverviewReply>('pomodoro_stats_overview', { days: numericDays }).catch(() => null),
      invoke<FsrsReviewStatsReply>('fsrs_get_review_statistics', { days: numericDays }).catch(() => null),
    ]).then(([usage, todoOverview, pomodoroOverview, fsrsOverview]) => {
      if (cancelled) return;
      startTransition(() => {
        setUsageSummary(usage);
        setTodoStats(todoOverview);
        setPomodoroDaily(Array.isArray(pomodoroOverview?.daily) ? pomodoroOverview.daily : null);
        setFsrsDailyReviews(
          Array.isArray(fsrsOverview?.dailyReviews) ? fsrsOverview.dailyReviews : null,
        );
      });
    });

    return () => {
      cancelled = true;
    };
  }, [numericDays]);

  const { pendingTodos, overdueTodos } = useMemo(() => {
    const todayKey = formatLocalDateKey(new Date());
    let overdue = 0;
    for (const item of agenda.items) {
      if (item.dueDate && item.dueDate < todayKey) overdue += 1;
    }
    return { pendingTodos: agenda.items.length, overdueTodos: overdue };
  }, [agenda.items]);

  const shouldRenderBriefing = ready && panelReady;

  const intent = useMemo(() => {
    if (!shouldRenderBriefing) return null;
    return buildAiDashboardIntent(
      {
        dueFlashcards: dueCount,
        pendingTodos,
        overdueTodos,
        activeAnkiTasks: activeTasks,
        dueMistakes: today.mistakes,
        dueNotes: today.notes,
        reviewDays:
          dueCount > 0
            ? [{ date: formatLocalDateKey(new Date()), dueCount: dueCount }]
            : undefined,
      },
      {
        dueFlashcardsTitle: t('generativeUi:workbench.briefing.due_flashcards_title'),
        dueTrendDue: t('generativeUi:workbench.briefing.due_trend_due'),
        dueTrendNone: t('generativeUi:workbench.briefing.due_trend_none'),
        progressTitle: t('generativeUi:workbench.briefing.progress_title'),
        todosTitle: t('generativeUi:workbench.briefing.todos_title'),
        noOverdueLabel: t('generativeUi:workbench.briefing.no_overdue'),
        overdueLabel: t('generativeUi:workbench.briefing.overdue_label'),
        pendingLabel: t('generativeUi:workbench.briefing.pending_label'),
        startReview: t('generativeUi:workbench.briefing.start_review'),
        openQbank: t('generativeUi:workbench.briefing.open_qbank'),
        ankiTasksTitle: t('generativeUi:workbench.dashboard.anki_tasks_title'),
        ankiTasksTrendActive: t('generativeUi:workbench.dashboard.anki_tasks_trend_active'),
        ankiTasksTrendIdle: t('generativeUi:workbench.dashboard.anki_tasks_trend_idle'),
        openTaskDashboard: t('generativeUi:workbench.dashboard.open_task_dashboard'),
        reviewCalendarTitle: t('generativeUi:workbench.dashboard.review_calendar_title'),
        reviewEmptyTitle: t('generativeUi:workbench.dashboard.review_empty_title'),
        reviewEmpty: t('generativeUi:workbench.dashboard.review_empty'),
        idleAlertTitle: t('generativeUi:workbench.dashboard.idle_alert_title'),
        idleAlertDescription: t('generativeUi:workbench.dashboard.idle_alert_description'),
        workloadChartTitle: t('generativeUi:workbench.dashboard.workload_chart_title'),
        chartPending: t('generativeUi:workbench.dashboard.chart_pending'),
        chartOverdue: t('generativeUi:workbench.dashboard.chart_overdue'),
        workloadChartSeries: t('generativeUi:workbench.dashboard.workload_chart_series'),
        dueMistakesTitle: t('generativeUi:workbench.dashboard.due_mistakes_title'),
        dueNotesTitle: t('generativeUi:workbench.dashboard.due_notes_title'),
        reviewNotes: t('generativeUi:workbench.dashboard.review_notes'),
        reviewMistakes: t('generativeUi:workbench.dashboard.review_mistakes'),
      },
    );
  }, [shouldRenderBriefing, activeTasks, dueCount, overdueTodos, pendingTodos, today.mistakes, today.notes, t]);

  const actionHandlers = useMemo(
    () =>
      createWorkbenchLearningHandlers({
        startReview: t('generativeUi:workbench.briefing.start_review'),
        openQbank: t('generativeUi:workbench.briefing.open_qbank'),
        exportPlan: t('generativeUi:research.actions.export_plan'),
        openTaskDashboard: t('generativeUi:workbench.dashboard.open_task_dashboard'),
        reviewNotes: t('generativeUi:workbench.dashboard.review_notes'),
        reviewMistakes: t('generativeUi:workbench.dashboard.review_mistakes'),
      }),
    [t],
  );

  useEffect(() => {
    onTitleChange(t('workbench:apps.aiDashboard'));
  }, [onTitleChange, t]);

  const handleOpenFullStats = useCallback(() => {
    setPendingSettingsRoute({ tab: 'statistics' });
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'statistics' });
    workbenchBus.launch({ typeId: 'settings', reason: 'api' });
  }, []);

  const rangeOptions = useMemo<Array<SegmentedControlOption<InsightRangeDays>>>(
    () => [
      { value: '1', label: t('generativeUi:workbench.dashboard.range_today') },
      { value: '7', label: t('generativeUi:workbench.dashboard.range_7d') },
      { value: '30', label: t('generativeUi:workbench.dashboard.range_30d') },
    ],
    [t],
  );

  const activeRangeLabel = useMemo(
    () => rangeOptions.find((option) => option.value === rangeDays)?.label ?? rangeDays,
    [rangeDays, rangeOptions],
  );

  const studyInsights = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (numericDays - 1));
    const startKey = formatLocalDateYmd(start);
    const endKey = formatLocalDateYmd(now);

    const reconciled = reconcileStudyWindow({
      startKey,
      endKey,
      maxDays: numericDays,
      heatmapData: heatmap.data ?? [],
      pomodoroDaily,
      fsrsDailyReviews,
    });

    const tStats = ((key: string, opts?: Record<string, unknown>) =>
      t(`stats:${key}`, opts as never)) as Parameters<typeof formatStudyDuration>[1];

    const activeDaysText = t('generativeUi:workbench.dashboard.study_time_days', {
      days: reconciled.activeDays,
    });

    if (reconciled.displayMode === 'activity') {
      const roundedSecs = Math.round(reconciled.studySeconds);
      const timingSuffix =
        roundedSecs > 0
          ? `${t('stats:heatmap.duration.label')} ${roundedSecs}s`
          : t('stats:heatmap.duration.noRecord');
      return {
        ...reconciled,
        cardLabel: t('stats:heatmapChart.title'),
        primaryValue: t('stats:heatmap.tooltip.activitiesCount', {
          count: reconciled.totalActivities,
        }),
        subValue: `${activeDaysText} · ${timingSuffix}`,
      };
    }

    if (reconciled.displayMode === 'seconds') {
      return {
        ...reconciled,
        cardLabel: t('generativeUi:workbench.dashboard.study_time_label'),
        primaryValue: `${Math.round(reconciled.studySeconds)}s`,
        subValue: activeDaysText,
      };
    }

    return {
      ...reconciled,
      cardLabel: t('generativeUi:workbench.dashboard.study_time_label'),
      primaryValue: formatStudyDuration(reconciled.studySeconds, tStats),
      subValue: activeDaysText,
    };
  }, [heatmap.data, numericDays, pomodoroDaily, fsrsDailyReviews, t]);

  const todoCompletion = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (numericDays - 1));
    const startKey = formatLocalDateYmd(start);
    const endKey = formatLocalDateYmd(now);
    const trend = todoStats?.completionTrend ?? [];
    const windowedCompleted = trend
      .filter((entry) => entry.date >= startKey && entry.date <= endKey)
      .reduce((sum, entry) => sum + (entry.completedCount ?? 0), 0);
    const completed =
      numericDays === 1
        ? (todoStats?.completedToday ?? windowedCompleted)
        : trend.length > 0
          ? windowedCompleted
          : (todoStats?.totalCompleted ?? 0);
    const pending = todoStats?.totalPending ?? agenda.items.length;
    const total = completed + pending;
    const rate = total > 0 ? `${Math.round((completed / total) * 100)}%` : '0%';
    return { completed, total, rate };
  }, [agenda.items.length, numericDays, todoStats]);

  return (
    <div
      ref={ref}
      className="wb-ai-dashboard"
      data-wb-sys-app="aiDashboard"
      data-testid="wb-ai-dashboard-window"
    >
      <header className="wb-ai-dashboard-header flex-wrap">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SegmentedControl<InsightRangeDays>
            ariaLabel={t('generativeUi:workbench.dashboard.range_label')}
            value={rangeDays}
            onValueChange={setRangeDays}
            options={rangeOptions}
            size="compact"
          />
          <span
            className="text-2xs font-normal text-muted-foreground"
            data-testid="wb-ai-dashboard-range-caption"
          >
            {t('generativeUi:workbench.dashboard.range_caption', {
              label: activeRangeLabel,
            })}
          </span>
        </div>
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          data-testid="wb-ai-dashboard-stats-button"
          onClick={handleOpenFullStats}
          className="shrink-0 gap-1.5 text-xs"
        >
          <ChartBar className="h-3.5 w-3.5" aria-hidden />
          {t('generativeUi:workbench.dashboard.open_full_stats')}
        </DsButton>
      </header>
      <div className="wb-ai-dashboard-body">
        <WbSysFade className="wb-ai-dashboard-content">
          <div
            className="wb-ai-dashboard-insights"
            data-testid="wb-ai-dashboard-insights"
            data-range={rangeDays}
          >
            <div
              className="wb-ai-dashboard-insight-card"
              data-testid="wb-ai-dashboard-study-card"
              data-study-mode={studyInsights.displayMode}
            >
              <div className="wb-ai-dashboard-insight-meta">
                <span className="wb-ai-dashboard-insight-label">
                  {studyInsights.cardLabel}
                </span>
                <span className="wb-ai-dashboard-insight-sub">
                  {studyInsights.subValue}
                </span>
              </div>
              <span className="wb-ai-dashboard-insight-value">
                {studyInsights.primaryValue}
              </span>
            </div>

            <div className="wb-ai-dashboard-insight-card">
              <div className="wb-ai-dashboard-insight-meta">
                <span className="wb-ai-dashboard-insight-label">
                  {t('generativeUi:workbench.dashboard.todo_completion_label')}
                </span>
                <span className="wb-ai-dashboard-insight-sub">
                  {t('generativeUi:workbench.dashboard.todo_completion_sub', {
                    completed: todoCompletion.completed,
                    total: todoCompletion.total,
                  })}
                </span>
              </div>
              <span className="wb-ai-dashboard-insight-value">
                {todoCompletion.rate}
              </span>
            </div>

            <div className="wb-ai-dashboard-insight-card">
              <div className="wb-ai-dashboard-insight-meta">
                <span className="wb-ai-dashboard-insight-label">
                  {t('generativeUi:workbench.dashboard.ai_usage_label')}
                </span>
                <span className="wb-ai-dashboard-insight-sub">
                  {t('generativeUi:workbench.dashboard.ai_usage_sub', {
                    requests: usageSummary?.totalRequests ?? 0,
                    tokens: formatCompactTokens(usageSummary?.totalTokens ?? 0),
                  })}
                </span>
              </div>
              <span className="wb-ai-dashboard-insight-value">
                {formatCompactTokens(usageSummary?.totalTokens ?? 0)}
              </span>
            </div>
          </div>

          {shouldRenderBriefing && intent ? (
            <Suspense fallback={<WbSysSkeleton variant="dashboard" />}>
              <LazyGenerativeUIPanel
                intent={intent}
                showChrome={false}
                actionHandlers={actionHandlers}
              />
            </Suspense>
          ) : (
            <div data-testid="wb-ai-dashboard-panel-skeleton">
              <WbSysSkeleton variant="dashboard" />
            </div>
          )}
        </WbSysFade>
      </div>
    </div>
  );
};

export default AiDashboardAppWindow;
