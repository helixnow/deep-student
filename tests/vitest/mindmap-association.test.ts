import { afterEach, describe, expect, it } from 'vitest';

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

describe('mindmap associations', () => {
  it('adds / updates label / removes association via applyMutation (undoable)', () => {
    seedStore(createDocument());
    const store = useMindMapStore.getState();

    const id = store.addAssociation('node_a', 'node_b', '关联');
    expect(id).toBeTruthy();

    let doc = useMindMapStore.getState().document;
    expect(doc.associations).toHaveLength(1);
    expect(doc.associations?.[0]).toMatchObject({
      id,
      source: 'node_a',
      target: 'node_b',
      label: '关联',
    });

    useMindMapStore.getState().updateAssociationLabel(id!, '更新标签');
    doc = useMindMapStore.getState().document;
    expect(doc.associations?.[0].label).toBe('更新标签');

    useMindMapStore.getState().removeAssociation(id!);
    doc = useMindMapStore.getState().document;
    expect(doc.associations).toBeUndefined();

    useMindMapStore.getState().undo();
    doc = useMindMapStore.getState().document;
    expect(doc.associations).toHaveLength(1);
    expect(doc.associations?.[0].label).toBe('更新标签');

    useMindMapStore.getState().undo();
    doc = useMindMapStore.getState().document;
    expect(doc.associations?.[0].label).toBe('关联');

    useMindMapStore.getState().undo();
    doc = useMindMapStore.getState().document;
    expect(doc.associations).toBeUndefined();
  });

  it('rejects self-link, missing node, and undirected duplicate', () => {
    seedStore(createDocument());
    const store = useMindMapStore.getState();

    expect(store.addAssociation('node_a', 'node_a')).toBeNull();
    expect(store.addAssociation('node_a', 'missing')).toBeNull();

    const id = store.addAssociation('node_a', 'node_b');
    expect(id).toBeTruthy();
    expect(useMindMapStore.getState().addAssociation('node_b', 'node_a')).toBeNull();
    expect(useMindMapStore.getState().document.associations).toHaveLength(1);
  });

  it('cascades association cleanup when deleting nodes (including descendants)', () => {
    seedStore(createDocument());
    const store = useMindMapStore.getState();

    const id1 = store.addAssociation('node_a1', 'node_b');
    const id2 = store.addAssociation('node_a', 'node_b');
    expect(id1 && id2).toBeTruthy();
    expect(useMindMapStore.getState().document.associations).toHaveLength(2);

    // 删除父节点 A → A1 一并删除，两条关联都应清理
    useMindMapStore.getState().deleteNode('node_a');
    expect(useMindMapStore.getState().document.associations).toBeUndefined();

    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().document.associations).toHaveLength(2);
  });

  it('cascades on cutNodes and restores via undo', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addAssociation('node_a', 'node_b');
    useMindMapStore.getState().cutNodes(['node_b']);

    expect(useMindMapStore.getState().document.associations).toBeUndefined();

    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().document.associations).toHaveLength(1);
    expect(useMindMapStore.getState().document.root.children.map((n) => n.id)).toEqual([
      'node_a',
      'node_b',
    ]);
  });

  it('JSON serialize roundtrip preserves associations', () => {
    const doc: MindMapDocument = {
      ...createDocument(),
      associations: [
        {
          id: 'assoc_1',
          source: 'node_a',
          target: 'node_b',
          label: '跨分支',
          style: { strokeDasharray: '6 4' },
        },
      ],
    };

    const roundtrip = JSON.parse(JSON.stringify(doc)) as MindMapDocument;
    expect(roundtrip.associations).toEqual(doc.associations);
    expect(roundtrip.root.id).toBe('root_test');
  });
});
