import { describe, expect, it } from 'vitest';
import {
  collectFolderEntries,
  expandedIdsFromCollapsedPaths,
  flattenVisibleTree,
  mapWorkspaceTreeFolder,
  type WorkspaceTreeFolderSource,
} from '../flatten';

function folder(
  partial: Partial<WorkspaceTreeFolderSource> & Pick<WorkspaceTreeFolderSource, 'name' | 'path'>,
): WorkspaceTreeFolderSource {
  return {
    folders: new Map(),
    resources: [],
    ...partial,
  };
}

describe('mapWorkspaceTreeFolder', () => {
  it('maps virtual root children into NotesWorkspaceTreeItem[]', () => {
    const child = folder({
      id: 'fld_a',
      name: 'Archive',
      path: '/fld_a',
      resources: [
        { id: 'note_1', name: 'Alpha', type: 'note', isFavorite: true },
        { id: 'mm_1', name: 'Map', type: 'mindmap', metadata: { isFavorite: false } },
      ],
    });
    const root = folder({
      name: '',
      path: '/',
      folders: new Map([['fld_a', child]]),
      resources: [{ id: 'note_root', name: 'Root note', type: 'note' }],
    });

    const items = mapWorkspaceTreeFolder(root);
    expect(items).toEqual([
      {
        id: 'fld_a',
        name: 'Archive',
        kind: 'folder',
        path: '/fld_a',
        canRename: true,
        canMove: true,
        children: [
          {
            id: 'note_1',
            name: 'Alpha',
            kind: 'note',
            favorite: true,
            canRename: true,
            canMove: true,
          },
          {
            id: 'mm_1',
            name: 'Map',
            kind: 'mindmap',
            favorite: false,
            canRename: true,
            canMove: true,
          },
        ],
      },
      {
        id: 'note_root',
        name: 'Root note',
        kind: 'note',
        favorite: false,
        canRename: true,
        canMove: true,
      },
    ]);
  });

  it('skips empty synthetic path folders without stable id', () => {
    const synthetic = folder({ name: 'Orphan path', path: '/orphan' });
    const root = folder({
      name: '',
      path: '/',
      folders: new Map([['orphan', synthetic]]),
    });
    expect(mapWorkspaceTreeFolder(root)).toEqual([]);
  });

  it('keeps synthetic path folders that hold resources (read-only)', () => {
    const synthetic = folder({
      name: 'course',
      path: '/path:course',
      resources: [{ id: 'note_1', name: 'Alpha', type: 'note' }],
    });
    const root = folder({
      name: '',
      path: '/',
      folders: new Map([['course', synthetic]]),
    });
    expect(mapWorkspaceTreeFolder(root)).toEqual([
      {
        id: 'synth:/path:course',
        name: 'course',
        kind: 'folder',
        path: '/path:course',
        canRename: false,
        canMove: false,
        children: [
          {
            id: 'note_1',
            name: 'Alpha',
            kind: 'note',
            favorite: false,
            canRename: true,
            canMove: true,
          },
        ],
      },
    ]);
  });
});

describe('flattenVisibleTree + expandedIdsFromCollapsedPaths', () => {
  it('hides children of collapsed folders and derives expanded ids from paths', () => {
    const items = [
      {
        id: 'fld_a',
        name: 'Archive',
        kind: 'folder' as const,
        path: '/fld_a',
        children: [{ id: 'note_1', name: 'Alpha', kind: 'note' as const }],
      },
    ];

    expect(flattenVisibleTree(items, new Set()).map((row) => row.id)).toEqual(['fld_a']);
    expect(flattenVisibleTree(items, new Set(['fld_a'])).map((row) => row.id)).toEqual([
      'fld_a',
      'note_1',
    ]);

    const entries = collectFolderEntries(items);
    expect(entries).toEqual([{ id: 'fld_a', path: '/fld_a' }]);
    expect(expandedIdsFromCollapsedPaths(entries, new Set(['/fld_a']))).toEqual(new Set());
    expect(expandedIdsFromCollapsedPaths(entries, new Set())).toEqual(new Set(['fld_a']));
  });

  it('resolves favorite from isFavorite, is_favorite, or metadata.isFavorite', () => {
    const root = folder({
      name: '',
      path: '/',
      resources: [
        { id: 'n1', name: 'A', type: 'note', isFavorite: true },
        { id: 'n2', name: 'B', type: 'note', is_favorite: true },
        { id: 'n3', name: 'C', type: 'note', metadata: { isFavorite: true } },
        { id: 'n4', name: 'D', type: 'note' },
      ],
    });
    const mapped = mapWorkspaceTreeFolder(root);
    expect(mapped.map((item) => [item.id, item.favorite])).toEqual([
      ['n1', true],
      ['n2', true],
      ['n3', true],
      ['n4', false],
    ]);
  });
});
