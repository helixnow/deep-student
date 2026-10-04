/**
 * 学习场景 action handlers（确定性副作用，不由模型执行）
 */

import i18next from 'i18next';
import type { GenerativeActionDefinition } from '../types';

function label(key: string, defaultValue: string): string {
  const text = i18next.t(`generativeUi:${key}`, { defaultValue });
  return typeof text === 'string' && text ? text : defaultValue;
}

export const learningActionHandlers: Record<string, GenerativeActionDefinition> = {
  'start-review': {
    id: 'start-review',
    get label() { return label('workbench.briefing.start_review', '开始复习'); },
    riskLevel: 'low',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('deepstudent:learning-action', { detail: { action: 'start-review' } }));
    },
  },
  'open-qbank': {
    id: 'open-qbank',
    get label() { return label('workbench.briefing.open_qbank', '打开题目集'); },
    riskLevel: 'low',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('deepstudent:learning-action', { detail: { action: 'open-qbank' } }));
    },
  },
  'export-plan': {
    id: 'export-plan',
    get label() { return label('research.actions.export_plan', '导出计划'); },
    riskLevel: 'medium',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('deepstudent:learning-action', { detail: { action: 'export-plan' } }));
    },
  },
};
