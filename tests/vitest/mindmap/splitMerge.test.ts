import { describe, expect, it } from 'vitest';

import type { MindMapNode } from '@/features/mindmap/types';
import { splitNode, mergeWithPrevious } from '@/features/mindmap/utils/node/splitMerge';

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

  it('uses textOverride for unsaved local edits', () => {
    const root = node('root', 'R', [node('a', 'foo'), node('b', 'old')]);
    const result = mergeWithPrevious(root, 'b', 'NEW')!;
    expect(result.tree.children[0].text).toBe('fooNEW');
  });
});
