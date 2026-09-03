/**
 * Workbench 场景 learning action handlers — 走 workbenchBus 确定性路由
 */

import { workbenchBus } from '@/features/workbench';
import type { GenerativeActionDefinition } from '../types';

const FLASHCARDS_DUE_ACTIVATE = {
  typeId: 'flashcards',
  instanceKey: '',
  action: 'startReview',
  payload: { screen: 'session', mode: 'due' } as const,
  fallbackLaunch: {
    typeId: 'flashcards',
    reason: 'api' as const,
    payload: { screen: 'session', mode: 'due' } as const,
  },
};

export interface WorkbenchLearningHandlerLabels {
  startReview?: string;
  openQbank?: string;
  exportPlan?: string;
  openTaskDashboard?: string;
}

export function createWorkbenchLearningHandlers(
  labels: WorkbenchLearningHandlerLabels = {},
): Record<string, GenerativeActionDefinition> {
  return {
    'start-review': {
      id: 'start-review',
      label: labels.startReview ?? '开始复习',
      riskLevel: 'low',
      handler: async () => {
        await workbenchBus.activateDetailed(FLASHCARDS_DUE_ACTIVATE);
      },
    },
    'open-qbank': {
      id: 'open-qbank',
      label: labels.openQbank ?? '打开题库',
      riskLevel: 'low',
      handler: async () => {
        workbenchBus.launch({ typeId: 'exam', reason: 'api' });
      },
    },
    'export-plan': {
      id: 'export-plan',
      label: labels.exportPlan ?? '导出计划',
      riskLevel: 'medium',
      handler: async () => {
        workbenchBus.launch({ typeId: 'learning-hub', reason: 'api' });
      },
    },
    'open-task-dashboard': {
      id: 'open-task-dashboard',
      label: labels.openTaskDashboard ?? '制卡任务',
      riskLevel: 'low',
      handler: async () => {
        workbenchBus.launch({ typeId: 'taskDashboard', reason: 'api' });
      },
    },
  };
}

export const workbenchLearningHandlers = createWorkbenchLearningHandlers();
