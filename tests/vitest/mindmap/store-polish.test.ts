import { afterEach, describe, expect, it } from 'vitest';

import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import { markdownListToNodes } from '@/features/mindmap/utils/pasteMarkdown';
import { createNode } from '@/features/mindmap/utils/node/create';
import { findNodeById } from '@/features/mindmap/utils/node/find';
import { updateNode as updateNodeInTree } from '@/features/mindmap/utils/node/update';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';

function createDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_test',
      text: 'Root',
      children: [
        {
          id: 'node_a',
          text: 'HelloWorld',
          children: [{ id: 'node_a1', text: 'A1', children: [] }],
        },
        {
          id: 'node_b',
          text: 'Beta',
          children: [
            {
              id: 'node_b1',
              text: 'B1',
              children: [{ id: 'node_b1a', text: 'B1a', children: [] }],
            },
          ],
        },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function createFlatDocument(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_flat',
      text: 'Root',
      children: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id.toUpperCase(), children: [] })),
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function createWideDocument(childCount: number): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root_wide',
      text: 'Root',
      children: Array.from({ length: childCount }, (_, index) => ({
        id: `wide_${index}`,
        text: `${index}`,
        children: [],
      })),
    },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

function seedStore(document: MindMapDocument): void {
  useMindMapStore.setState({
    mindmapId: null,
    metadata: null,
    document: JSON.parse(JSON.stringify(document)) as MindMapDocument,
    focusedNodeId: 'node_a',
    editingNodeId: null,
    selection: [],
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: false,
    isSaving: false,
    lastSavedAt: null,
    _documentVersion: 0,
    hideCompleted: false,
    searchFilterMode: false,
    viewports: {},
  });
}

afterEach(() => {
  useMindMapStore.getState().reset();
});

