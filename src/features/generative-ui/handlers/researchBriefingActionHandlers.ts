/**
 * Research 场景 action handlers — Chat / HPIAS 面板上下文注入
 */
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { GenerativeActionDefinition } from '../types';

export interface ResearchBriefingActionCallbacks {
  getReportBody: () => string;
  getExportMarkdown: () => string;
}

export interface ResearchBriefingActionLabels {
  copyReport: string;
  exportPlan: string;
}

export function createResearchBriefingActionHandlers(
  callbacks: ResearchBriefingActionCallbacks,
  labels: ResearchBriefingActionLabels,
): Record<string, GenerativeActionDefinition> {
  return {
    'copy-report': {
      id: 'copy-report',
      label: labels.copyReport,
      riskLevel: 'low',
      handler: async () => {
        const text = callbacks.getReportBody().trim();
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
    'export-plan': {
      id: 'export-plan',
      label: labels.exportPlan,
      riskLevel: 'medium',
      handler: async () => {
        const text = callbacks.getExportMarkdown().trim();
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
  };
}
