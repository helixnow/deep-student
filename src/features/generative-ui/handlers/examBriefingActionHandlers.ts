/**
 * Exam 场景 action handlers — 由 ExamGenerativeBriefing 注入上下文回调。
 */

import type { GenerativeActionDefinition } from '../types';

export interface ExamBriefingActionCallbacks {
  onStartReview: () => void;
  onOpenPractice: () => void;
}

export interface ExamBriefingActionLabels {
  startReview: string;
  openPractice: string;
}

export function createExamBriefingActionHandlers(
  callbacks: ExamBriefingActionCallbacks,
  labels: ExamBriefingActionLabels,
): Record<string, GenerativeActionDefinition> {
  return {
    'start-review': {
      id: 'start-review',
      label: labels.startReview,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onStartReview();
      },
    },
    'open-practice': {
      id: 'open-practice',
      label: labels.openPractice,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onOpenPractice();
      },
    },
  };
}
