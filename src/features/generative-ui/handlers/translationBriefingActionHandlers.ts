/**
 * Translation 场景 action handlers — 由 TranslationGenerativeBriefing 注入上下文。
 */
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { GenerativeActionDefinition } from '../types';

export interface TranslationBriefingActionCallbacks {
  onOpenSettings: () => void;
  getTranslatedText: () => string;
}

export interface TranslationBriefingActionLabels {
  openSettings: string;
  copyTranslation: string;
}

export function createTranslationBriefingActionHandlers(
  callbacks: TranslationBriefingActionCallbacks,
  labels: TranslationBriefingActionLabels,
): Record<string, GenerativeActionDefinition> {
  return {
    'open-settings': {
      id: 'open-settings',
      label: labels.openSettings,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onOpenSettings();
      },
    },
    'copy-translation': {
      id: 'copy-translation',
      label: labels.copyTranslation,
      riskLevel: 'low',
      handler: async () => {
        const text = callbacks.getTranslatedText().trim();
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
  };
}
