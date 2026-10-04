/**
 * Research 场景 action handlers — Chat / HPIAS 面板上下文注入
 */
import i18next from 'i18next';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';
import {
  buildIntentExportMarkdown,
  type IntentExportMarkdownLabels,
} from '../utils/buildIntentExportMarkdown';

function exportIntentFallbackLabel(): string {
  const text = i18next.t('generativeUi:research.actions.export_intent', { defaultValue: '复制为 Markdown' });
  return typeof text === 'string' && text ? text : '复制为 Markdown';
}

export interface ResearchBriefingActionCallbacks {
  getReportBody: () => string;
  getExportMarkdown: () => string;
  getIntent?: () => GenerativeUIIntent | null | undefined;
  onExportIntent?: (markdown: string) => void | Promise<void>;
}

export interface ResearchBriefingActionLabels {
  copyReport: string;
  exportPlan: string;
  exportIntent?: string;
}

export function createResearchBriefingActionHandlers(
  callbacks: ResearchBriefingActionCallbacks,
  labels: ResearchBriefingActionLabels,
  intentExportLabels?: Partial<IntentExportMarkdownLabels>,
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
    'export-intent': {
      id: 'export-intent',
      label: labels.exportIntent ?? exportIntentFallbackLabel(),
      riskLevel: 'low',
      handler: async () => {
        const intent = callbacks.getIntent?.();
        if (!intent) return;
        const text = buildIntentExportMarkdown(intent, intentExportLabels).trim();
        if (!text) return;
        if (callbacks.onExportIntent) {
          await callbacks.onExportIntent(text);
          return;
        }
        await copyTextToClipboard(text);
      },
    },
  };
}
