import { describe, expect, it } from 'vitest';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { getMarkdown } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/prose/view';

import {
  detectWikilinkTrigger,
  buildAutocompleteItems,
  buildHeadingAutocompleteItems,
  buildModeHint,
  insertWikilink,
  parseWikilinkQuery,
} from '../autocomplete';
import { fuzzyMatchNotes } from '../fuzzy';
import { wikilinkPlugin } from '../index';
import { extractMarkdownHeadings } from '../noteContent';
import { WIKILINK_NODE_NAME } from '../schema';

describe('detectWikilinkTrigger (input [[)', () => {
  it('triggers after [[ and captures query', () => {
    expect(detectWikilinkTrigger('hello [[')).toEqual({
      triggerStartInText: 6,
      query: '',
    });
    expect(detectWikilinkTrigger('hello [[微积分')).toEqual({
      triggerStartInText: 6,
      query: '微积分',
    });
  });

  it('does not trigger after closed link or newline', () => {
    expect(detectWikilinkTrigger('[[done]] more')).toBeNull();
    expect(detectWikilinkTrigger('[[broken\n')).toBeNull();
    expect(detectWikilinkTrigger('no brackets')).toBeNull();
  });
});

describe('fuzzyMatchNotes / buildAutocompleteItems', () => {
  const notes = [
    { id: '1', title: '高等数学' },
    { id: '2', title: '微积分入门' },
    { id: '3', title: '线性代数' },
  ];

  it('ranks exact / prefix / includes', () => {
    expect(fuzzyMatchNotes(notes, '高等数学', 8).map((n) => n.id)).toEqual(['1']);
    expect(fuzzyMatchNotes(notes, '微', 8).map((n) => n.id)).toEqual(['2']);
    expect(fuzzyMatchNotes(notes, '代数', 8).map((n) => n.id)).toEqual(['3']);
  });

  it('adds create item when query has no exact title match', () => {
    const items = buildAutocompleteItems(notes, '新笔记', 8);
    expect(items.some((i) => i.kind === 'create' && i.title === '新笔记')).toBe(true);
  });

  it('omits create when exact title exists', () => {
    const items = buildAutocompleteItems(notes, '高等数学', 8);
    expect(items.every((i) => i.kind === 'note')).toBe(true);
  });

  it('splits query into target / heading / label parts', () => {
    expect(parseWikilinkQuery('plain')).toEqual({ target: 'plain', heading: null, label: null });
    expect(parseWikilinkQuery('目标|别名')).toEqual({ target: '目标', heading: null, label: '别名' });
    expect(parseWikilinkQuery('Note#Sec|L')).toEqual({ target: 'Note', heading: 'Sec', label: 'L' });
    expect(parseWikilinkQuery('Note#')).toEqual({ target: 'Note', heading: '', label: null });
  });

  it('keeps the alias while matching only the target before the pipe', () => {
    const items = buildAutocompleteItems(notes, '高等数学|别名', 8);
    const noteItem = items.find((i) => i.kind === 'note');
    expect(noteItem?.insert).toEqual({ target: '高等数学', label: '别名' });
    // 别名下的「创建」也保留 label
    const created = buildAutocompleteItems(notes, '新笔记|alias', 8).find((i) => i.kind === 'create');
    expect(created?.insert).toEqual({ target: '新笔记', label: 'alias' });
  });

  it('matches whitespace-separated tokens after contiguous substrings', () => {
    const tokenNotes = [
      { id: 't1', title: '线性代数学习笔记' },
      { id: 't2', title: '代数 笔记' },
      { id: 't3', title: '概率论' },
    ];
    // 分词命中：每个词都是子串即可，顺序无关
    expect(fuzzyMatchNotes(tokenNotes, '代数 笔记', 8).map((n) => n.id)).toEqual(['t2', 't1']);
    expect(fuzzyMatchNotes(tokenNotes, '笔记 线性', 8).map((n) => n.id)).toEqual(['t1']);
    // 连续子串（rank 2）仍排在分词命中（rank 3）之前
    const mixed = [
      { id: 'sub', title: 'Machine Learning Notes' },
      { id: 'tok', title: 'Notes on Machine-based Learning' },
    ];
    expect(fuzzyMatchNotes(mixed, 'learning notes', 8).map((n) => n.id)).toEqual(['sub', 'tok']);
  });

  it('ranks recently edited notes first inside the same match tier', () => {
    const dated = [
      { id: 'a', title: '数学一', updatedAt: 100 },
      { id: 'b', title: '数学二', updatedAt: 300 },
      { id: 'c', title: '数学三', updatedAt: 200 },
    ];
    expect(fuzzyMatchNotes(dated, '数学', 8).map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('adds id-tail meta for duplicated titles and folder meta from path', () => {
    const duplicated = [
      { id: 'aaa111', title: 'Same', path: '/folder-a/aaa111' },
      { id: 'bbb222', title: 'Same', path: '/folder-b/bbb222' },
    ];
    const items = buildAutocompleteItems(duplicated, 'Same', 8)
      .filter((i): i is Extract<typeof i, { kind: 'note' }> => i.kind === 'note');
    expect(items[0].meta).toBe('/folder-a · …aaa111');
    expect(items[1].meta).toBe('/folder-b · …bbb222');
  });

  it('builds heading items from note headings with typed fallback', () => {
    const parts = parseWikilinkQuery('高等数学#极');
    const items = buildHeadingAutocompleteItems(['一、绪论', '二、极限'], parts, 8);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'heading',
      heading: '二、极限',
      insert: { target: '高等数学#二、极限', label: '' },
    });

    const typedOnly = buildHeadingAutocompleteItems([], parseWikilinkQuery('高等数学#手输标题'), 8);
    expect(typedOnly).toHaveLength(1);
    expect(typedOnly[0].insert.target).toBe('高等数学#手输标题');
  });

  it('extracts markdown headings while skipping fenced code', () => {
    const markdown = [
      '# 标题一',
      '```md',
      '# 不算标题',
      '```',
      '## 标题二 ##',
      '正文 # 不是标题',
    ].join('\n');
    expect(extractMarkdownHeadings(markdown)).toEqual(['标题一', '标题二']);
  });
});

function typeText(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch));
    if (!handled) {
      view.dispatch(view.state.tr.insertText(ch));
    }
  }
}

