import { describe, expect, it } from 'vitest';
import {
  consumePathsDropHandledFlag,
  isDragDropBlockedView,
} from '@/components/learning-hub/dragDropRouting';

describe('learning-hub drag drop routing', () => {
  it('blocks drag drop in special views only', () => {
    expect(isDragDropBlockedView('trash')).toBe(true);
    expect(isDragDropBlockedView('memory')).toBe(true);
    expect(isDragDropBlockedView('desktop')).toBe(false);

    expect(isDragDropBlockedView('root')).toBe(false);
    expect(isDragDropBlockedView(null)).toBe(false);
    expect(isDragDropBlockedView(undefined)).toBe(false);
  });

  it('consumes paths-handled flag exactly once', () => {
    const flagRef = { current: true };
    expect(consumePathsDropHandledFlag(flagRef)).toBe(true);
    expect(flagRef.current).toBe(false);
    expect(consumePathsDropHandledFlag(flagRef)).toBe(false);
  });
});
