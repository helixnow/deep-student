import type { GenerativeUIIntent } from '../types';

export interface AIDiffSummaryInput {
  operation: 'append' | 'replace' | 'set';
  operationLabel: string;
  addedCount: number;
  removedCount: number;
  hasChanges: boolean;
  labels: {
    metaTitle: string;
    metaDescription: string;
    statTitle: string;
    noChangeTrend: string;
    addedKey: string;
    removedKey: string;
    operationKey: string;
    alertTitle: string;
    alertDescription: string;
  };
}

export function buildAIDiffSummaryIntent(input: AIDiffSummaryInput): GenerativeUIIntent {
  const { operationLabel, addedCount, removedCount, hasChanges, labels } = input;
  const totalChanges = addedCount + removedCount;

  const trend =
    !hasChanges || totalChanges === 0
      ? 'neutral'
      : addedCount > removedCount
        ? 'up'
        : removedCount > addedCount
          ? 'down'
          : 'neutral';

  const blocks: GenerativeUIIntent['blocks'] = [
    {
      type: 'stat-card',
      props: {
        title: labels.statTitle,
        value: totalChanges,
        trend,
        trendLabel: hasChanges ? operationLabel : labels.noChangeTrend,
      },
    },
    {
      type: 'key-value-grid',
      props: {
        rows: [
          { key: labels.addedKey, value: String(addedCount) },
          { key: labels.removedKey, value: String(removedCount) },
          { key: labels.operationKey, value: operationLabel },
        ],
      },
    },
  ];

  if (!hasChanges) {
    blocks.push({
      type: 'alert',
      props: {
        variant: 'info',
        title: labels.alertTitle,
        description: labels.alertDescription,
      },
    });
  }

  return {
    version: '1',
    meta: {
      title: labels.metaTitle,
      description: labels.metaDescription,
    },
    blocks,
  };
}
