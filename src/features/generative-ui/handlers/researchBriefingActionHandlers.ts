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

export interface CopyReportActionLabels {
  copyReport: string;
}

/**
 * 兜底 copy-report handler：用于无 research-report 块的通用摘要/简报场景，
 * 复用统一 Markdown 导出格式化结果写入剪贴板。
 */
export function createCopyReportFallbackActionHandlers(
  intent: GenerativeUIIntent,
  labels: CopyReportActionLabels,
  getReportBody: () => string | null | undefined,
  markdownLabels?: Partial<IntentExportMarkdownLabels>,
): Record<string, GenerativeActionDefinition> {
  return {
    'copy-report': {
      id: 'copy-report',
      label: labels.copyReport,
      riskLevel: 'low',
      handler: async () => {
        const reportBody = getReportBody()?.trim();
        const text = reportBody || buildIntentExportMarkdown(intent, markdownLabels).trim();
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
  };
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
