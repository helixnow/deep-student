import type { GenerativeUIIntent } from '../types';

export interface AIDiffSummaryInput {
  operation: 'append' | 'replace' | 'set';
  addedCount: number;
  removedCount: number;
  hasChanges: boolean;
}

const OPERATION_LABELS: Record<AIDiffSummaryInput['operation'], string> = {
  append: '追加内容',
  replace: '查找替换',
  set: '全文替换',
};

export function buildAIDiffSummaryIntent(input: AIDiffSummaryInput): GenerativeUIIntent {
  const { operation, addedCount, removedCount, hasChanges } = input;
  const operationLabel = OPERATION_LABELS[operation];

  const blocks: GenerativeUIIntent['blocks'] = [
    {
      type: 'stat-card',
      props: {
        title: '变更行数',
        value: addedCount + removedCount,
        trend: hasChanges ? 'up' : 'neutral',
        trendLabel: hasChanges ? `${operationLabel}` : '无实质变更',
      },
    },
    {
      type: 'key-value-grid',
      props: {
        items: [
          { label: '新增', value: String(addedCount) },
          { label: '删除', value: String(removedCount) },
          { label: '操作', value: operationLabel },
        ],
      },
    },
  ];

  if (!hasChanges) {
    blocks.push({
      type: 'alert',
      props: {
        variant: 'info',
        title: '无可见差异',
        message: 'AI 建议与当前正文一致，接受后将不会产生变更。',
      },
    });
  }

  return {
    version: '1',
    meta: {
      title: '变更摘要',
      description: '基于 diff 统计的确定性预览',
    },
    blocks,
  };
}
