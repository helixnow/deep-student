/**
 * 确定性 copy-intent — 把当前 Generative UI intent JSON 复制到剪贴板。
 * low risk，无副作用，不走 HITL。
 */
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';

export const COPY_INTENT_ACTION_ID = 'copy-intent' as const;

export interface CopyIntentActionLabels {
  copyIntent: string;
}

export function serializeGenerativeUIIntent(intent: GenerativeUIIntent): string {
  return JSON.stringify(intent, null, 2);
}

export function createCopyIntentActionHandlers(
  intent: GenerativeUIIntent,
  labels: CopyIntentActionLabels,
): Record<string, GenerativeActionDefinition> {
  return {
    [COPY_INTENT_ACTION_ID]: {
      id: COPY_INTENT_ACTION_ID,
      label: labels.copyIntent,
      riskLevel: 'low',
      handler: async () => {
        const text = serializeGenerativeUIIntent(intent);
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
  };
}
