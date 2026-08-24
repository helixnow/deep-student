import type { GenerativeActionDefinition } from '../types';

export interface MemoryBriefingActionCallbacks {
  onRefresh: () => void;
  onCreateMemory: () => void;
}

export interface MemoryBriefingActionLabels {
  refresh: string;
  createMemory: string;
}

export function createMemoryBriefingActionHandlers(
  callbacks: MemoryBriefingActionCallbacks,
  labels: MemoryBriefingActionLabels,
): Record<string, GenerativeActionDefinition> {
  return {
    'refresh-memory': {
      id: 'refresh-memory',
      label: labels.refresh,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onRefresh();
      },
    },
    'create-memory': {
      id: 'create-memory',
      label: labels.createMemory,
      riskLevel: 'low',
      handler: async () => {
        callbacks.onCreateMemory();
      },
    },
  };
}
