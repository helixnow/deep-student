import type { AutoExtractFrequency } from '@/api/memoryApi';
import type { GenerativeUIIntent } from '../types';

export interface MemoryBriefingLabels {
  countTitle: string;
  activeTrend: string;
  emptyTrend: string;
  overviewTitle: string;
  rootFolderRow: string;
  autoExtractRow: string;
  freqOff: string;
  freqBalanced: string;
  freqAggressive: string;
  refresh: string;
  createMemory: string;
}

export interface MemoryBriefingInput {
  memoryCount: number;
  rootFolderTitle?: string;
  autoExtractFrequency?: AutoExtractFrequency;
  labels: MemoryBriefingLabels;
}

function resolveFrequencyLabel(
  frequency: AutoExtractFrequency | undefined,
  labels: MemoryBriefingLabels,
): string {
  switch (frequency) {
    case 'off':
      return labels.freqOff;
    case 'aggressive':
      return labels.freqAggressive;
    case 'balanced':
    default:
      return labels.freqBalanced;
  }
}

export function buildMemoryBriefingIntent(input: MemoryBriefingInput): GenerativeUIIntent {
  const { memoryCount, rootFolderTitle, autoExtractFrequency, labels } = input;

  return {
    version: '1',
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: labels.countTitle,
          value: memoryCount,
          trend: memoryCount > 0 ? 'up' : 'down',
          trendLabel: memoryCount > 0 ? labels.activeTrend : labels.emptyTrend,
        },
      },
      {
        type: 'key-value-grid',
        props: {
          title: labels.overviewTitle,
          rows: [
            ...(rootFolderTitle
              ? [{ key: labels.rootFolderRow, value: rootFolderTitle }]
              : []),
            {
              key: labels.autoExtractRow,
              value: resolveFrequencyLabel(autoExtractFrequency, labels),
            },
          ],
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            { id: 'create-memory', label: labels.createMemory, variant: 'primary', riskLevel: 'low' },
            { id: 'refresh-memory', label: labels.refresh, variant: 'default', riskLevel: 'low' },
          ],
        },
      },
    ],
  };
}
