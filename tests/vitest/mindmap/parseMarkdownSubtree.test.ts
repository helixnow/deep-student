import { describe, expect, it } from 'vitest';
import {
  looksLikeMarkdownList,
  markdownListToNodes,
  htmlOutlineToMarkdown,
} from '@/features/mindmap/utils/pasteMarkdown';
import {
  encodeMindMapClipboard,
  hashText,
  nodesToMarkdown,
  parseMindMapClipboardPayload,
  MINDMAP_CLIPBOARD_FORMAT,
  MINDMAP_CLIPBOARD_VERSION,
} from '@/features/mindmap/utils/clipboardCodec';
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

  it('accepts single-line explicit list items and headings', () => {
    expect(looksLikeMarkdownList('- item')).toBe(true);
    expect(looksLikeMarkdownList('1. item')).toBe(true);
    expect(looksLikeMarkdownList('# heading')).toBe(true);
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

  it('parses task list markers into completed state', () => {
    const forest = markdownListToNodes('- [ ] todo\n  - [x] done\n- plain');
    expect(forest[0].text).toBe('todo');
    expect(forest[0].completed).toBe(false);
    expect(forest[0].children[0].text).toBe('done');
    expect(forest[0].children[0].completed).toBe(true);
    expect(forest[1].completed).toBeUndefined();
  });

  it('handles tab indentation', () => {
    const forest = markdownListToNodes('- parent\n\t- child\n\t\t- deep');
    expect(forest).toHaveLength(1);
    expect(forest[0].children[0].text).toBe('child');
    expect(forest[0].children[0].children[0].text).toBe('deep');
  });

  it('tolerates 3-space indentation steps', () => {
    const forest = markdownListToNodes('- parent\n   - child\n      - deep');
    expect(forest).toHaveLength(1);
    expect(forest[0].children[0].text).toBe('child');
    expect(forest[0].children[0].children[0].text).toBe('deep');
  });

  it('keeps 4-space indentation as one level per step', () => {
    const forest = markdownListToNodes('- parent\n    - child\n        - deep');
    expect(forest).toHaveLength(1);
    expect(forest[0].children[0].text).toBe('child');
    expect(forest[0].children[0].children[0].text).toBe('deep');
  });

  it('unescapes exporter-escaped note continuation lines', () => {
    // exporters.escapeMarkdownNoteLine 会给行首列表标记 / `>` 加 `\`，
    // 解析侧应对称还原（文件导入与粘贴共用本解析器）
    const forest = markdownListToNodes('- parent\n  \\- looks like a bullet\n  \\> quoted line');
    expect(forest).toHaveLength(1);
    expect(forest[0].text).toBe('parent');
    expect(forest[0].note).toBe('- looks like a bullet\n> quoted line');
  });

  it('strips `> ` note prefix without touching unescaped content', () => {
    const forest = markdownListToNodes('- parent\n  > - kept as note text');
    expect(forest[0].note).toBe('- kept as note text');
  });
});

describe('clipboardCodec', () => {
  const forest = [
    {
      id: 'n1',
      text: 'parent',
      note: 'a note',
      completed: false,
      children: [
        {
          id: 'n2',
          text: 'done child',
          completed: true,
          children: [],
          branchColor: '#ff0000',
        },
        { id: 'n3', text: 'plain child', children: [] },
      ],
    },
  ] as MindMapNode[];

  it('serializes tasks and notes to markdown', () => {
    expect(nodesToMarkdown(forest)).toBe(
      '- [ ] parent\n  > a note\n  - [x] done child\n  - plain child',
    );
  });

  it('round-trips markdown back into an equivalent tree', () => {
    const parsed = markdownListToNodes(nodesToMarkdown(forest));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('parent');
    expect(parsed[0].note).toBe('a note');
    expect(parsed[0].completed).toBe(false);
    expect(parsed[0].children.map((n) => n.text)).toEqual(['done child', 'plain child']);
    expect(parsed[0].children[0].completed).toBe(true);
  });

  it('hashText is deterministic and content-sensitive', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });

  it('encodes payload whose fingerprint matches its text', () => {
    const encoded = encodeMindMapClipboard(forest);
    expect(encoded).not.toBeNull();
    expect(encoded!.payload.format).toBe(MINDMAP_CLIPBOARD_FORMAT);
    expect(encoded!.payload.version).toBe(MINDMAP_CLIPBOARD_VERSION);
    expect(encoded!.payload.fingerprint).toBe(hashText(encoded!.text));
    // 运行时字段（branchColor）不进入载荷
    const child = encoded!.payload.nodes[0].children[0] as unknown as Record<string, unknown>;
    expect(child.branchColor).toBeUndefined();
    expect(child.completed).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(parseMindMapClipboardPayload(null)).toBeNull();
    expect(parseMindMapClipboardPayload({ format: 'other', version: 1 })).toBeNull();
    expect(
      parseMindMapClipboardPayload({
        format: MINDMAP_CLIPBOARD_FORMAT,
        version: MINDMAP_CLIPBOARD_VERSION,
        fingerprint: 'deadbeef',
        nodes: [{ noText: true }],
      }),
    ).toBeNull();
  });

  it('accepts and sanitizes well-formed payloads', () => {
    const payload = parseMindMapClipboardPayload({
      format: MINDMAP_CLIPBOARD_FORMAT,
      version: MINDMAP_CLIPBOARD_VERSION,
      copiedAt: 123,
      fingerprint: 'deadbeef',
      nodes: [
        {
          text: 'a',
          completed: true,
          style: { fontWeight: 'bold', bogus: 'dropped' },
          children: [{ text: 'b', children: [] }],
        },
      ],
    });
    expect(payload).not.toBeNull();
    expect(payload!.nodes[0].completed).toBe(true);
    expect(payload!.nodes[0].style).toEqual({ fontWeight: 'bold' });
    expect(payload!.nodes[0].children[0].text).toBe('b');
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
