import type { ResourceIndexStatusSummary } from '@/api/vfsUnifiedIndexApi';
import type { GenerativeUIIntent } from '../types';

export interface IndexStatusBriefingLabels {
  totalTitle: string;
  progressTitle: string;
  indexedRow: string;
  pendingRow: string;
  failedRow: string;
  indexingRow: string;
  allIndexedTrend: string;
  needsAttentionTrend: string;
  batchIndex: string;
  refresh: string;
  failedAlertTitle?: string;
  failedAlertDescription?: string;
  emptyIndexTitle?: string;
  emptyIndexDescription?: string;
  scanProgressTitle?: string;
  scanProgressLabel?: string;
}

export interface IndexStatusBriefingInput {
  summary: Pick<
    ResourceIndexStatusSummary,
    'totalResources' | 'indexedCount' | 'pendingCount' | 'failedCount' | 'indexingCount'
  >;
  labels: IndexStatusBriefingLabels;
}

export function buildIndexStatusBriefingIntent(input: IndexStatusBriefingInput): GenerativeUIIntent {
  const { summary, labels } = input;
  const { totalResources, indexedCount, pendingCount, failedCount, indexingCount } = summary;
  const needsWork = pendingCount + failedCount + indexingCount;
  const progressRatio = totalResources > 0 ? indexedCount / totalResources : 0;
  const isEmpty = totalResources === 0;

  const batchActions =
    needsWork > 0
      ? [
          {
            id: 'batch-index-pending',
            label: labels.batchIndex,
            variant: 'primary' as const,
            riskLevel: 'low' as const,
          },
        ]
      : [];

  return {
    version: '1',
    blocks: [
      ...(isEmpty
        ? [
            {
              type: 'alert' as const,
              props: {
                variant: 'info' as const,
                title: labels.emptyIndexTitle ?? labels.totalTitle,
                description: labels.emptyIndexDescription ?? labels.allIndexedTrend,
              },
            },
          ]
        : []),
      ...(failedCount > 0
        ? [
            {
              type: 'alert' as const,
              props: {
                variant: 'destructive' as const,
                title: labels.failedAlertTitle ?? labels.needsAttentionTrend,
                description: labels.failedAlertDescription ?? `${labels.failedRow}: ${failedCount}`,
              },
            },
          ]
        : []),
      {
        type: 'stat-card',
        props: {
          title: labels.totalTitle,
          value: totalResources,
          trend: needsWork > 0 ? 'neutral' : totalResources > 0 ? 'up' : 'down',
          trendLabel: needsWork > 0 ? labels.needsAttentionTrend : labels.allIndexedTrend,
        },
      },
      {
        type: 'progress',
        props: {
          title: labels.progressTitle,
          current: indexedCount,
          total: Math.max(totalResources, 1),
          label: labels.indexedRow.replace('{{count}}', String(indexedCount)),
        },
      },
      ...(indexingCount > 0
        ? [
            {
              type: 'progress' as const,
              props: {
                title: labels.scanProgressTitle ?? labels.indexingRow,
                current: indexingCount,
                total: Math.max(pendingCount + indexingCount, indexingCount, 1),
                label: (labels.scanProgressLabel ?? labels.indexingRow).replace(
                  '{{count}}',
                  String(indexingCount),
                ),
              },
            },
          ]
        : []),
      {
        type: 'key-value-grid',
        props: {
          rows: [
            { key: labels.pendingRow, value: String(pendingCount) },
            { key: labels.failedRow, value: String(failedCount) },
            { key: labels.indexingRow, value: String(indexingCount) },
          ],
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            ...batchActions,
            {
              id: 'refresh-index-status',
              label: labels.refresh,
              variant: batchActions.length > 0 ? ('default' as const) : ('primary' as const),
              riskLevel: 'low' as const,
            },
          ],
        },
      },
    ],
    meta: {
      description:
        totalResources > 0
          ? `${Math.round(progressRatio * 100)}%`
          : undefined,
    },
  };
}
