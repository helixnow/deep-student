import { describe, expect, it, vi } from 'vitest';
import { animateTreeRowsExit, collectVisibleSubtreeRowIds } from '../collapseMotion';
import { flattenVisibleTree } from '../flatten';
import type { NotesWorkspaceTreeItem } from '../types';

const items: NotesWorkspaceTreeItem[] = [
  {
    id: 'fld_a',
    name: 'Archive',
    kind: 'folder',
    children: [
      { id: 'note_1', name: 'Alpha', kind: 'note' },
      {
        id: 'fld_b',
        name: 'Nested',
        kind: 'folder',
        children: [{ id: 'note_2', name: 'Beta', kind: 'note' }],
      },
    ],
  },
  { id: 'note_root', name: 'Root note', kind: 'note' },
];

describe('collectVisibleSubtreeRowIds', () => {
  it('collects the visible descendant rows of an expanded folder', () => {
    const rows = flattenVisibleTree(items, new Set(['fld_a', 'fld_b']));
    expect(collectVisibleSubtreeRowIds(rows, 'fld_a')).toEqual([
      'note_1',
      'fld_b',
      'note_2',
    ]);
  });

  it('skips descendants hidden behind a collapsed nested folder', () => {
    const rows = flattenVisibleTree(items, new Set(['fld_a']));
    expect(collectVisibleSubtreeRowIds(rows, 'fld_a')).toEqual(['note_1', 'fld_b']);
  });

  it('returns empty for leaves and unknown ids', () => {
    const rows = flattenVisibleTree(items, new Set(['fld_a']));
    expect(collectVisibleSubtreeRowIds(rows, 'note_root')).toEqual([]);
    expect(collectVisibleSubtreeRowIds(rows, 'missing')).toEqual([]);
  });
});

describe('animateTreeRowsExit', () => {
  it('commits immediately when there is nothing to animate', () => {
    const commit = vi.fn();
    animateTreeRowsExit(null, ['note_1'], commit);
    expect(commit).toHaveBeenCalledTimes(1);

    const container = document.createElement('div');
    animateTreeRowsExit(container, [], commit);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('commits synchronously when WAAPI is unavailable (jsdom)', () => {
    const container = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-nwt-id', 'note_1');
    container.appendChild(row);

    const commit = vi.fn();
    animateTreeRowsExit(container, ['note_1'], commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
