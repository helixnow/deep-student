/**
 * 学习场景 action handlers（确定性副作用，不由模型执行）
 */

import type { GenerativeActionDefinition } from '../types';

export const learningActionHandlers: Record<string, GenerativeActionDefinition> = {
  'start-review': {
    id: 'start-review',
    label: '开始复习',
    riskLevel: 'low',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('deepstudent:learning-action', { detail: { action: 'start-review' } }));
    },
  },
  'open-qbank': {
    id: 'open-qbank',
    label: '打开题库',
    riskLevel: 'low',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('deepstudent:learning-action', { detail: { action: 'open-qbank' } }));
    },
  },
  'export-plan': {
    id: 'export-plan',
    label: '导出计划',
    riskLevel: 'medium',
    handler: async () => {
      window.dispatchEvent(new CustomEvent('deepstudent:learning-action', { detail: { action: 'export-plan' } }));
    },
  },
};
