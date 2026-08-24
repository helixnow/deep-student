/**
 * AI 学习仪表盘应用窗口（Generative UI Round 13）
 *
 * 桌面 `DesktopAiBriefingWidget` 的全屏版：同一数据源（闪卡到期 / 待办 / 制卡任务），
 * 经 `buildAiDashboardIntent` 渲染结构化简报，ActionBar 走 workbenchLearningHandlers。
 */
import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
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
import { formatLocalDateKey } from '../../components/DesktopAgendaWidget';
import type { AppWindowProps } from '../../core/types';
import { useWbSysSize } from '../system/useWbSysSize';
import { WbSysFade, WbSysSkeleton } from '../system/SystemWindowShared';
import './AiDashboardAppWindow.css';

const AiDashboardAppWindow: React.FC<AppWindowProps> = ({ onTitleChange }) => {
  const { t } = useTranslation(['workbench', 'generativeUi']);
  const { ref } = useWbSysSize();
  const dueCount = useSyncExternalStore(subscribeFlashcardsDueCount, getFlashcardsDueCount, () => 0);
  const agenda = useSyncExternalStore(subscribeTodoAgenda, getTodoAgendaSnapshot, getTodoAgendaSnapshot);
  const activeTasks = useSyncExternalStore(subscribeAnkiTaskCount, getActiveAnkiTaskCount, () => 0);

  const { pendingTodos, overdueTodos } = useMemo(() => {
    const todayKey = formatLocalDateKey(new Date());
    let overdue = 0;
    for (const item of agenda.items) {
      if (item.dueDate && item.dueDate < todayKey) overdue += 1;
    }
    return { pendingTodos: agenda.items.length, overdueTodos: overdue };
  }, [agenda.items]);

  const intent = useMemo(
    () =>
      buildAiDashboardIntent(
        {
          dueFlashcards: dueCount,
          pendingTodos,
          overdueTodos,
          activeAnkiTasks: activeTasks,
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
        },
      ),
    [activeTasks, dueCount, overdueTodos, pendingTodos, t],
  );

  const actionHandlers = useMemo(
    () =>
      createWorkbenchLearningHandlers({
        startReview: t('generativeUi:workbench.briefing.start_review'),
        openQbank: t('generativeUi:workbench.briefing.open_qbank'),
        exportPlan: t('generativeUi:research.actions.export_plan'),
        openTaskDashboard: t('generativeUi:workbench.dashboard.open_task_dashboard'),
      }),
    [t],
  );

  useEffect(() => {
    onTitleChange(t('workbench:apps.aiDashboard'));
  }, [onTitleChange, t]);

  const ready = !agenda.isLoading;

  return (
    <div
      ref={ref}
      className="wb-ai-dashboard"
      data-wb-sys-app="aiDashboard"
      data-testid="wb-ai-dashboard-window"
    >
      <header className="wb-ai-dashboard-header">
        <Sparkle className="h-5 w-5 text-primary" weight="fill" aria-hidden />
        {t('generativeUi:workbench.dashboard.title', {
          defaultValue: t('generativeUi:workbench.briefing_label'),
        })}
      </header>
      <div className="wb-ai-dashboard-body">
        {ready ? (
          <WbSysFade>
            <GenerativeUIPanel
              intent={intent}
              showChrome
              actionHandlers={actionHandlers}
            />
          </WbSysFade>
        ) : (
          <WbSysSkeleton variant="dashboard" />
        )}
      </div>
    </div>
  );
};

export default AiDashboardAppWindow;
