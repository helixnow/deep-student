import { describe, expect, it } from 'vitest';

import type { MindMapNode } from '@/features/mindmap/types';
import { splitNode, mergeWithPrevious } from '@/features/mindmap/utils/node/splitMerge';
import { moveNode, outdentNode } from '@/features/mindmap/utils/node/move';

function node(id: string, text: string, children: MindMapNode[] = []): MindMapNode {
  return { id, text, children };
}

describe('splitNode', () => {
  it('splits mid-text into sibling and focuses new node at 0', () => {
    const root = node('root', 'R', [node('a', 'hello')]);
    const result = splitNode(root, 'a', 2)!;
    expect(result).toBeTruthy();
    expect(result.focusNodeId).toBe(result.newNodeId);
    expect(result.caretOffset).toBe(0);

    const siblings = result.tree.children;
    expect(siblings).toHaveLength(2);
    expect(siblings[0].id).toBe('a');
    expect(siblings[0].text).toBe('he');
    expect(siblings[1].id).toBe(result.newNodeId);
    expect(siblings[1].text).toBe('llo');
  });

  it('at offset 0 keeps focus on original empty node', () => {
    const root = node('root', 'R', [node('a', 'hello')]);
    const result = splitNode(root, 'a', 0)!;
    expect(result.focusNodeId).toBe('a');
    expect(result.tree.children[0].text).toBe('');
    expect(result.tree.children[1].text).toBe('hello');
  });

  it('keeps children on the original node', () => {
    const root = node('root', 'R', [
      node('a', 'ab', [node('c', 'child')]),
    ]);
    const result = splitNode(root, 'a', 1)!;
    expect(result.tree.children[0].children).toHaveLength(1);
    expect(result.tree.children[0].children[0].id).toBe('c');
    expect(result.tree.children[1].children).toHaveLength(0);
  });

  it('splits blank ranges at the boundary instead of clearing them', () => {
    const root = node('root', 'R', [
      { ...node('a', 'HelloWorld'), blankedRanges: [{ start: 2, end: 8 }] },
    ]);
    const result = splitNode(root, 'a', 5)!;
    expect(result.tree.children[0].blankedRanges).toEqual([{ start: 2, end: 5 }]);
    expect(result.tree.children[1].blankedRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('splits root by inserting right half as first child', () => {
    const root = node('root', 'hello', [node('a', 'x')]);
    const result = splitNode(root, 'root', 2)!;
    expect(result.tree.text).toBe('he');
    expect(result.tree.children[0].id).toBe(result.newNodeId);
    expect(result.tree.children[0].text).toBe('llo');
    expect(result.tree.children[1].id).toBe('a');
  });
});

describe('mergeWithPrevious', () => {
  it('merges into previous sibling and restores caret at join', () => {
    const root = node('root', 'R', [node('a', 'foo'), node('b', 'bar')]);
    const result = mergeWithPrevious(root, 'b')!;
    expect(result.focusNodeId).toBe('a');
    expect(result.caretOffset).toBe(3);
    expect(result.tree.children).toHaveLength(1);
    expect(result.tree.children[0].text).toBe('foobar');
  });

  it('appends subtree under previous sibling', () => {
    const root = node('root', 'R', [
      node('a', 'A'),
      node('b', 'B', [node('c', 'C')]),
    ]);
    const result = mergeWithPrevious(root, 'b')!;
    expect(result.tree.children).toHaveLength(1);
    expect(result.tree.children[0].children.map((n) => n.id)).toEqual(['c']);
  });

  it('merges into parent when no previous sibling', () => {
    const root = node('root', 'R', [node('a', 'tail', [node('c', 'C')])]);
    const result = mergeWithPrevious(root, 'a')!;
    expect(result.focusNodeId).toBe('root');
    expect(result.caretOffset).toBe(1);
    expect(result.tree.text).toBe('Rtail');
    expect(result.tree.children.map((n) => n.id)).toEqual(['c']);
  });

  it('keeps target blank ranges and shifts source ranges across the join', () => {
    const root = node('root', 'R', [
      { ...node('a', 'foo'), blankedRanges: [{ start: 0, end: 3 }] },
      { ...node('b', 'bar'), blankedRanges: [{ start: 1, end: 3 }] },
    ]);
    const result = mergeWithPrevious(root, 'b')!;
    expect(result.tree.children[0].blankedRanges).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it('uses textOverride for unsaved local edits', () => {
    const root = node('root', 'R', [node('a', 'foo'), node('b', 'old')]);
    const result = mergeWithPrevious(root, 'b', 'NEW')!;
    expect(result.tree.children[0].text).toBe('fooNEW');
  });
});

describe('moveNode (utils, B7 index correction)', () => {
  it('corrects the target index when moving down within the same parent', () => {
    const root = node('root', 'R', [node('a', 'A'), node('b', 'B'), node('c', 'C')]);
    // 与 store.moveNodes 语义对齐：index 按「移动前」的同级序列表达
    const result = moveNode(root, 'a', 'root', 2);
    expect(result.children.map((n) => n.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the index when moving up within the same parent', () => {
    const root = node('root', 'R', [node('a', 'A'), node('b', 'B'), node('c', 'C')]);
    const result = moveNode(root, 'c', 'root', 0);
    expect(result.children.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not adjust the index when moving across parents', () => {
    const root = node('root', 'R', [
      node('p', 'P', [node('a', 'A')]),
      node('q', 'Q', [node('x', 'X'), node('y', 'Y')]),
    ]);
    const result = moveNode(root, 'a', 'q', 1);
    expect(result.children[1].children.map((n) => n.id)).toEqual(['x', 'a', 'y']);
  });
});

describe('outdentNode (utils, Workflowy adoption semantics)', () => {
  it('adopts following siblings as children of the promoted node', () => {
    const root = node('root', 'R', [
      node('p', 'P', [node('a', 'A'), node('b', 'B'), node('c', 'C')]),
      node('d', 'D'),
    ]);
    const result = outdentNode(root, 'b');
    expect(result.children.map((n) => n.id)).toEqual(['p', 'b', 'd']);
    expect(result.children[0].children.map((n) => n.id)).toEqual(['a']);
    expect(result.children[1].children.map((n) => n.id)).toEqual(['c']);
  });

  it('keeps existing children before adopted siblings and uncollapses the adopter', () => {
    const root = node('root', 'R', [
      node('p', 'P', [
        { ...node('b', 'B', [node('k', 'K')]), collapsed: true },
        node('c', 'C'),
      ]),
    ]);
    const result = outdentNode(root, 'b');
    const promoted = result.children[1];
    expect(promoted.id).toBe('b');
    expect(promoted.children.map((n) => n.id)).toEqual(['k', 'c']);
    expect(promoted.collapsed).toBe(false);
  });

  it('returns the tree unchanged when the parent is the root', () => {
    const root = node('root', 'R', [node('a', 'A')]);
    expect(outdentNode(root, 'a')).toBe(root);
  });
});
