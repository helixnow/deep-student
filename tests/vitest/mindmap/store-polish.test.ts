import { afterEach, describe, expect, it } from 'vitest';

import { useMindMapStore } from '@/features/mindmap/store/mindmapStore';
import { markdownListToNodes } from '@/features/mindmap/utils/pasteMarkdown';
import { findNodeById } from '@/features/mindmap/utils/node/find';
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