describe('mindmap store polish APIs', () => {
  it('splitNode keeps prefix and inserts suffix as next sibling; subtree stays', () => {
    seedStore(createDocument());
    const newId = useMindMapStore.getState().splitNode('node_a', 5);
    expect(newId).toBeTruthy();

    const state = useMindMapStore.getState();
    expect(state.isDirty).toBe(true);
    expect(state.history.past).toHaveLength(1);

    const siblings = state.document.root.children;
    expect(siblings.map((n) => n.id)).toEqual(['node_a', newId, 'node_b']);
    expect(siblings[0].text).toBe('Hello');
    expect(siblings[1].text).toBe('World');
    expect(siblings[0].children.map((n) => n.id)).toEqual(['node_a1']);
    expect(siblings[1].children).toHaveLength(0);
  });

  it('mergeWithPrevious joins into previous sibling and returns cursor offset', () => {
    seedStore(createDocument());
    const result = useMindMapStore.getState().mergeWithPrevious('node_b');
    expect(result).toEqual({ mergedIntoId: 'node_a', cursorOffset: 10 });

    const state = useMindMapStore.getState();
    expect(state.document.root.children).toHaveLength(1);
    const a = state.document.root.children[0];
    expect(a.id).toBe('node_a');
    expect(a.text).toBe('HelloWorldBeta');
    expect(a.children.map((n) => n.id)).toEqual(['node_a1', 'node_b1']);
    expect(state.history.past).toHaveLength(1);
  });

  it('mergeWithPrevious refuses root', () => {
    seedStore(createDocument());
    expect(useMindMapStore.getState().mergeWithPrevious('root_test')).toBeNull();
    expect(useMindMapStore.getState().history.past).toHaveLength(0);
  });

  it('mergeWithPrevious into parent splices children at original slot', () => {
    seedStore(createDocument());
    // node_a is first child of root → merge into root
    const result = useMindMapStore.getState().mergeWithPrevious('node_a');
    expect(result?.mergedIntoId).toBe('root_test');

    const root = useMindMapStore.getState().document.root;
    // A1 takes A's slot before B (not appended after B)
    expect(root.children.map((n) => n.id)).toEqual(['node_a1', 'node_b']);
    expect(root.text).toBe('RootHelloWorld');
  });

  it('setCurrentView does not mark dirty', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setCurrentView('outline');
    expect(useMindMapStore.getState().isDirty).toBe(false);
    expect(useMindMapStore.getState().currentView).toBe('outline');
  });

  it('collapseToDepth(1) folds deeper nodes in one history step', () => {
    seedStore(createDocument());
    useMindMapStore.getState().collapseToDepth(1);

    const root = useMindMapStore.getState().document.root;
    expect(root.collapsed).toBeFalsy();
    expect(findNodeById(root, 'node_a')!.collapsed).toBe(true);
    expect(findNodeById(root, 'node_b')!.collapsed).toBe(true);
    expect(findNodeById(root, 'node_b1')!.collapsed).toBe(true);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
  });

  it('pasteMarkdownChildren attaches parsed forest under target', () => {
    seedStore(createDocument());
    useMindMapStore.getState().pasteMarkdownChildren(
      'node_a',
      '- parent\n  - child\n- sibling'
    );

    const a = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    // original a1 + 2 pasted roots
    expect(a.children).toHaveLength(3);
    expect(a.children[1].text).toBe('parent');
    expect(a.children[1].children[0].text).toBe('child');
    expect(a.children[2].text).toBe('sibling');
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
  });

  it('setCurrentView preserves viewports', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setViewViewport('outline', { scrollTop: 120 });
    useMindMapStore.getState().setViewViewport('mindmap', { x: 10, y: 20, zoom: 1.5 });
    useMindMapStore.getState().setCurrentView('outline');
    useMindMapStore.getState().setCurrentView('mindmap');

    expect(useMindMapStore.getState().viewports).toEqual({
      outline: { scrollTop: 120 },
      mindmap: { x: 10, y: 20, zoom: 1.5 },
    });
  });

  it('setCurrentView keeps blankedRanges, revealedBlanks and viewRootId', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addBlankRange('node_a', { start: 0, end: 5 });
    useMindMapStore.getState().setReciteMode(true);
    useMindMapStore.getState().revealBlank('node_a', 0);
    useMindMapStore.getState().setViewRootId('node_b');

    useMindMapStore.getState().setCurrentView('outline');
    useMindMapStore.getState().setCurrentView('mindmap');

    const state = useMindMapStore.getState();
    expect(findNodeById(state.document.root, 'node_a')!.blankedRanges).toEqual([
      { start: 0, end: 5 },
    ]);
    expect(state.revealedBlanks.node_a?.[0]).toBe(true);
    expect(state.viewRootId).toBe('node_b');
    expect(state.reciteMode).toBe(true);
  });

  it('setViewRootId focuses a branch and clears on root/null', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setViewRootId('node_a');
    expect(useMindMapStore.getState().viewRootId).toBe('node_a');

    useMindMapStore.getState().setViewRootId('root_test');
    expect(useMindMapStore.getState().viewRootId).toBeNull();

    useMindMapStore.getState().setViewRootId('missing');
    expect(useMindMapStore.getState().viewRootId).toBeNull();
  });

  it('toggleCompleted flips multiple nodes in one history entry', () => {
    seedStore(createDocument());
    useMindMapStore.getState().toggleCompleted(['node_a', 'node_b']);
    const root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'node_a')!.completed).toBe(true);
    expect(findNodeById(root, 'node_b')!.completed).toBe(true);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    useMindMapStore.getState().toggleCompleted(['node_a']);
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a')!.completed).toBe(
      false
    );
  });

  it('createNode / addNode omit completed so new nodes are not tasks by default', () => {
    const created = createNode({ text: 'fresh' });
    expect(Object.prototype.hasOwnProperty.call(created, 'completed')).toBe(false);

    seedStore(createDocument());
    const id = useMindMapStore.getState().addNode('root_test');
    const node = findNodeById(useMindMapStore.getState().document.root, id)!;
    expect(node).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(node, 'completed')).toBe(false);
  });

  it('updateNode deletes optional fields when patch value is undefined', () => {
    seedStore(createDocument());
    useMindMapStore.getState().updateNode('node_a', { completed: true });
    expect(findNodeById(useMindMapStore.getState().document.root, 'node_a')!.completed).toBe(true);

    useMindMapStore.getState().updateNode('node_a', { completed: undefined });
    const node = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(Object.prototype.hasOwnProperty.call(node, 'completed')).toBe(false);

    // 不可变工具路径同样支持 unset
    const tree = updateNodeInTree(createDocument().root, 'node_a', { completed: true });
    const cleared = updateNodeInTree(tree, 'node_a', { completed: undefined });
    expect(Object.prototype.hasOwnProperty.call(findNodeById(cleared, 'node_a')!, 'completed')).toBe(
      false,
    );
  });

  it('batch indent/outdent preserve sibling order and undo in one step', () => {
    seedStore(createFlatDocument());
    useMindMapStore.getState().indentNodes(['b', 'c']);
    let root = useMindMapStore.getState().document.root;
    expect(root.children.map((child) => child.id)).toEqual(['a', 'd']);
    expect(findNodeById(root, 'a')?.children.map((child) => child.id)).toEqual(['b', 'c']);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().document.root.children.map((child) => child.id)).toEqual([
      'a', 'b', 'c', 'd',
    ]);

    const nested = createFlatDocument();
    nested.root.children = [
      {
        id: 'parent',
        text: 'Parent',
        children: nested.root.children.slice(0, 3),
      },
      nested.root.children[3],
    ];
    seedStore(nested);
    useMindMapStore.getState().outdentNodes(['b', 'c']);
    root = useMindMapStore.getState().document.root;
    expect(root.children.map((child) => child.id)).toEqual(['parent', 'b', 'c', 'd']);
    expect(findNodeById(root, 'parent')?.children.map((child) => child.id)).toEqual(['a']);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
  });

  it('group move preserves order and creates one undo entry', () => {
    seedStore(createFlatDocument());
    expect(useMindMapStore.getState().moveNodes(['b', 'c'], 'root_flat', 4)).toBe(true);
    expect(useMindMapStore.getState().document.root.children.map((child) => child.id)).toEqual([
      'a', 'd', 'b', 'c',
    ]);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().document.root.children.map((child) => child.id)).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('hideCompleted prunes newly hidden selections in the same transaction', () => {
    seedStore(createFlatDocument());
    useMindMapStore.getState().setHideCompleted(true);
    useMindMapStore.getState().setSelection(['b']);
    useMindMapStore.getState().setFocusedNodeId('b');
    useMindMapStore.getState().toggleCompleted(['b']);
    expect(useMindMapStore.getState().selection).toEqual([]);
    expect(useMindMapStore.getState().focusedNodeId).toBe('root_flat');
  });

  it('deleting a selected ancestor clears descendant interaction state', () => {
    seedStore(createDocument());
    useMindMapStore.setState({
      selection: ['node_a', 'node_a1'],
      focusedNodeId: 'node_a1',
      editingNodeId: 'node_a1',
      editingNoteNodeId: null,
    });
    useMindMapStore.getState().deleteNodes(['node_a', 'node_a1']);
    const state = useMindMapStore.getState();
    expect(state.selection).toEqual([]);
    expect(state.focusedNodeId).toBe('root_test');
    expect(state.editingNodeId).toBeNull();
  });

  it('pastes plain text lines in one transaction and one undo step', () => {
    seedStore(createFlatDocument());
    useMindMapStore.getState().pasteTextChildren('root_flat', [' first ', '', 'second']);
    const state = useMindMapStore.getState();
    expect(state.document.root.children.slice(-2).map((node) => node.text)).toEqual([
      'first',
      'second',
    ]);
    expect(state.history.past).toHaveLength(1);
    expect(state._documentVersion).toBe(1);

    state.undo();
    expect(useMindMapStore.getState().document.root.children.map((node) => node.id)).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('rejects non-finite viewport values and clamps zoom before persistence', () => {
    seedStore(createDocument());
    useMindMapStore.getState().setViewViewport('mindmap', { x: 12, y: -8, zoom: 1.5 });
    useMindMapStore.getState().setViewViewport('mindmap', {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      zoom: Number.NaN,
    });
    expect(useMindMapStore.getState().viewports.mindmap).toEqual({
      x: 12,
      y: -8,
      zoom: 1.5,
    });

    useMindMapStore.getState().setViewViewport('mindmap', { zoom: 99 });
    expect(useMindMapStore.getState().viewports.mindmap?.zoom).toBe(2);
  });

  it('pasteNodes allows exactly 10k nodes and rejects 10,001 atomically', () => {
    seedStore(createWideDocument(9_998));
    useMindMapStore.setState({
      clipboard: {
        sourceOperation: 'copy',
        nodes: [{ id: 'clipboard_leaf', text: 'leaf', children: [] }],
      },
    });
    useMindMapStore.getState().pasteNodes('root_wide');
    expect(useMindMapStore.getState().document.root.children).toHaveLength(9_999);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    seedStore(createWideDocument(9_999));
    useMindMapStore.setState({
      clipboard: {
        sourceOperation: 'copy',
        nodes: [{ id: 'clipboard_overflow', text: 'overflow', children: [] }],
      },
    });
    const before = useMindMapStore.getState();
    useMindMapStore.getState().pasteNodes('root_wide');
    const after = useMindMapStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.history.past).toHaveLength(0);
    expect(after._documentVersion).toBe(0);
    expect(after.isDirty).toBe(false);
    expect(after.clipboard).toBe(before.clipboard);
  });

  it('pasteNodes rejects a subtree that would reach depth 100', () => {
    const deep = createFlatDocument();
    let current = deep.root;
    current.children = [];
    for (let depth = 1; depth <= 99; depth++) {
      const child = { id: `deep_${depth}`, text: `${depth}`, children: [] as MindMapNode[] };
      current.children = [child];
      current = child;
    }
    seedStore(deep);
    useMindMapStore.setState({
      clipboard: {
        sourceOperation: 'copy',
        nodes: [{ id: 'too_deep', text: 'too deep', children: [] }],
      },
    });
    const before = useMindMapStore.getState().document;
    useMindMapStore.getState().pasteNodes('deep_99');
    expect(useMindMapStore.getState().document).toBe(before);
    expect(useMindMapStore.getState().history.past).toHaveLength(0);
  });
});

describe('markdownListToNodes', () => {
  it('parses headings and indented lists into a nested forest', () => {
    // #=0, ##=1 → Section 成为 Title 的子节点；列表相对最近标题偏移
    const forest = markdownListToNodes('# Title\n- a\n  - b\n## Section\n- c');
    expect(forest).toHaveLength(1);
    expect(forest[0].text).toBe('Title');
    expect(forest[0].children[0].text).toBe('a');
    expect(forest[0].children[0].children[0].text).toBe('b');
    expect(forest[0].children[1].text).toBe('Section');
    expect(forest[0].children[1].children[0].text).toBe('c');
  });
});
