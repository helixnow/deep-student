import type { GenerativeUIIntent } from '../types';
import type { ActionBarProps } from '../schema';
import {
  buildLearningBriefingIntent,
  type LearningBriefingInput,
  type LearningBriefingLabels,
} from './buildLearningBriefingIntent';

export interface AiDashboardInput extends LearningBriefingInput {
  activeAnkiTasks?: number;
}

export interface AiDashboardLabels extends LearningBriefingLabels {
  ankiTasksTitle: string;
  ankiTasksTrendActive: string;
  openTaskDashboard: string;
}

/** Workbench AI 仪表盘：学习简报 + 可选制卡任务 stat-card */
export function buildAiDashboardIntent(
  input: AiDashboardInput,
  labels: AiDashboardLabels,
): GenerativeUIIntent {
  const { activeAnkiTasks = 0, ...briefingInput } = input;
  const briefing = buildLearningBriefingIntent(briefingInput, labels);
  const blocks = [...briefing.blocks];

  if (activeAnkiTasks > 0) {
    const progressIdx = blocks.findIndex((block) => block.type === 'progress');
    const insertAt = progressIdx >= 0 ? progressIdx : blocks.length;
    blocks.splice(insertAt, 0, {
      type: 'stat-card',
      props: {
        title: labels.ankiTasksTitle,
        value: activeAnkiTasks,
        trend: 'up',
        trendLabel: labels.ankiTasksTrendActive,
      },
    });
  }

  const actionBarIdx = blocks.findIndex((block) => block.type === 'action-bar');
  if (actionBarIdx >= 0) {
    const actionBar = blocks[actionBarIdx];
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
      blocks[actionBarIdx] = {
        ...actionBar,
        props: { ...actionBar.props, actions },
      };
    }
  }

  return { version: '1', blocks };
}
