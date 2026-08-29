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
  failedMarkdownTitle?: string;
  failedMarkdownBody?: string;
  statusTableTitle?: string;
  statusColName?: string;
  statusColCount?: string;
  indexedLabel?: string;
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

  const indexedLabel =
    (labels.indexedLabel ?? labels.indexedRow.replace('{{count}}', '').trim()) || labels.progressTitle;
  const failedBody = (
    labels.failedMarkdownBody ??
    labels.failedAlertDescription ??
    `${labels.failedRow}: ${failedCount}`
  ).replace('{{count}}', String(failedCount));

  return {
    version: '1.1',
    layout: { mode: 'grid', columns: 2 },
    blocks: [
      ...(isEmpty
        ? [
            {
              type: 'alert' as const,
              span: 2 as const,
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
              span: 2 as const,
              props: {
                variant: 'destructive' as const,
                title: labels.failedAlertTitle ?? labels.needsAttentionTrend,
                description: labels.failedAlertDescription ?? `${labels.failedRow}: ${failedCount}`,
              },
            },
            {
              type: 'markdown' as const,
              span: 2 as const,
              props: {
                title: labels.failedMarkdownTitle ?? labels.failedAlertTitle ?? labels.needsAttentionTrend,
                body: failedBody,
                variant: 'compact' as const,
              },
            },
          ]
        : []),
      {
        type: 'stat-card',
        span: 1,
        props: {
          title: labels.totalTitle,
          value: totalResources,
          trend: needsWork > 0 ? 'neutral' : totalResources > 0 ? 'up' : 'down',
          trendLabel: needsWork > 0 ? labels.needsAttentionTrend : labels.allIndexedTrend,
        },
      },
      {
        type: 'progress',
        span: 1,
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
              span: 2 as const,
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
        type: 'table',
        span: 2,
        props: {
          title: labels.statusTableTitle ?? labels.progressTitle,
          columns: [
            { key: 'status', label: labels.statusColName ?? labels.progressTitle },
            {
              key: 'count',
              label: labels.statusColCount ?? labels.totalTitle,
              align: 'right' as const,
            },
          ],
          rows: [
            { status: indexedLabel, count: indexedCount },
            { status: labels.pendingRow, count: pendingCount },
            { status: labels.failedRow, count: failedCount },
            { status: labels.indexingRow, count: indexingCount },
          ],
        },
      },
      {
        type: 'key-value-grid',
        span: 2,
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
        span: 2,
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
