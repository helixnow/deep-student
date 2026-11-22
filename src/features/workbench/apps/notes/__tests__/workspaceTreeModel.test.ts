import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import type { FolderTreeNode, VfsFolder } from '@/dstu/types/folder';
import { __resetContentDirtyRegistry, registerContentDirtyChecker } from '../../content/contentDirtyRegistry';
import { NOTES_WORKSPACE_TREE_ROOT_ID, type NotesWorkspaceTreeItem } from '../tree';
import {
  DEFAULT_SPLIT_LAYOUT,
  WORKSPACE_STORAGE_KEY,
  buildTree,
  computeNoteBreadcrumbs,
  computeTabCloseNextState,
  filterWorkspaceResources,
  findParentDeep,
  getFolderMembership,
  getRecentSearchResources,
  getTabContextMenuState,
  getTabSaveState,
  getWelcomeRecentResources,
  isCloseTabShortcut,
  matchWorkspaceWindowShortcut,
  mergeUpdatedResourceNode,
  parseInitialResource,
  parseSplitLayout,
  readPersistedWorkspaceState,
  reconcileTabsWithResources,
  reorderWorkspaceTabs,
  resolveCoherentPaneState,
  resolveExplorerDeleteTargets,
  resolveMoveDestinationFolderId,
  resolveRightSplitMainTabKey,
  resourceTypeFromIdPrefix,
  shouldCloseRightSplitOnTabClose,
  treeResourceKey,
  writePersistedWorkspaceState,
  type PersistedWorkspaceState,
  type WorkspaceTab,
} from '../workspaceTreeModel';

