/**
 * 确定性 export-intent — 把当前 Generative UI intent 导出为 Markdown 并复制到剪贴板。
 * low risk，无副作用，不走 HITL。
 */
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';
import {
  buildIntentExportMarkdown,
  type IntentExportMarkdownLabels,
} from '../utils/buildIntentExportMarkdown';

export const EXPORT_INTENT_ACTION_ID = 'export-intent' as const;

export interface ExportIntentActionLabels {
  exportMarkdown: string;
}

export function createExportIntentActionHandlers(
  intent: GenerativeUIIntent,
  labels: ExportIntentActionLabels,
  markdownLabels?: Partial<IntentExportMarkdownLabels>,
): Record<string, GenerativeActionDefinition> {
  return {
    [EXPORT_INTENT_ACTION_ID]: {
      id: EXPORT_INTENT_ACTION_ID,
      label: labels.exportMarkdown,
      riskLevel: 'low',
      handler: async () => {
        const text = buildIntentExportMarkdown(intent, markdownLabels);
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
  };
}
