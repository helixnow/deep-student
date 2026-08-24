import { describe, it, expect } from 'vitest';
import { buildNoteSummaryIntent } from '@/features/generative-ui/utils/buildNoteSummaryIntent';

describe('buildNoteSummaryIntent', () => {
  it('builds valid intent from note metadata', () => {
    const intent = buildNoteSummaryIntent({
      title: '线性代数笔记',
      tags: ['math', 'exam'],
      headingCount: 4,
      charCount: 1200,
      topHeadings: ['特征值', '矩阵分解'],
    });
    expect(intent.version).toBe('1');
    expect(intent.blocks.length).toBeGreaterThanOrEqual(2);
    expect(intent.blocks[0]?.type).toBe('stat-card');
  });
});
