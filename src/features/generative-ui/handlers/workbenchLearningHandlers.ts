/**
 * Workbench 场景 learning action handlers — 走 workbenchBus 确定性路由
 */

import i18next from 'i18next';
import { workbenchBus } from '@/features/workbench';
import type { GenerativeActionDefinition } from '../types';

/** Fallback labels resolve on read so module-level handler maps follow language switches. */
function fallbackLabel(key: string, defaultValue: string): string {
  const text = i18next.t(`generativeUi:${key}`, { defaultValue });
  return typeof text === 'string' && text ? text : defaultValue;
}

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
  reviewNotes?: string;
}

export function createWorkbenchLearningHandlers(
  labels: WorkbenchLearningHandlerLabels = {},
): Record<string, GenerativeActionDefinition> {
  return {
    'start-review': {
      id: 'start-review',
      get label() { return labels.startReview ?? fallbackLabel('workbench.briefing.start_review', '开始复习'); },
      riskLevel: 'low',
      handler: async () => {
        await workbenchBus.activateDetailed(FLASHCARDS_DUE_ACTIVATE);
      },
    },
    'open-qbank': {
      id: 'open-qbank',
      get label() { return labels.openQbank ?? fallbackLabel('workbench.briefing.open_qbank', '打开题目集'); },
      riskLevel: 'low',
      handler: async () => {
        workbenchBus.launch({ typeId: 'exam', reason: 'api' });
      },
    },
    'export-plan': {
      id: 'export-plan',
      get label() { return labels.exportPlan ?? fallbackLabel('research.actions.export_plan', '导出计划'); },
      riskLevel: 'medium',
      handler: async () => {
        workbenchBus.launch({ typeId: 'learning-hub', reason: 'api' });
      },
    },
    'review-notes': {
      id: 'review-notes',
      get label() { return labels.reviewNotes ?? fallbackLabel('workbench.dashboard.review_notes', '复习笔记'); },
      riskLevel: 'low',
      handler: async () => {
        const { openDueNotesReview } = await import('@/features/learning-today/todayLearning');
        openDueNotesReview(() => workbenchBus.launch({ typeId: 'learning-hub', reason: 'api' }));
      },
    },
    'open-task-dashboard': {
      id: 'open-task-dashboard',
      get label() { return labels.openTaskDashboard ?? fallbackLabel('workbench.dashboard.open_task_dashboard', '打开制卡任务'); },
      riskLevel: 'low',
      handler: async () => {
        workbenchBus.launch({ typeId: 'taskDashboard', reason: 'api' });
      },
    },
  };
}

export const workbenchLearningHandlers = createWorkbenchLearningHandlers();
