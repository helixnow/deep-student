import { describe, it, expect } from 'vitest';
import { buildAIDiffSummaryIntent } from '@/features/generative-ui/utils/buildAIDiffSummaryIntent';

describe('buildAIDiffSummaryIntent', () => {
  it('includes stat-card and key-value-grid for changes', () => {
    const intent = buildAIDiffSummaryIntent({
      operation: 'replace',
      addedCount: 3,
      removedCount: 2,
      hasChanges: true,
    });
    const types = intent.blocks.map((b) => b.type);
    expect(types).toContain('stat-card');
    expect(types).toContain('key-value-grid');
    expect(types).not.toContain('alert');
  });

  it('adds alert when no changes', () => {
    const intent = buildAIDiffSummaryIntent({
      operation: 'append',
      addedCount: 0,
      removedCount: 0,
      hasChanges: false,
    });
    expect(intent.blocks.map((b) => b.type)).toContain('alert');
  });
});
