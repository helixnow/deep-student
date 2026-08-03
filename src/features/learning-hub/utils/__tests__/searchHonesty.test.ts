import { describe, expect, it } from 'vitest';
import {
  TRASH_RESOURCE_TYPE_MAP,
  getSearchPlaceholderKey,
  isResultTruncated,
  matchesLiveName,
} from '../searchHonesty';

describe('searchHonesty', () => {
  it('maps placeholder keys by viewKind / typeFilter', () => {
    expect(getSearchPlaceholderKey({ viewKind: 'recent' })).toBe('finder.search.placeholderRecent');
    expect(getSearchPlaceholderKey({ viewKind: 'trash' })).toBe('finder.search.placeholderTrash');
    expect(getSearchPlaceholderKey({ viewKind: 'favorites' })).toBe('finder.search.placeholderFavorites');
    expect(getSearchPlaceholderKey({ viewKind: 'folder', typeFilter: 'note' }))
      .toBe('finder.search.placeholderSmartFolder');
    expect(getSearchPlaceholderKey({ viewKind: 'folder' })).toBe('finder.search.placeholder');
  });

  it('maps only backend-supported trash resource types', () => {
    expect(TRASH_RESOURCE_TYPE_MAP.note).toBe('notes');
    expect(TRASH_RESOURCE_TYPE_MAP.textbook).toBe('textbooks');
    expect(TRASH_RESOURCE_TYPE_MAP.exam).toBe('exams');
    expect(TRASH_RESOURCE_TYPE_MAP.translation).toBe('translations');
    expect(TRASH_RESOURCE_TYPE_MAP.essay).toBe('essays');
    expect(TRASH_RESOURCE_TYPE_MAP.folder).toBeUndefined();
    expect(TRASH_RESOURCE_TYPE_MAP.image).toBeUndefined();
    expect(TRASH_RESOURCE_TYPE_MAP.retrieval).toBeUndefined();
  });

  it('matches live names case-insensitively', () => {
    expect(matchesLiveName({ name: '量子力学笔记' }, '量子')).toBe(true);
    expect(matchesLiveName({ name: 'Old Name' }, 'new')).toBe(false);
  });

  it('detects truncation only when a limit-plus-one result exists', () => {
    expect(isResultTruncated(101, 100)).toBe(true);
    expect(isResultTruncated(100, 100)).toBe(false);
    expect(isResultTruncated(50, 100)).toBe(false);
    expect(isResultTruncated(10, 0)).toBe(false);
  });
});
