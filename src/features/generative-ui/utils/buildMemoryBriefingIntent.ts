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
  emptyGuideTitle?: string;
  emptyGuideBody?: string;
  stepsTitle?: string;
  stepCreate?: string;
  stepOpen?: string;
  stepRefresh?: string;
  recentColTitle?: string;
  recentColDetail?: string;
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

  const isEmpty = memoryCount === 0;

  return {
    version: '1.1',
    layout: { mode: 'grid', columns: 2 },
    blocks: [
      {
        type: 'stat-card',
        span: 1,
        props: {
          title: labels.countTitle,
          value: memoryCount,
          trend: memoryCount > 0 ? 'up' : 'down',
          trendLabel: memoryCount > 0 ? labels.activeTrend : labels.emptyTrend,
        },
      },
      {
        type: 'steps',
        span: 1,
        props: {
          title: labels.stepsTitle ?? labels.overviewTitle,
          steps: [
            {
              label: labels.stepCreate ?? labels.createMemory,
              status: isEmpty ? 'active' : 'done',
            },
            {
              label: labels.stepOpen ?? labels.openMemory ?? labels.countTitle,
              status: memoryCount > 0 ? 'active' : 'pending',
            },
            {
              label: labels.stepRefresh ?? labels.refresh,
              status: 'pending',
            },
          ],
        },
      },
      ...(isEmpty
        ? [
            {
              type: 'markdown' as const,
              span: 2 as const,
              props: {
                title: labels.emptyGuideTitle ?? labels.emptyTrend,
                body: labels.emptyGuideBody ?? labels.emptyTrend,
                variant: 'compact' as const,
              },
            },
          ]
        : []),
      {
        type: 'key-value-grid',
        span: 2,
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
        type: 'table',
        span: 2,
        props: {
          title: labels.recentListTitle ?? labels.overviewTitle,
          columns: [
            { key: 'title', label: labels.recentColTitle ?? labels.countTitle },
            { key: 'detail', label: labels.recentColDetail ?? labels.overviewTitle },
          ],
          rows: listItems.map((item) => ({
            title: item.label,
            detail: item.description ?? item.badge ?? '',
          })),
          emptyLabel: labels.recentEmpty ?? labels.emptyTrend,
        },
      },
      {
        type: 'action-bar',
        span: 2,
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