function makeFolder(overrides: Partial<VfsFolder> & { id: string; title: string }): VfsFolder {
  return {
    parentId: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeNode(overrides: Partial<DstuNode> & { id: string; name: string }): DstuNode {
  return {
    sourceId: overrides.id,
    path: `/${overrides.id}`,
    type: 'note',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('workspaceTreeModel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetContentDirtyRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeNoteBreadcrumbs', () => {
    it('returns only the note when it has no parent folder', () => {
      expect(computeNoteBreadcrumbs('note_1', [], new Map(), 'Linear Algebra')).toEqual([
        { id: 'note_1', title: 'Linear Algebra', type: 'note' },
      ]);
    });

    it('builds root-to-leaf folder trail followed by the note', () => {
      const folders: VfsFolder[] = [
        makeFolder({ id: 'fld_math', title: 'Math', parentId: null }),
        makeFolder({ id: 'fld_la', title: 'Linear Algebra', parentId: 'fld_math' }),
        makeFolder({ id: 'fld_ch1', title: 'Chapter 1', parentId: 'fld_la' }),
      ];
      const membership = new Map([[treeResourceKey('note', 'note_1'), 'fld_ch1']]);

      expect(computeNoteBreadcrumbs('note_1', folders, membership, 'Vectors')).toEqual([
        { id: 'fld_math', title: 'Math', type: 'folder' },
        { id: 'fld_la', title: 'Linear Algebra', type: 'folder' },
        { id: 'fld_ch1', title: 'Chapter 1', type: 'folder' },
        { id: 'note_1', title: 'Vectors', type: 'note' },
      ]);
    });

    it('skips reserved __system__ folders in the hierarchy', () => {
      const folders: VfsFolder[] = [
        makeFolder({ id: 'fld_sys', title: '__system__', parentId: null }),
        makeFolder({ id: 'fld_mem', title: 'Memory', parentId: 'fld_sys' }),
      ];
      const membership = new Map([[treeResourceKey('note', 'note_mem'), 'fld_mem']]);

      expect(computeNoteBreadcrumbs('note_mem', folders, membership, 'Profile')).toEqual([
        { id: 'fld_mem', title: 'Memory', type: 'folder' },
        { id: 'note_mem', title: 'Profile', type: 'note' },
      ]);
    });

    it('terminates safely on circular parent references', () => {
      const folders: VfsFolder[] = [
        makeFolder({ id: 'fld_a', title: 'A', parentId: 'fld_b' }),
        makeFolder({ id: 'fld_b', title: 'B', parentId: 'fld_a' }),
      ];
      const membership = new Map([[treeResourceKey('note', 'note_cyc'), 'fld_a']]);

      expect(computeNoteBreadcrumbs('note_cyc', folders, membership, 'Cycle Note')).toEqual([
        { id: 'fld_b', title: 'B', type: 'folder' },
        { id: 'fld_a', title: 'A', type: 'folder' },
        { id: 'note_cyc', title: 'Cycle Note', type: 'note' },
      ]);
    });

    it('stops cleanly when an ancestor folder id is missing and supports raw nodeId lookup', () => {
      const folders: VfsFolder[] = [
        makeFolder({ id: 'fld_orphan', title: 'Orphan', parentId: 'fld_missing' }),
      ];
      const membership = new Map([['note_raw', 'fld_orphan']]);

      expect(computeNoteBreadcrumbs('note_raw', folders, membership, 'Draft')).toEqual([
        { id: 'fld_orphan', title: 'Orphan', type: 'folder' },
        { id: 'note_raw', title: 'Draft', type: 'note' },
      ]);
    });
  });

  describe('getFolderMembership & buildTree', () => {
    it('extracts note/mindmap folder membership recursively and ignores other types', () => {
      const treeNodes: FolderTreeNode[] = [
        {
          folder: makeFolder({ id: 'fld_root', title: 'Root' }),
          items: [
            { itemType: 'note', itemId: 'n1', sortOrder: 0 },
            { itemType: 'pdf', itemId: 'p1', sortOrder: 1 },
          ],
          children: [
            {
              folder: makeFolder({ id: 'fld_sub', title: 'Sub', parentId: 'fld_root' }),
              items: [{ itemType: 'mindmap', itemId: 'mm_1', sortOrder: 0 }],
              children: [],
            },
          ],
        },
      ];

      const membership = getFolderMembership(treeNodes);
      expect(membership.get('note:n1')).toBe('fld_root');
      expect(membership.get('mindmap:mm_1')).toBe('fld_sub');
      expect(membership.has('pdf:p1')).toBe(false);
    });

    it('builds known and synthetic folders while hiding __system__', () => {
      const folders = [
        makeFolder({ id: 'fld_sys', title: '__system__' }),
        makeFolder({ id: 'fld_course', title: 'Courses', parentId: 'fld_sys' }),
      ];
      const nodes = [
        makeNode({ id: 'n1', name: 'Lecture 1', path: '/n1' }),
        makeNode({ id: 'n2', name: 'Synthetic', path: '/archive/n2' }),
      ];
      const membership = new Map([['note:n1', 'fld_course']]);

      const root = buildTree(nodes, folders, membership);
      expect(root.folders.get('id:fld_course')?.resources.map((n) => n.id)).toEqual(['n1']);
      expect(root.folders.get('path:archive')?.resources.map((n) => n.id)).toEqual(['n2']);
    });
  });

  describe('findParentDeep & resolveMoveDestinationFolderId', () => {
    const items: NotesWorkspaceTreeItem[] = [
      {
        id: 'fld_1',
        name: 'Folder 1',
        kind: 'folder',
        path: '/fld_1',
        children: [
          { id: 'note_1', name: 'Note 1', kind: 'note', path: '/note_1' },
        ],
      },
      {
        id: 'synth:/virtual',
        name: 'Virtual',
        kind: 'folder',
        path: '/virtual',
        children: [
          { id: 'note_2', name: 'Note 2', kind: 'note', path: '/virtual/note_2' },
        ],
      },
    ];

    it('finds parent ids for nested items and returns null for synthetic parents', () => {
      expect(findParentDeep(items, 'note_1')).toEqual({ found: true, parentId: 'fld_1' });
      expect(findParentDeep(items, 'note_2')).toEqual({ found: true, parentId: null });
      expect(findParentDeep(items, 'missing')).toEqual({ found: false, parentId: null });
    });

    it('resolves drop destinations for root, stable folders, synthetic folders, and siblings', () => {
      expect(resolveMoveDestinationFolderId(items, NOTES_WORKSPACE_TREE_ROOT_ID, 'inside')).toBeUndefined();
      expect(resolveMoveDestinationFolderId(items, 'fld_1', 'inside')).toBe('fld_1');
      expect(resolveMoveDestinationFolderId(items, 'synth:/virtual', 'inside')).toBeNull();
      expect(resolveMoveDestinationFolderId(items, 'note_1', 'after')).toBe('fld_1');
      expect(resolveMoveDestinationFolderId(items, 'note_2', 'before')).toBeUndefined();
      expect(resolveMoveDestinationFolderId(items, 'nonexistent', 'before')).toBeNull();
    });
  });

  describe('parseSplitLayout, parseInitialResource & resourceTypeFromIdPrefix', () => {
    it('validates split layout bounds and sum', () => {
      expect(parseSplitLayout([40, 60])).toEqual([40, 60]);
      expect(parseSplitLayout([20, 80])).toEqual(DEFAULT_SPLIT_LAYOUT);
      expect(parseSplitLayout([40, 40])).toEqual(DEFAULT_SPLIT_LAYOUT);
      expect(parseSplitLayout('bad')).toEqual(DEFAULT_SPLIT_LAYOUT);
    });

    it('infers resource type from id prefixes and launch payloads', () => {
      expect(resourceTypeFromIdPrefix('mm_abc')).toBe('mindmap');
      expect(resourceTypeFromIdPrefix('note_abc')).toBe('note');
      expect(resourceTypeFromIdPrefix('unknown_1')).toBeNull();

      expect(parseInitialResource('mm_123', undefined)).toEqual({ type: 'mindmap', id: 'mm_123' });
      expect(parseInitialResource('custom_1', undefined)).toEqual({ type: 'note', id: 'custom_1' });
      expect(parseInitialResource(null, { resourceType: 'mindmap', resourceId: 'm1' })).toEqual({
        type: 'mindmap',
        id: 'm1',
      });
      expect(parseInitialResource(null, undefined)).toBeNull();
    });
  });

  describe('persisted workspace state', () => {
    it('round-trips valid state and prevents rightTabKey from matching activeTabKey', () => {
      const state: PersistedWorkspaceState = {
        tabs: [
          { key: 'note:n1', type: 'note', id: 'n1', title: 'N1', pinned: true },
          { key: 'note:n2', type: 'note', id: 'n2', title: 'N2', pinned: false },
        ],
        activeTabKey: 'note:n2',
        rightTabKey: 'note:n2',
        focusedPane: 'right',
        splitLayout: [45, 55],
        backlinksOpen: true,
        explorerOpen: false,
        collapsedFolderPaths: ['/fld_1'],
      };
      writePersistedWorkspaceState(state);

      const restored = readPersistedWorkspaceState();
      expect(restored.rightTabKey).toBe('note:n2');
      expect(restored.activeTabKey).toBe('note:n1');
      expect(restored.focusedPane).toBe('right');
      expect(restored.splitLayout).toEqual([45, 55]);
      expect(restored.backlinksOpen).toBe(true);
      expect(restored.explorerOpen).toBe(false);
      expect(restored.collapsedFolderPaths).toEqual(['/fld_1']);
    });

    it('returns safe defaults when localStorage contains malformed JSON', () => {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, '{broken');
      expect(readPersistedWorkspaceState()).toEqual({
        tabs: [],
        activeTabKey: null,
        rightTabKey: null,
        focusedPane: 'main',
        splitLayout: DEFAULT_SPLIT_LAYOUT,
        backlinksOpen: false,
        explorerOpen: true,
        collapsedFolderPaths: [],
      });
    });
  });

  describe('tab & resource helpers', () => {
    it('reorders tabs before and after target', () => {
      const tabs: WorkspaceTab[] = [
        { key: 'note:1', type: 'note', id: '1', title: 'One' },
        { key: 'note:2', type: 'note', id: '2', title: 'Two' },
        { key: 'note:3', type: 'note', id: '3', title: 'Three' },
      ];
      expect(reorderWorkspaceTabs(tabs, 'note:1', 'note:3', 'after').map((t) => t.key)).toEqual([
        'note:2',
        'note:3',
        'note:1',
      ]);
      expect(reorderWorkspaceTabs(tabs, 'note:3', 'note:2', 'before').map((t) => t.key)).toEqual([
        'note:1',
        'note:3',
        'note:2',
      ]);
    });

    it('filters resources by search query and tags', () => {
      const nodes = [
        makeNode({ id: 'n1', name: 'Calculus', metadata: { tags: ['math'] } }),
        makeNode({ id: 'n2', name: 'History', metadata: { tags: ['humanities'] } }),
      ];
      expect(filterWorkspaceResources(nodes, 'calc', []).map((n) => n.id)).toEqual(['n1']);
      expect(filterWorkspaceResources(nodes, '', ['humanities']).map((n) => n.id)).toEqual(['n2']);
    });

    it('computes recent search and welcome recents without duplicates', () => {
      const nodes = [
        makeNode({ id: 'n1', name: 'One', updatedAt: 10 }),
        makeNode({ id: 'n2', name: 'Two', updatedAt: 30 }),
        makeNode({ id: 'n3', name: 'Three', updatedAt: 20 }),
      ];
      const recents = getRecentSearchResources(
        [
          { key: 'note:n1', type: 'note', id: 'n1' },
          { key: 'note:n3', type: 'note', id: 'n3' },
          { key: 'note:n1', type: 'note', id: 'n1' },
        ],
        nodes,
      );
      expect(recents.map((n) => n.id)).toEqual(['n1', 'n3']);

      const welcome = getWelcomeRecentResources(recents, nodes, 3);
      expect(welcome.map((n) => n.id)).toEqual(['n1', 'n3', 'n2']);
    });

    it('reports note save state from contentDirtyRegistry', () => {
      const tab: WorkspaceTab = { key: 'note:n1', type: 'note', id: 'n1', title: 'Note' };
      expect(getTabSaveState(tab, 'win-1')).toBe('saved');
      const unregister = registerContentDirtyChecker('note', 'n1', () => true);
      expect(getTabSaveState(tab, 'win-1')).toBe('dirty');
      unregister();
      expect(getTabSaveState(tab, 'win-1')).toBe('saved');
    });

    it('resolves split pane transitions, close transitions, and coherence', () => {
      const tabs: WorkspaceTab[] = [
        { key: 'note:1', type: 'note', id: '1', title: 'One', pinned: true },
        { key: 'note:2', type: 'note', id: '2', title: 'Two' },
        { key: 'note:3', type: 'note', id: '3', title: 'Three' },
      ];

      expect(resolveRightSplitMainTabKey(tabs, 'note:2', 'note:3', 'note:2')).toBe('note:3');
      expect(resolveCoherentPaneState(tabs, 'note:2', 'note:2', 'right')).toEqual({
        validRightKey: 'note:2',
        validActiveKey: 'note:1',
        validFocusedPane: 'right',
      });
      expect(shouldCloseRightSplitOnTabClose(tabs.slice(0, 2), 'note:1', 'note:2')).toBe(true);
      expect(shouldCloseRightSplitOnTabClose(tabs, 'note:1', 'note:3')).toBe(false);

      const closeState = computeTabCloseNextState(tabs, 'note:2', 'note:3', false);
      expect(closeState?.nextTabs.map((t) => t.key)).toEqual(['note:1', 'note:3']);
      expect(closeState?.neighborKey).toBe('note:1');

      const menuState = getTabContextMenuState(tabs, { key: 'note:2', x: 0, y: 0 });
      expect(menuState.target?.key).toBe('note:2');
      expect(menuState.canCloseOthers).toBe(true);
      expect(menuState.canCloseRight).toBe(true);
    });

    it('reconciles tabs with loaded resources and merges updated resource snapshots', () => {
      const n1 = makeNode({ id: '1', name: 'Renamed One', updatedAt: 10 });
      const tabs: WorkspaceTab[] = [
        { key: 'note:1', type: 'note', id: '1', title: 'Old One' },
        { key: 'note:gone', type: 'note', id: 'gone', title: 'Deleted' },
      ];
      expect(reconcileTabsWithResources(tabs, new Map([['1', n1]]))).toEqual([
        { key: 'note:1', type: 'note', id: '1', title: 'Renamed One' },
      ]);

      const list = [n1];
      // Stale snapshot returns same array reference
      expect(mergeUpdatedResourceNode(list, makeNode({ id: '1', name: 'Older', updatedAt: 5 }))).toBe(list);
      // Duplicate snapshot returns same array reference
      expect(mergeUpdatedResourceNode(list, makeNode({ id: '1', name: 'Renamed One', updatedAt: 10 }))).toBe(list);
      // Newer snapshot returns updated copy
      const updated = mergeUpdatedResourceNode(list, makeNode({ id: '1', name: 'Newer', updatedAt: 20 }));
      expect(updated).not.toBe(list);
      expect(updated[0].name).toBe('Newer');
    });

    it('resolves delete targets skipping synthetic folders and parses workspace shortcuts', () => {
      const resources = [makeNode({ id: 'note_1', name: 'Note 1' })];
      const targets = resolveExplorerDeleteTargets(
        [
          { id: 'fld_1', name: 'F1', kind: 'folder', path: '/fld_1' },
          { id: 'synth:/v', name: 'V', kind: 'folder', path: '/v' },
          { id: 'note_1', name: 'Note 1', kind: 'note', path: '/note_1' },
        ],
        resources,
      );
      expect(targets).toHaveLength(2);
      expect(targets[0].kind).toBe('folder');
      expect(targets[1].kind).toBe('resource');

      expect(isCloseTabShortcut(new KeyboardEvent('keydown', { key: 'w', metaKey: true }))).toBe(true);
      expect(isCloseTabShortcut(new KeyboardEvent('keydown', { key: 'w', metaKey: true, shiftKey: true }))).toBe(false);
      expect(matchWorkspaceWindowShortcut(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }), false)).toBe('quick-open');
      expect(matchWorkspaceWindowShortcut(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true }), false)).toBe('cycle-next');
      expect(matchWorkspaceWindowShortcut(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true }), false)).toBe('cycle-prev');
      expect(matchWorkspaceWindowShortcut(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true }), true)).toBeNull();
    });
  });
});
