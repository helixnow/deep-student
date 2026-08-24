import type { GenerativeUIIntent } from '../types';
import type { ActionBarProps } from '../schema';
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
}

/** Workbench AI 仪表盘：学习简报 + 制卡任务 stat-card + 复习日历/空态 */
export function buildAiDashboardIntent(
  input: AiDashboardInput,
  labels: AiDashboardLabels,
): GenerativeUIIntent {
  const { activeAnkiTasks = 0, reviewDays, ...briefingInput } = input;
  const briefing = buildLearningBriefingIntent(briefingInput, labels);
  const blocks = [...briefing.blocks];
  const dueFlashcards = briefingInput.dueFlashcards ?? 0;
  const pendingTodos = briefingInput.pendingTodos ?? 0;
  const overdueTodos = briefingInput.overdueTodos ?? 0;
  const isIdle = dueFlashcards === 0 && pendingTodos === 0 && overdueTodos === 0 && activeAnkiTasks === 0;
  const calendarDays = (reviewDays ?? [])
    .filter((day) => day.date.trim().length > 0 && day.dueCount >= 0)
    .slice(0, 14);

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
        items:
          dueFlashcards > 0
            ? [{ label: labels.dueFlashcardsTitle, badge: String(dueFlashcards) }]
            : [],
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
