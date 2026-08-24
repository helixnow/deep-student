import { describe, it, expect } from 'vitest';
import { buildAIDiffSummaryIntent } from '@/features/generative-ui/utils/buildAIDiffSummaryIntent';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { validateBlockProps } from '@/features/generative-ui/schema';

import '@/features/generative-ui/blocks';

const LABELS = {
  metaTitle: '变更摘要',
  metaDescription: '基于 diff 统计的确定性预览',
  statTitle: '变更行数',
  noChangeTrend: '无实质变更',
  addedKey: '新增',
  removedKey: '删除',
  operationKey: '操作',
  alertTitle: '无可见差异',
  alertDescription: 'AI 建议与当前正文一致，接受后将不会产生变更。',
};

function expectIntentBlocksValid(intent: ReturnType<typeof buildAIDiffSummaryIntent>) {
  for (const block of intent.blocks) {
    const config = generativeUIRegistry.get(block.type);
    expect(config, `missing registry entry for ${block.type}`).toBeDefined();
    const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
    expect(validation.ok, validation.ok ? '' : validation.errors.join('; ')).toBe(true);
  }
}

describe('buildAIDiffSummaryIntent', () => {
  it('includes stat-card and key-value-grid for changes', () => {
    const intent = buildAIDiffSummaryIntent({
      operation: 'replace',
      operationLabel: '替换内容',
      addedCount: 3,
      removedCount: 2,
      hasChanges: true,
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('key-value-grid');
    expect(types).not.toContain('alert');
    expectIntentBlocksValid(intent);
  });

  it('adds alert when no changes and all blocks pass schema', () => {
    const intent = buildAIDiffSummaryIntent({
      operation: 'append',
      operationLabel: '追加内容',
      addedCount: 0,
      removedCount: 0,
      hasChanges: false,
      labels: LABELS,
    });
    expect(intent.blocks.map((b) => b.type)).toContain('alert');
    expectIntentBlocksValid(intent);
  });
});
