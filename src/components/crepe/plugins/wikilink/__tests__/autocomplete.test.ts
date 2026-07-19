import { describe, expect, it } from 'vitest';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { getMarkdown } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/prose/view';

import { detectWikilinkTrigger, buildAutocompleteItems, insertWikilink } from '../autocomplete';
import { fuzzyMatchNotes } from '../fuzzy';
import { wikilinkPlugin } from '../index';
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
