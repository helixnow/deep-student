import type { GenerativeActionDefinition } from '../types';

export interface IndexStatusBriefingActionCallbacks {
  onBatchIndex: () => void;
  onRefresh: () => void;
}

export interface IndexStatusBriefingActionLabels {
  batchIndex: string;
  refresh: string;
}

export function createIndexStatusBriefingActionHandlers(
  callbacks: IndexStatusBriefingActionCallbacks,
  labels: IndexStatusBriefingActionLabels,
): Record<string, GenerativeActionDefinition> {
  return {
    'batch-index-pending': {
      id: 'batch-index-pending',
      label: labels.batchIndex,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onBatchIndex();
      },
    },
    'refresh-index-status': {
      id: 'refresh-index-status',
      label: labels.refresh,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onRefresh();
      },
    },
  };
}
