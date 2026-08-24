import { describe, it, expect } from 'vitest';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';

const LABELS = {
  statTitle: 'Resources',
  emptyTrend: 'Empty',
  activeTrend: 'Active',
  startReview: 'Review',
  openQbank: 'QBank',
};

describe('buildLearningHubBriefingIntent', () => {
  it('includes stat-card and action-bar', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 12,
      folderLabel: 'Notes',
      labels: LABELS,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('action-bar');
    expect(intent.meta?.description).toBe('Notes');
  });

  it('uses down trend when folder is empty', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 0,
      labels: LABELS,
    });
    const stat = intent.blocks.find((b) => b.type === 'stat-card');
    expect(stat?.props).toMatchObject({ trend: 'down', trendLabel: 'Empty' });
  });
});
