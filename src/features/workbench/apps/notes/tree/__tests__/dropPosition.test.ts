import { describe, expect, it } from 'vitest';
import { calculateDropPosition, isInvalidFolderDrop } from '../dropPosition';

describe('calculateDropPosition', () => {
  const base = { overTop: 100, overHeight: 30 };

  it('places before / inside / after on a folder by vertical thirds', () => {
    expect(calculateDropPosition({
      ...base,
      isFolder: true,
      isExpanded: true,
      hasChildren: true,
      pointerY: 105,
    })).toBe('before');

    expect(calculateDropPosition({
      ...base,
      isFolder: true,
      isExpanded: true,
      hasChildren: true,
      pointerY: 115,
    })).toBe('inside');

    expect(calculateDropPosition({
      ...base,
      isFolder: true,
      isExpanded: true,
      hasChildren: true,
      pointerY: 128,
    })).toBe('after');
  });

  it('coerces after → inside when folder is collapsed or empty', () => {
    expect(calculateDropPosition({
      ...base,
      isFolder: true,
      isExpanded: false,
      hasChildren: true,
      pointerY: 128,
    })).toBe('inside');

    expect(calculateDropPosition({
      ...base,
      isFolder: true,
      isExpanded: true,
      hasChildren: false,
      pointerY: 128,
    })).toBe('inside');
  });

  it('splits leaf rows into before / after at the midpoint', () => {
    expect(calculateDropPosition({
      ...base,
      isFolder: false,
      isExpanded: false,
      hasChildren: false,
      pointerY: 110,
    })).toBe('before');

    expect(calculateDropPosition({
      ...base,
      isFolder: false,
      isExpanded: false,
      hasChildren: false,
      pointerY: 120,
    })).toBe('after');
  });
});

describe('isInvalidFolderDrop', () => {
  it('rejects self drops and drops onto own descendants', () => {
    const descendants = new Set(['child', 'grandchild']);
    expect(isInvalidFolderDrop('folder', 'folder', 'inside', descendants)).toBe(true);
    expect(isInvalidFolderDrop('folder', 'child', 'inside', descendants)).toBe(true);
    expect(isInvalidFolderDrop('folder', 'sibling', 'before', descendants)).toBe(false);
  });
});
