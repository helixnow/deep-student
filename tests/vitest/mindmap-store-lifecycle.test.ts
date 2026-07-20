import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/features/mindmap/types';

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_test',
      text: 'Root',
      children: [
        {
          id: 'node_a',
          text: 'A',
          children: [
            {
              id: 'node_a1',
              text: 'A1',
              children: [],
            },
          ],
        },
        {
          id: 'node_b',
          text: 'B',
          children: [],
        },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function seedStore(document: MindMapDocument): void {
  useMindMapStore.setState({
    mindmapId: null,
    metadata: null,
    document: JSON.parse(JSON.stringify(document)),
    focusedNodeId: 'node_a',
    editingNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: false,
    isSaving: false,
    lastSavedAt: null,
  });
}

afterEach(() => {
  useMindMapStore.getState().reset();
});

describe('mindmap store lifecycle guards', () => {
  it('deduplicates ancestor/descendant selection when copying', () => {
    seedStore(createDocument());

    useMindMapStore.getState().copyNodes(['node_a', 'node_a1']);

    const clipboard = useMindMapStore.getState().clipboard;
    expect(clipboard?.sourceOperation).toBe('copy');
    expect(clipboard?.nodes).toHaveLength(1);
    expect(clipboard?.nodes[0].id).toBe('node_a');
    expect(clipboard?.nodes[0].children).toHaveLength(1);
  });

  it('cuts multi-selection as one transaction and supports single-step undo', () => {
    seedStore(createDocument());

    useMindMapStore.getState().cutNodes(['node_a', 'node_a1']);

    const stateAfterCut = useMindMapStore.getState();
    expect(stateAfterCut.document.root.children.map((node) => node.id)).toEqual(['node_b']);
    expect(stateAfterCut.clipboard?.nodes).toHaveLength(1);

    stateAfterCut.undo();

    const stateAfterUndo = useMindMapStore.getState();
    expect(stateAfterUndo.document.root.children.map((node) => node.id)).toEqual(['node_a', 'node_b']);
  });

  it('deletes multi-selection in one undo step', () => {
    seedStore(createDocument());

    useMindMapStore.getState().deleteNodes(['node_a', 'node_a1', 'node_b']);

    const stateAfterDelete = useMindMapStore.getState();
    expect(stateAfterDelete.document.root.children).toHaveLength(0);

    stateAfterDelete.undo();

    const stateAfterUndo = useMindMapStore.getState();
    expect(stateAfterUndo.document.root.children.map((node) => node.id)).toEqual(['node_a', 'node_b']);
  });

  it('reorders within same parent without index drift', () => {
    seedStore({
      ...createDocument(),
      root: {
        ...createDocument().root,
        children: [
          ...createDocument().root.children,
          { id: 'node_c', text: 'C', children: [] },
        ],
      },
    });

    useMindMapStore.getState().moveNode('node_a', 'root_test', 2);

    const stateAfterMove = useMindMapStore.getState();
    expect(stateAfterMove.document.root.children.map((node) => node.id)).toEqual([
      'node_b',
      'node_a',
      'node_c',
    ]);
  });

  it('does not drop node when move target parent does not exist', () => {
    seedStore(createDocument());

    useMindMapStore.getState().moveNode('node_a', 'node_missing_parent', 0);

    const stateAfterMove = useMindMapStore.getState();
    expect(stateAfterMove.document.root.children.map((node) => node.id)).toEqual(['node_a', 'node_b']);
  });

  it('moves a canvas multi-selection as one undoable transaction', () => {
    seedStore({
      ...createDocument(),
      root: {
        ...createDocument().root,
        children: [
          ...createDocument().root.children,
          { id: 'node_c', text: 'C', children: [] },
        ],
      },
    });

    expect(useMindMapStore.getState().moveNodes(['node_a', 'node_b'], 'node_c', 0)).toBe(true);
    expect(useMindMapStore.getState().document.root.children.map((node) => node.id)).toEqual(['node_c']);
    expect(useMindMapStore.getState().document.root.children[0].children.map((node) => node.id)).toEqual([
      'node_a',
      'node_b',
    ]);

    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().document.root.children.map((node) => node.id)).toEqual([
      'node_a',
      'node_b',
      'node_c',
    ]);
  });

  it('restores selection / focus / viewRoot snapshot on undo and prunes them on redo', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setSelection(['node_a']);
    useMindMapStore.getState().setViewRootId('node_a');

    useMindMapStore.getState().deleteNodes(['node_a']);
    const afterDelete = useMindMapStore.getState();
    expect(afterDelete.selection).toEqual([]);
    expect(afterDelete.viewRootId).toBeNull();

    afterDelete.undo();
    const afterUndo = useMindMapStore.getState();
    expect(afterUndo.document.root.children.map((node) => node.id)).toEqual(['node_a', 'node_b']);
    expect(afterUndo.selection).toEqual(['node_a']);
    expect(afterUndo.viewRootId).toBe('node_a');
    expect(afterUndo.focusedNodeId).toBe('node_a');

    afterUndo.redo();
    const afterRedo = useMindMapStore.getState();
    expect(afterRedo.document.root.children.map((node) => node.id)).toEqual(['node_b']);
    // redo 恢复 undo 前的 UI 状态：已删节点不会残留在 selection / viewRoot
    expect(afterRedo.selection).toEqual([]);
    expect(afterRedo.viewRootId).toBeNull();
  });

  it('coalesces rapid text edits on the same node into one undo step', () => {
    seedStore(createDocument());
    useMindMapStore.getState().updateNode('node_a', { text: 'A-1' });
    useMindMapStore.getState().updateNode('node_a', { text: 'A-12' });
    useMindMapStore.getState().updateNode('node_a', { text: 'A-123' });

    const state = useMindMapStore.getState();
    expect(state.history.past).toHaveLength(1);

    state.undo();
    const rootAfterUndo = useMindMapStore.getState().document.root;
    expect(rootAfterUndo.children[0].text).toBe('A');
  });

  it('does not coalesce structural patches or edits on different nodes', () => {
    seedStore(createDocument());
    useMindMapStore.getState().updateNode('node_a', { text: 'A-1' });
    useMindMapStore.getState().updateNode('node_b', { text: 'B-1' });
    expect(useMindMapStore.getState().history.past).toHaveLength(2);

    seedStore(createDocument());
    useMindMapStore.getState().updateNode('node_a', { completed: true });
    useMindMapStore.getState().updateNode('node_a', { completed: undefined });
    expect(useMindMapStore.getState().history.past).toHaveLength(2);
  });

  it('marks dirty when only layout / style config changes', () => {
    seedStore(createDocument());
    expect(useMindMapStore.getState().isDirty).toBe(false);

    useMindMapStore.getState().setLayoutId('balanced');
    expect(useMindMapStore.getState().isDirty).toBe(true);
    expect(useMindMapStore.getState().history.past).toHaveLength(0);

    seedStore(createDocument());
    useMindMapStore.getState().setStyleId('colorful');
    expect(useMindMapStore.getState().isDirty).toBe(true);

    // 同值调用不重复标脏（seedStore 不重置布局字段，取当前值再设一次）
    seedStore(createDocument());
    useMindMapStore.getState().setLayoutId(useMindMapStore.getState().layoutId);
    expect(useMindMapStore.getState().isDirty).toBe(false);
  });

  it('stamps copiedAt on copy and pastes as sibling-after when requested', () => {
    seedStore(createDocument());
    useMindMapStore.getState().copyNodes(['node_b']);
    expect(useMindMapStore.getState().clipboard?.copiedAt).toBeTypeOf('number');

    useMindMapStore.getState().pasteNodes('node_a', 'sibling-after');
    const children = useMindMapStore.getState().document.root.children;
    expect(children).toHaveLength(3);
    expect(children[0].id).toBe('node_a');
    expect(children[1].text).toBe('B');
    expect(children[1].id).not.toBe('node_b');
    expect(children[2].id).toBe('node_b');
  });

  it('selectAllVisible respects collapse state and excludes the root', () => {
    seedStore(createDocument());
    useMindMapStore.getState().toggleCollapse('node_a');
    useMindMapStore.getState().selectAllVisible();
    expect(useMindMapStore.getState().selection).toEqual(['node_a', 'node_b']);

    useMindMapStore.getState().toggleCollapse('node_a');
    useMindMapStore.getState().selectAllVisible();
    expect(useMindMapStore.getState().selection).toEqual(['node_a', 'node_a1', 'node_b']);
  });

  it('replaceInMindMap rewrites matches in one history entry and reports count', () => {
    seedStore(createDocument());
    const replaced = useMindMapStore.getState().replaceInMindMap('a1', 'X');
    expect(replaced).toBe(1);

    const state = useMindMapStore.getState();
    expect(state.document.root.children[0].children[0].text).toBe('X');
    expect(state.history.past).toHaveLength(1);

    expect(useMindMapStore.getState().replaceInMindMap('missing-token', 'Y')).toBe(0);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    state.undo();
    expect(useMindMapStore.getState().document.root.children[0].children[0].text).toBe('A1');
  });

  it('cutNodes exits focus mode when the focused root is cut (B2)', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setViewRootId('node_a');
    expect(useMindMapStore.getState().viewRootId).toBe('node_a');

    useMindMapStore.getState().cutNodes(['node_a']);

    const state = useMindMapStore.getState();
    expect(state.viewRootId).toBeNull();
    expect(state.clipboard?.sourceOperation).toBe('cut');
    expect(state.document.root.children.map((node) => node.id)).toEqual(['node_b']);
  });

  it('mergeWithPrevious prunes associations pointing at the merged node (B1)', () => {
    const document = createDocument();
    document.associations = [
      { id: 'assoc-1', source: 'node_b', target: 'node_a1' },
    ];
    seedStore(document);

    useMindMapStore.getState().mergeWithPrevious('node_b');

    // node_b 被并入 node_a 后，指向它的关联线应被剪枝（与 mergeNextIntoCurrent 对称）
    expect(useMindMapStore.getState().document.associations).toBeUndefined();
  });

  it('deleteNodes / cutNodes / merge share afterRemoveNodes cleanup for selection anchors', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setSelection(['node_a', 'node_b']);
    useMindMapStore.getState().setSelectionAnchorId('node_a');

    useMindMapStore.getState().deleteNodes(['node_a']);

    const state = useMindMapStore.getState();
    expect(state.selection).toEqual(['node_b']);
    expect(state.selectionAnchorId).toBeNull();
  });

  it('mergeWithPrevious remaps the merged node inside the selection', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setSelection(['node_b']);
    const result = useMindMapStore.getState().mergeWithPrevious('node_b');
    expect(result?.mergedIntoId).toBe('node_a');
    expect(useMindMapStore.getState().selection).toEqual(['node_a']);
  });

  it('deduplicates sync draft persistence by document version', () => {
    const originalLocalStorage = window.localStorage;
    const setItemSpy = vi.fn();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: setItemSpy,
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(),
        length: 0,
      },
    });
    seedStore(createDocument());

    useMindMapStore.setState({
      mindmapId: 'mm_test_draft',
      isDirty: true,
      _documentVersion: 3,
      currentView: 'mindmap',
      focusedNodeId: 'root_test',
      layoutId: 'tree',
      layoutDirection: 'right',
      styleId: 'default',
      edgeType: 'bezier',
    });

    const state = useMindMapStore.getState();
    state.saveDraftSync();
    state.saveDraftSync();
    expect(setItemSpy).toHaveBeenCalledTimes(1);

    useMindMapStore.setState({ _documentVersion: 4 });
    useMindMapStore.getState().saveDraftSync();
    expect(setItemSpy).toHaveBeenCalledTimes(2);

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });
});
