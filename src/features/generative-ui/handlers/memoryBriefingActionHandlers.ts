import type { GenerativeActionDefinition } from '../types';

export interface MemoryBriefingActionCallbacks {
  onRefresh: () => void;
  onCreateMemory: () => void;
  onOpenMemory?: () => void;
}

export interface MemoryBriefingActionLabels {
  refresh: string;
  createMemory: string;
  openMemory?: string;
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
    'open-memory': {
      id: 'open-memory',
      label: labels.openMemory ?? labels.createMemory,
      riskLevel: 'low',
      handler: async () => {
        if (callbacks.onOpenMemory) {
          callbacks.onOpenMemory();
          return;
        }
        callbacks.onRefresh();
      },
    },
  };
}
