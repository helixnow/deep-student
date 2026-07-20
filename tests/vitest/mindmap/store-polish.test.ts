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

  it('mergeNextIntoCurrent joins the next visible node in one history step', () => {
    seedStore(createDocument());
    const result = useMindMapStore.getState().mergeNextIntoCurrent('node_a', 'Draft');

    expect(result).toEqual({ mergedIntoId: 'node_a', cursorOffset: 5 });
    const state = useMindMapStore.getState();
    const nodeA = findNodeById(state.document.root, 'node_a')!;
    expect(nodeA.text).toBe('DraftA1');
    expect(nodeA.children).toHaveLength(0);
    expect(state.document.root.children.map((node) => node.id)).toEqual(['node_a', 'node_b']);
    expect(state.history.past).toHaveLength(1);
  });

  it('mergeNextIntoCurrent preserves source metadata and subtree', () => {
    const document = createDocument();
    const nodeA = document.root.children[0];
    const nodeB = document.root.children[1];
    nodeA.collapsed = true;
    nodeB.note = 'source note';
    nodeB.completed = true;
    nodeB.refs = [{ sourceId: 'resource-1', type: 'note', name: 'Resource' }];
    document.associations = [{ id: 'association-1', source: 'node_a', target: 'node_b' }];
    seedStore(document);

    const result = useMindMapStore.getState().mergeNextIntoCurrent('node_a');

    expect(result?.mergedIntoId).toBe('node_a');
    const merged = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(merged.text).toBe('HelloWorldBeta');
    expect(merged.note).toBe('source note');
    expect(merged.completed).toBe(true);
    expect(merged.refs).toEqual([{ sourceId: 'resource-1', type: 'note', name: 'Resource' }]);
    expect(merged.children.map((node) => node.id)).toEqual(['node_a1', 'node_b1']);
    expect(useMindMapStore.getState().document.associations).toBeUndefined();
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
  });

  it('mergeNextIntoCurrent can merge the first child into the root', () => {
    seedStore(createDocument());

    const result = useMindMapStore.getState().mergeNextIntoCurrent('root_test');

    expect(result).toEqual({ mergedIntoId: 'root_test', cursorOffset: 4 });
    const root = useMindMapStore.getState().document.root;
    expect(root.text).toBe('RootHelloWorld');
    expect(root.children.map((node) => node.id)).toEqual(['node_a1', 'node_b']);
  });

  it('mergeNextIntoCurrent accepts the next node from the filtered outline', () => {
    seedStore(createDocument());

    useMindMapStore.getState().mergeNextIntoCurrent('node_a', 'HelloWorld', 'node_b');

    const nodeA = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(nodeA.text).toBe('HelloWorldBeta');
    expect(nodeA.children.map((node) => node.id)).toEqual(['node_a1', 'node_b1']);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
  });

  it('mergeNextIntoCurrent does not fall through past the final filtered row', () => {
    seedStore(createDocument());

    expect(useMindMapStore.getState().mergeNextIntoCurrent('node_a', 'Draft', null)).toBeNull();
    expect(useMindMapStore.getState().document.root.children.map((node) => node.id)).toEqual([
      'node_a',
      'node_b',
    ]);
    expect(useMindMapStore.getState().history.past).toHaveLength(0);
  });

  it('pastes an editing draft and Markdown subtree in one undo step', () => {
    seedStore(createDocument());
    useMindMapStore.getState().pasteMarkdownChildren(
      'node_a',
      '- Parent\n  - Child',
      { currentText: 'Draft with trailing spaces  ' },
    );

    const pasted = useMindMapStore.getState();
    const target = findNodeById(pasted.document.root, 'node_a')!;
    expect(target.text).toBe('Draft with trailing spaces  ');
    expect(target.children.at(-1)?.text).toBe('Parent');
    expect(target.children.at(-1)?.children[0].text).toBe('Child');
    expect(pasted.history.past).toHaveLength(1);

    pasted.undo();
    const restored = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(restored.text).toBe('HelloWorld');
    expect(restored.children.map((node) => node.id)).toEqual(['node_a1']);
  });

  it('preserves blank ranges when structured paste does not change the title', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addBlankRange('node_a', { start: 0, end: 5 });
    useMindMapStore.getState().setReciteMode(true);
    useMindMapStore.getState().revealBlank('node_a', 0);

    useMindMapStore.getState().pasteMarkdownChildren(
      'node_a',
      '- Added child',
      { currentText: 'HelloWorld' },
    );

    const state = useMindMapStore.getState();
    expect(findNodeById(state.document.root, 'node_a')?.blankedRanges).toEqual([
      { start: 0, end: 5 },
    ]);
    expect(state.revealedBlanks.node_a?.[0]).toBe(true);
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

  it('outdentNodes adopts following siblings as children (Workflowy semantics)', () => {
    const nested = createFlatDocument();
    const [a, b, c, d] = nested.root.children;
    nested.root.children = [
      { id: 'parent', text: 'Parent', children: [a, b, c] },
      d,
    ];
    seedStore(nested);

    useMindMapStore.getState().outdentNodes(['b']);
    const root = useMindMapStore.getState().document.root;
    expect(root.children.map((child) => child.id)).toEqual(['parent', 'b', 'd']);
    expect(findNodeById(root, 'parent')?.children.map((child) => child.id)).toEqual(['a']);
    // 原后续同级 c 被提升节点 b 收养为子节点
    expect(findNodeById(root, 'b')?.children.map((child) => child.id)).toEqual(['c']);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    useMindMapStore.getState().undo();
    const restored = useMindMapStore.getState().document.root;
    expect(restored.children.map((child) => child.id)).toEqual(['parent', 'd']);
    expect(findNodeById(restored, 'parent')?.children.map((child) => child.id)).toEqual([
      'a', 'b', 'c',
    ]);
  });

  it('mergeWithPrevious scopeRootId resolves previous-visible inside the focused branch only', () => {
    seedStore(createDocument());
    // 专注在 node_b：node_b1 的上一可见是专注根自身，允许合并
    const scoped = useMindMapStore
      .getState()
      .mergeWithPrevious('node_b1', undefined, 'node_b');
    expect(scoped?.mergedIntoId).toBe('node_b');

    seedStore(createDocument());
    // 专注在 node_b1：自身是专注视图首行，范围内无上一可见 → 拒绝合并（不越界并入 node_b）
    expect(
      useMindMapStore.getState().mergeWithPrevious('node_b1', undefined, 'node_b1'),
    ).toBeNull();
    expect(useMindMapStore.getState().history.past).toHaveLength(0);
  });

  it('mergeWithPrevious honors the explicit previous visible row from the outline', () => {
    seedStore(createDocument());
    // 大纲可见列表里 node_b 的上一行是 node_a1（node_a 展开时），
    // 行首 Backspace 应并入视觉上方那一行，而不是上一同级 node_a
    const result = useMindMapStore
      .getState()
      .mergeWithPrevious('node_b', undefined, undefined, 'node_a1');
    expect(result).toEqual({ mergedIntoId: 'node_a1', cursorOffset: 2 });

    const root = useMindMapStore.getState().document.root;
    expect(root.children.map((n) => n.id)).toEqual(['node_a']);
    const a1 = findNodeById(root, 'node_a1')!;
    expect(a1.text).toBe('A1Beta');
    expect(a1.children.map((n) => n.id)).toEqual(['node_b1']);
  });

  it('mergeWithPrevious rejects when the outline reports no previous visible row', () => {
    seedStore(createDocument());
    expect(
      useMindMapStore.getState().mergeWithPrevious('node_b', undefined, undefined, null),
    ).toBeNull();
    expect(useMindMapStore.getState().history.past).toHaveLength(0);
  });

  it('mergeWithPrevious keeps blank ranges: target intact, source shifted', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addBlankRange('node_a', { start: 0, end: 5 }); // "Hello"
    useMindMapStore.getState().addBlankRange('node_b', { start: 0, end: 4 }); // "Beta"

    const result = useMindMapStore.getState().mergeWithPrevious('node_b');
    expect(result?.mergedIntoId).toBe('node_a');

    const merged = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(merged.text).toBe('HelloWorldBeta');
    expect(merged.blankedRanges).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 14 },
    ]);
  });

  it('mergeNextIntoCurrent keeps blank ranges across the join', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addBlankRange('node_a', { start: 5, end: 10 }); // "World"
    useMindMapStore.getState().addBlankRange('node_a1', { start: 0, end: 2 }); // "A1"

    const result = useMindMapStore.getState().mergeNextIntoCurrent('node_a');
    expect(result?.mergedIntoId).toBe('node_a');

    const merged = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(merged.text).toBe('HelloWorldA1');
    expect(merged.blankedRanges).toEqual([
      { start: 5, end: 10 },
      { start: 10, end: 12 },
    ]);
  });

  it('splitNode splits blank ranges at the boundary instead of clearing them', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addBlankRange('node_a', { start: 2, end: 8 }); // "lloWor"

    const newId = useMindMapStore.getState().splitNode('node_a', 5)!;
    const root = useMindMapStore.getState().document.root;
    const left = findNodeById(root, 'node_a')!;
    const right = findNodeById(root, newId)!;
    expect(left.text).toBe('Hello');
    expect(left.blankedRanges).toEqual([{ start: 2, end: 5 }]);
    expect(right.text).toBe('World');
    expect(right.blankedRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('duplicateNodes inserts deep copies after sources with fresh ids in one undo step', () => {
    const document = createDocument();
    document.root.children[0].style = { bgColor: '#fff' };
    document.root.children[0].blankedRanges = [{ start: 0, end: 5 }];
    seedStore(document);

    // 祖先/后代去重：只复制顶层 node_a
    const newIds = useMindMapStore.getState().duplicateNodes(['node_a', 'node_a1']);
    expect(newIds).toHaveLength(1);

    const state = useMindMapStore.getState();
    const rootChildren = state.document.root.children;
    expect(rootChildren.map((node) => node.id)).toEqual(['node_a', newIds![0], 'node_b']);

    const source = findNodeById(state.document.root, 'node_a')!;
    const clone = rootChildren[1];
    expect(clone.text).toBe('HelloWorld');
    expect(clone.children).toHaveLength(1);
    expect(clone.children[0].id).not.toBe('node_a1');
    expect(clone.style).toEqual({ bgColor: '#fff' });
    expect(clone.style).not.toBe(source.style);
    expect(clone.blankedRanges).toEqual([{ start: 0, end: 5 }]);
    expect(clone.blankedRanges).not.toBe(source.blankedRanges);
    expect(state.focusedNodeId).toBe(newIds![0]);
    expect(state.selection).toEqual(newIds);
    expect(state.history.past).toHaveLength(1);

    state.undo();
    expect(useMindMapStore.getState().document.root.children.map((node) => node.id)).toEqual([
      'node_a',
      'node_b',
    ]);

    // 根不可复制
    expect(useMindMapStore.getState().duplicateNodes(['root_test'])).toBeNull();
  });

  it('collapseSubtree / expandSubtree toggle a whole branch in one history step', () => {
    seedStore(createDocument());
    useMindMapStore.getState().collapseSubtree('node_b');

    let root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'node_b')!.collapsed).toBe(true);
    expect(findNodeById(root, 'node_b1')!.collapsed).toBe(true);
    // 叶子不写 collapsed，避免污染树快照
    expect(
      Object.prototype.hasOwnProperty.call(findNodeById(root, 'node_b1a')!, 'collapsed'),
    ).toBe(false);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    useMindMapStore.getState().expandSubtree('node_b');
    root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'node_b')!.collapsed).toBe(false);
    expect(findNodeById(root, 'node_b1')!.collapsed).toBe(false);
    expect(useMindMapStore.getState().history.past).toHaveLength(2);

    // 文档根自身保持展开
    useMindMapStore.getState().collapseSubtree('root_test');
    root = useMindMapStore.getState().document.root;
    expect(root.collapsed).toBeFalsy();
    expect(findNodeById(root, 'node_a')!.collapsed).toBe(true);
  });

  it('pasteMarkdownChildren position sibling-after inserts the forest after the target', () => {
    seedStore(createDocument());
    useMindMapStore.getState().pasteMarkdownChildren('node_a', '- one\n- two', {
      position: 'sibling-after',
    });

    const state = useMindMapStore.getState();
    expect(state.document.root.children.map((node) => node.text)).toEqual([
      'HelloWorld', 'one', 'two', 'Beta',
    ]);
    // 子树不受影响
    expect(
      findNodeById(state.document.root, 'node_a')!.children.map((node) => node.id),
    ).toEqual(['node_a1']);
    expect(state.history.past).toHaveLength(1);

    // 根无同级：回退为 child（保持兼容）
    seedStore(createDocument());
    useMindMapStore.getState().pasteMarkdownChildren('root_test', '- one', {
      position: 'sibling-after',
    });
    expect(useMindMapStore.getState().document.root.children.at(-1)?.text).toBe('one');
  });

  it('updateNode remaps blank ranges on text edits instead of clearing them all', () => {
    seedStore(createDocument());
    useMindMapStore.getState().addBlankRange('node_a', { start: 0, end: 5 }); // "Hello"

    // 末尾追加：区间位置不变
    useMindMapStore.getState().updateNode('node_a', { text: 'HelloWorld!' });
    let node = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(node.blankedRanges).toEqual([{ start: 0, end: 5 }]);

    // 整段改写：区间无法映射 → 清除
    useMindMapStore.getState().updateNode('node_a', { text: 'Rewritten entirely' });
    node = findNodeById(useMindMapStore.getState().document.root, 'node_a')!;
    expect(node.blankedRanges).toBeUndefined();
  });

  it('destroy is idempotent and public clearDraft removes the stored draft', () => {
    seedStore(createDocument());
    useMindMapStore.setState({ mindmapId: 'mm_pub_draft', isDirty: true, _documentVersion: 1 });
    useMindMapStore.getState().saveDraftSync();
    expect(window.localStorage.getItem('mindmap:draft:mm_pub_draft')).toBeTruthy();

    useMindMapStore.getState().clearDraft();
    expect(window.localStorage.getItem('mindmap:draft:mm_pub_draft')).toBeNull();

    expect(() => {
      useMindMapStore.getState().destroy();
      useMindMapStore.getState().destroy();
    }).not.toThrow();
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