async function typeInEmptyEditor(text: string): Promise<string> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, '');
    })
    .use(commonmark)
    .use(wikilinkPlugin())
    .create();

  try {
    editor.action((ctx) => {
      typeText(ctx.get(editorViewCtx), text);
    });
    return editor.action(getMarkdown());
  } finally {
    await editor.destroy();
    root.remove();
  }
}

describe('wikilink InputRule via handleTextInput', () => {
  it('inserts a schema wikilink atom for drag-and-drop callers', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
      })
      .use(commonmark)
      .use(wikilinkPlugin())
      .create();

    try {
      const found = editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        insertWikilink(view, view.state.selection.from, view.state.selection.to, 'Dragged Note');
        let wikilinkFound = false;
        view.state.doc.descendants((node) => {
          if (node.type.name === WIKILINK_NODE_NAME && node.attrs.target === 'Dragged Note') {
            wikilinkFound = true;
          }
        });
        return wikilinkFound;
      });
      expect(found).toBe(true);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it('turns [[InputRuleNote]] into a wikilink atom', async () => {
    const markdown = await typeInEmptyEditor('[[InputRuleNote]]');
    expect(markdown.trim()).toContain('[[InputRuleNote]]');
    expect(markdown).not.toMatch(/\\\[/);

    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
      })
      .use(commonmark)
      .use(wikilinkPlugin())
      .create();
    try {
      const found = editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let ok = false;
        view.state.doc.descendants((node) => {
          if (node.type.name === WIKILINK_NODE_NAME && node.attrs.target === 'InputRuleNote') {
            ok = true;
          }
        });
        return ok;
      });
      expect(found).toBe(true);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it('turns [[目标|别名]] into atom and roundtrips', async () => {
    const markdown = await typeInEmptyEditor('[[目标|别名]]');
    expect(markdown.trim()).toContain('[[目标|别名]]');
    expect(markdown).not.toMatch(/\\\[/);
  });
});
