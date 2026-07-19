import { describe, expect, it } from 'vitest';
import {
  looksLikeMarkdownList,
  markdownListToNodes,
  htmlOutlineToMarkdown,
} from '@/features/mindmap/utils/pasteMarkdown';
import {
  filterCompletedTree,
  shouldHideCompletedNode,
  resolveVisibleFocusId,
  subtreeHasIncomplete,
} from '@/features/mindmap/utils/hideCompleted';
import type { MindMapNode } from '@/features/mindmap/types';

describe('looksLikeMarkdownList', () => {
  it('detects multi-line bullet lists', () => {
    expect(looksLikeMarkdownList('- a\n- b\n  - c')).toBe(true);
  });

  it('rejects plain single line', () => {
    expect(looksLikeMarkdownList('hello')).toBe(false);
  });

  it('detects headings + list', () => {
    expect(looksLikeMarkdownList('# Title\n- item')).toBe(true);
  });

  it('rejects numbered prose that is not mostly a list', () => {
    expect(
      looksLikeMarkdownList(
        '1. First point about the topic.\n2. Second point continuing the idea.\nAnd a trailing sentence.'
      )
    ).toBe(false);
  });

  it('accepts dense ordered lists', () => {
    expect(looksLikeMarkdownList('1. a\n2. b\n3. c')).toBe(true);
  });

  it('accepts indentation-only and common pasted bullet outlines', () => {
    expect(looksLikeMarkdownList('Parent\n  Child\n    Deep')).toBe(true);
    expect(looksLikeMarkdownList('• Parent\n  • Child')).toBe(true);
  });
});

describe('markdownListToNodes', () => {
  it('builds nested children from indented bullets', () => {
    const forest = markdownListToNodes('- parent\n  - child\n  - sibling\n    - deep');
    expect(forest).toHaveLength(1);
    expect(forest[0].text).toBe('parent');
    expect(forest[0].children).toHaveLength(2);
    expect(forest[0].children[0].text).toBe('child');
    expect(forest[0].children[1].children[0].text).toBe('deep');
  });

  it('supports multiple top-level roots', () => {
    const forest = markdownListToNodes('- a\n- b');
    expect(forest.map((n) => n.text)).toEqual(['a', 'b']);
  });

  it('builds a tree from indentation-only text', () => {
    const forest = markdownListToNodes('Parent\n  Child\n    Deep\nSibling');
    expect(forest.map((node) => node.text)).toEqual(['Parent', 'Sibling']);
    expect(forest[0].children[0].text).toBe('Child');
    expect(forest[0].children[0].children[0].text).toBe('Deep');
  });
});

describe('htmlOutlineToMarkdown', () => {
  it('extracts nested Word/HTML lists as an outline', () => {
    const markdown = htmlOutlineToMarkdown(
      '<ul><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ul>',
    );
    expect(markdown).toBe('- Parent\n  - Child\n- Sibling');
    const forest = markdownListToNodes(markdown!);
    expect(forest.map((node) => node.text)).toEqual(['Parent', 'Sibling']);
    expect(forest[0].children[0].text).toBe('Child');
  });

  it('extracts heading hierarchy and ignores unstructured HTML', () => {
    expect(htmlOutlineToMarkdown('<h1>Chapter</h1><h2>Section</h2>')).toBe(
      '# Chapter\n## Section',
    );
    expect(htmlOutlineToMarkdown('<p>ordinary inline text</p>')).toBeNull();
  });

  it('recognizes Word MsoListParagraph markup', () => {
    expect(htmlOutlineToMarkdown(
      '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1;margin-left:36pt">• Parent</p>' +
      '<p class="MsoListParagraph" style="mso-list:l0 level2 lfo1;margin-left:72pt">• Child</p>',
    )).toBe('- Parent\n  - Child');
  });
});

describe('hideCompleted filter', () => {
  const tree: MindMapNode = {
    id: 'root',
    text: 'root',
    children: [
      {
        id: 'done-leaf',
        text: 'done',
        completed: true,
        children: [],
      },
      {
        id: 'done-parent',
        text: 'done parent',
        completed: true,
        children: [
          { id: 'open-child', text: 'open', completed: false, children: [] },
        ],
      },
      {
        id: 'open',
        text: 'open',
        children: [
          { id: 'done-under-open', text: 'done', completed: true, children: [] },
        ],
      },
    ],
  };

  it('hides completed leaves without incomplete descendants', () => {
    expect(shouldHideCompletedNode(tree.children[0])).toBe(true);
    expect(subtreeHasIncomplete(tree.children[1])).toBe(true);
    expect(shouldHideCompletedNode(tree.children[1])).toBe(false);
  });

  it('filters tree while keeping ancestors of incomplete nodes', () => {
    const filtered = filterCompletedTree(tree);
    expect(filtered.children.map((c) => c.id)).toEqual(['done-parent', 'open']);
    expect(filtered.children[0].children[0].id).toBe('open-child');
    expect(filtered.children[1].children).toHaveLength(0);
  });

  it('resolves focus off a hidden completed node', () => {
    expect(resolveVisibleFocusId(tree, 'done-leaf', true)).toBe('root');
    expect(resolveVisibleFocusId(tree, 'open-child', true)).toBe('open-child');
    expect(resolveVisibleFocusId(tree, 'done-under-open', true)).toBe('open');
  });
});
