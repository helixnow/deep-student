import type { GenerativeUIIntent } from '../types';
import type { ActionBarProps } from '../schema';
import { buildChartIntent } from './buildChartIntent';
import {
  buildLearningBriefingIntent,
  type LearningBriefingInput,
  type LearningBriefingLabels,
} from './buildLearningBriefingIntent';

export interface AiDashboardReviewDay {
  date: string;
  dueCount: number;
  label?: string;
  completedCount?: number;
}

export interface AiDashboardInput extends LearningBriefingInput {
  activeAnkiTasks?: number;
  /** SM-2 错题复习到期（今日 + 逾期），与首页「今日学习」同口径 */
  dueMistakes?: number;
  /** 复习日期已到的笔记 */
  dueNotes?: number;
  reviewDays?: AiDashboardReviewDay[];
}

export interface AiDashboardLabels extends LearningBriefingLabels {
  ankiTasksTitle: string;
  ankiTasksTrendActive: string;
  openTaskDashboard: string;
  ankiTasksTrendIdle?: string;
  reviewCalendarTitle?: string;
  reviewEmptyTitle?: string;
  reviewEmpty?: string;
  idleAlertTitle?: string;
  idleAlertDescription?: string;
  workloadChartTitle?: string;
  chartPending?: string;
  chartOverdue?: string;
  workloadChartSeries?: string;
  /** 提供后才显示对应卡片（旧调用方不受影响） */
  dueMistakesTitle?: string;
  dueNotesTitle?: string;
  reviewNotes?: string;
}

/** Workbench AI 仪表盘：学习简报 + 制卡任务 stat-card + 复习日历/空态 */
export function buildAiDashboardIntent(
  input: AiDashboardInput,
  labels: AiDashboardLabels,
): GenerativeUIIntent {
  const { activeAnkiTasks = 0, dueMistakes = 0, dueNotes = 0, reviewDays, ...briefingInput } = input;
  const briefing = buildLearningBriefingIntent(briefingInput, labels);
  const blocks = [...briefing.blocks];
  const dueFlashcards = briefingInput.dueFlashcards ?? 0;
  const pendingTodos = briefingInput.pendingTodos ?? 0;
  const overdueTodos = briefingInput.overdueTodos ?? 0;
  const reviewLines = [
    { title: labels.dueFlashcardsTitle, count: dueFlashcards },
    ...(labels.dueMistakesTitle ? [{ title: labels.dueMistakesTitle, count: dueMistakes }] : []),
    ...(labels.dueNotesTitle ? [{ title: labels.dueNotesTitle, count: dueNotes }] : []),
  ];
  const totalReviewDue = reviewLines.reduce((sum, line) => sum + line.count, 0);
  const isIdle = totalReviewDue === 0 && pendingTodos === 0 && overdueTodos === 0 && activeAnkiTasks === 0;
  const calendarDays = (reviewDays ?? [])
    .filter((day) => day.date.trim().length > 0 && day.dueCount >= 0)
    .slice(0, 14);

  // 错题 / 笔记复习卡紧跟闪卡卡：三条复习线并排，与首页「今日学习」一致
  const firstStatIdx = blocks.findIndex((block) => block.type === 'stat-card');
  blocks.splice(
    firstStatIdx >= 0 ? firstStatIdx + 1 : 0,
    0,
    ...reviewLines.slice(1).map((line) => ({
      type: 'stat-card' as const,
      props: {
        title: line.title,
        value: line.count,
        trend: line.count > 0 ? ('up' as const) : ('neutral' as const),
        trendLabel: line.count > 0 ? labels.dueTrendDue : labels.dueTrendNone,
      },
    })),
  );

  const progressIdx = blocks.findIndex((block) => block.type === 'progress');
  const insertAt = progressIdx >= 0 ? progressIdx : blocks.length;
  blocks.splice(insertAt, 0, {
    type: 'stat-card',
    props: {
      title: labels.ankiTasksTitle,
      value: activeAnkiTasks,
      trend: activeAnkiTasks > 0 ? 'up' : 'neutral',
      trendLabel: activeAnkiTasks > 0 ? labels.ankiTasksTrendActive : (labels.ankiTasksTrendIdle ?? labels.dueTrendNone),
    },
  });

  const actionBarIdx = blocks.findIndex((block) => block.type === 'action-bar');
  const extraBlocks: typeof blocks = [];

  const categoryFromCountLabel = (template: string, fallback: string) => {
    const stripped = template.replace(/\{\{count\}\}/g, '').replace(/\s+/g, ' ').trim();
    return stripped || fallback;
  };

  extraBlocks.push(
    ...buildChartIntent({
      title: labels.workloadChartTitle ?? labels.progressTitle,
      kind: 'bar',
      categories: [
        ...reviewLines.map((line) => line.title),
        labels.chartPending ?? categoryFromCountLabel(labels.pendingLabel, labels.progressTitle),
        labels.chartOverdue ?? categoryFromCountLabel(labels.overdueLabel, labels.progressTitle),
        labels.ankiTasksTitle,
      ],
      series: [
        {
          name: (labels.workloadChartSeries ?? labels.ankiTasksTitle).slice(0, 40),
          values: [...reviewLines.map((line) => line.count), pendingTodos, overdueTodos, activeAnkiTasks],
        },
      ],
      labels: {},
    }).blocks,
  );

  if (isIdle) {
    extraBlocks.push({
      type: 'alert',
      props: {
        variant: 'info',
        title: labels.idleAlertTitle ?? labels.dueTrendNone,
        description: labels.idleAlertDescription,
      },
    });
  }

  if (calendarDays.length > 0) {
    extraBlocks.push({
      type: 'review-calendar',
      props: {
        title: labels.reviewCalendarTitle,
        days: calendarDays,
      },
    });
  } else {
    extraBlocks.push({
      type: 'list',
      props: {
        title: labels.reviewEmptyTitle ?? labels.dueFlashcardsTitle,
        items: reviewLines
          .filter((line) => line.count > 0)
          .map((line) => ({ label: line.title, badge: String(line.count) })),
        emptyLabel: labels.reviewEmpty ?? labels.dueTrendNone,
      },
    });
  }

  if (actionBarIdx >= 0) {
    blocks.splice(actionBarIdx, 0, ...extraBlocks);
  } else {
    blocks.push(...extraBlocks);
  }

  const nextActionBarIdx = blocks.findIndex((block) => block.type === 'action-bar');
  if (nextActionBarIdx >= 0) {
    const actionBar = blocks[nextActionBarIdx];
    if (actionBar.type === 'action-bar') {
      const existingActions = actionBar.props.actions;
      const actions: ActionBarProps['actions'] = Array.isArray(existingActions)
        ? [...existingActions]
        : [];
      if (dueNotes > 0 && labels.dueNotesTitle && labels.reviewNotes) {
        actions.push({
          id: 'review-notes',
          label: labels.reviewNotes,
          variant: 'default',
          riskLevel: 'low',
        });
      }
      if (activeAnkiTasks > 0) {
        actions.push({
          id: 'open-task-dashboard',
          label: labels.openTaskDashboard,
          variant: 'default',
          riskLevel: 'low',
        });
      }
      blocks[nextActionBarIdx] = {
        ...actionBar,
        props: { ...actionBar.props, actions },
      };
    }
  }

  return { version: '1', blocks };
}
