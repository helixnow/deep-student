import { describe, expect, it } from 'vitest';
import {
  consumePathsDropHandledFlag,
  isDragDropBlockedView,
} from '@/components/learning-hub/dragDropRouting';
import {
  getCreatableFolderId,
  isRealFolderId,
  isSpecialViewFolderId,
} from '@/components/learning-hub/viewGuards';

describe('learning-hub drag drop routing', () => {
  it('blocks drag drop in special views only', () => {
    expect(isDragDropBlockedView('trash')).toBe(true);
    expect(isDragDropBlockedView('memory')).toBe(true);
    expect(isDragDropBlockedView('desktop')).toBe(true);
    expect(isDragDropBlockedView('recent')).toBe(true);

    expect(isDragDropBlockedView('root')).toBe(false);
    expect(isDragDropBlockedView(null)).toBe(false);
    expect(isDragDropBlockedView(undefined)).toBe(false);
  });

  it('distinguishes real folders from special views', () => {
    expect(isSpecialViewFolderId('root')).toBe(true);
    expect(isSpecialViewFolderId('memory')).toBe(true);
    expect(isSpecialViewFolderId('fld_123')).toBe(false);

    expect(isRealFolderId('fld_123')).toBe(true);
    expect(isRealFolderId('root')).toBe(false);
    expect(isRealFolderId('desktop')).toBe(false);
    expect(isRealFolderId(null)).toBe(false);
  });

  it('normalizes creatable target folder ids', () => {
    expect(getCreatableFolderId('fld_123')).toBe('fld_123');
    expect(getCreatableFolderId('root')).toBeNull();
    expect(getCreatableFolderId('trash')).toBeNull();
    expect(getCreatableFolderId('memory')).toBeNull();
    expect(getCreatableFolderId(undefined)).toBeNull();
  });

  it('consumes paths-handled flag exactly once', () => {
    const flagRef = { current: true };
    expect(consumePathsDropHandledFlag(flagRef)).toBe(true);
    expect(flagRef.current).toBe(false);
    expect(consumePathsDropHandledFlag(flagRef)).toBe(false);
  });
});
