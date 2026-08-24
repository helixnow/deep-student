import type { AutoExtractFrequency } from '@/api/memoryApi';
import type { GenerativeUIIntent } from '../types';

export interface MemoryBriefingListItem {
  label: string;
  description?: string;
  badge?: string;
}

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
  recentListTitle?: string;
  recentEmpty?: string;
  openMemory?: string;
}

export interface MemoryBriefingInput {
  memoryCount: number;
  rootFolderTitle?: string;
  autoExtractFrequency?: AutoExtractFrequency;
  recentItems?: MemoryBriefingListItem[];
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
  const { memoryCount, rootFolderTitle, autoExtractFrequency, recentItems = [], labels } = input;
  const listItems = recentItems
    .filter((item) => item.label.trim().length > 0)
    .slice(0, 8)
    .map((item) => ({
      label: item.label.slice(0, 200),
      ...(item.description ? { description: item.description.slice(0, 300) } : {}),
      ...(item.badge ? { badge: item.badge.slice(0, 40) } : {}),
    }));

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
        type: 'list',
        props: {
          title: labels.recentListTitle ?? labels.overviewTitle,
          items: listItems,
          emptyLabel: labels.recentEmpty ?? labels.emptyTrend,
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            { id: 'create-memory', label: labels.createMemory, variant: 'primary', riskLevel: 'low' },
            {
              id: 'open-memory',
              label: labels.openMemory ?? labels.countTitle,
              variant: 'default',
              riskLevel: 'low',
            },
            { id: 'refresh-memory', label: labels.refresh, variant: 'default', riskLevel: 'low' },
          ],
        },
      },
    ],
  };
}
