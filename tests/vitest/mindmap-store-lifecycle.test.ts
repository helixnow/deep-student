import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMindMapStore } from '@/components/mindmap/store/mindmapStore';
import type { MindMapDocument } from '@/components/mindmap/types';

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

  it('deduplicates sync draft persistence by document version', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
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

    setItemSpy.mockRestore();
  });
});
