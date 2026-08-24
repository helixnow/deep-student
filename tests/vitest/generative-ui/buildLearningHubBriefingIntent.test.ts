import { describe, it, expect } from 'vitest';
import { buildLearningHubBriefingIntent } from '@/features/generative-ui/utils/buildLearningHubBriefingIntent';

describe('buildLearningHubBriefingIntent', () => {
  it('includes stat-card and action-bar', () => {
    const intent = buildLearningHubBriefingIntent({
      resourceCount: 12,
      folderLabel: 'Notes',
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('action-bar');
    expect(intent.meta?.description).toBe('Notes');
  });
});
