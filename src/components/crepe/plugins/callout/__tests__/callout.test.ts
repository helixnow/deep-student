import { defaultValueCtx, Editor, editorViewCtx, parserCtx, schemaCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { EditorState } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';

import {
  applyCalloutInputRule,
  applyFullLineCalloutInputRule,
  CALLOUT_TYPES,
  calloutPlugin,
  nextCalloutType,
  parseCalloutMarker,
  promoteBlockquoteToCallout,
  type CalloutType,
} from '../index';

async function createCalloutEditor(markdown = '') {
  const editor = Editor.make();
  editor.use(commonmark).use(gfm).use(calloutPlugin());
  if (markdown) {
    editor.config((ctx) => {
      ctx.set(defaultValueCtx, markdown);
    });
  }
  await editor.create();
  return editor;
}

function normalizeMd(md: string): string {
  return md.replace(/\r\n/g, '\n').trim();
}

describe('parseCalloutMarker / remark', () => {
  it('parses supported markers with optional title', () => {
    expect(parseCalloutMarker('[!note]')).toEqual({ type: 'note', title: '' });
    expect(parseCalloutMarker('[!tip] 小提示')).toEqual({ type: 'tip', title: '小提示' });
    expect(parseCalloutMarker('[!WARNING] Careful')).toEqual({
      type: 'warning',
      title: 'Careful',
    });
  });

  it('rejects unknown types', () => {
    expect(parseCalloutMarker('[!todo] later')).toBeNull();
    expect(parseCalloutMarker('not a callout')).toBeNull();
  });

  it('promotes matching blockquotes in AST', () => {
    const node = {
      type: 'blockquote',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: '[!danger] 危险' }] },
        { type: 'paragraph', children: [{ type: 'text', value: 'body' }] },
      ],
    };
    expect(promoteBlockquoteToCallout(node)).toBe(true);
    expect(node.type).toBe('callout');
    expect(node.calloutType).toBe('danger');
    expect(node.calloutTitle).toBe('危险');
    expect(node.children).toHaveLength(1);
  });

  it('cycles types in order', () => {
    expect(nextCalloutType('note')).toBe('tip');
    expect(nextCalloutType('info')).toBe('note');
  });
});

describe('callout markdown roundtrip', () => {
  it('roundtrips a titled note with nested list and multi-paragraph body', async () => {
    const input = [
      '> [!note] 学习要点',
      '>',
      '> 第一段说明。',
      '>',
      '> - 列表甲',
      '> - 列表乙',
      '>',
      '> 第二段收尾。',
      '',
    ].join('\n');

    const editor = await createCalloutEditor(input);
    const view = editor.ctx.get(editorViewCtx);
    const serializer = editor.ctx.get(serializerCtx);
    const schema = editor.ctx.get(schemaCtx);

    const callout = view.state.doc.firstChild;
    expect(callout?.type.name).toBe('callout');
    expect(callout?.attrs.type).toBe('note');
    expect(callout?.attrs.title).toBe('学习要点');
    expect(schema.nodes.callout).toBeTruthy();

    // Nested list + multiple paragraphs preserved inside callout
    const childTypes = [] as string[];
    callout?.forEach((child) => {
      childTypes.push(child.type.name);
    });
    expect(childTypes).toContain('paragraph');
    expect(childTypes.some((t) => t === 'bullet_list' || t === 'list_item')).toBe(true);

    const output = serializer(view.state.doc);
    expect(normalizeMd(output)).toContain('> [!note] 学习要点');
    expect(normalizeMd(output)).toContain('第一段说明');
    expect(normalizeMd(output)).toMatch(/列表甲/);
    expect(normalizeMd(output)).toContain('第二段收尾');

    // Second pass: parse serialized markdown again
    const editor2 = await createCalloutEditor(output);
    const view2 = editor2.ctx.get(editorViewCtx);
    const again = view2.state.doc.firstChild;
    expect(again?.type.name).toBe('callout');
    expect(again?.attrs.type).toBe('note');
    expect(again?.attrs.title).toBe('学习要点');

    await editor.destroy();
    await editor2.destroy();
  });

  it('roundtrips all five types', async () => {
    for (const type of CALLOUT_TYPES) {
      const md = `> [!${type}] Title-${type}\n>\n> Content for ${type}\n`;
      const editor = await createCalloutEditor(md);
      const view = editor.ctx.get(editorViewCtx);
      const serializer = editor.ctx.get(serializerCtx);
      const node = view.state.doc.firstChild;
      expect(node?.type.name).toBe('callout');
      expect(node?.attrs.type).toBe(type);
      expect(node?.attrs.title).toBe(`Title-${type}`);

      const out = serializer(view.state.doc);
      expect(normalizeMd(out)).toContain(`> [!${type}] Title-${type}`);
      await editor.destroy();
    }
  });

  it('keeps plain blockquotes untouched', async () => {
    const editor = await createCalloutEditor('> just a quote\n');
    const view = editor.ctx.get(editorViewCtx);
    expect(view.state.doc.firstChild?.type.name).toBe('blockquote');
    await editor.destroy();
  });
});

describe('callout input rules', () => {
  it('converts blockquote paragraph after typing [!note] ', async () => {
    const editor = await createCalloutEditor('> placeholder\n');
    const view = editor.ctx.get(editorViewCtx);
    const schema = editor.ctx.get(schemaCtx);

    // Build a blockquote with paragraph text `[!note]` then apply rule as if space typed
    const paragraph = schema.nodes.paragraph!.create(null, schema.text('[!note]'));
    const blockquote = schema.nodes.blockquote!.create(null, paragraph);
    const doc = schema.nodes.doc!.create(null, blockquote);
    const state = EditorState.create({ schema, doc });

    // Match range: entire `[!note]` + the typed space would be at end; simulate match of `[!note] `
    // by placing text `[!note] ` and matching start..end
    const paraWithSpace = schema.nodes.paragraph!.create(null, schema.text('[!note] '));
    const bq = schema.nodes.blockquote!.create(null, paraWithSpace);
    const state2 = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, bq),
    });

    // Positions: doc(0) blockquote(0) paragraph(0) text — start of text is 2
    const start = 2;
    const end = start + '[!note] '.length;
    const match = /^\[!(note|tip|warning|danger|info)]\s$/i.exec('[!note] ');
    expect(match).toBeTruthy();

    const tr = applyCalloutInputRule(state2, match!, start, end, schema.nodes.callout);
    expect(tr).toBeTruthy();
    const next = state2.apply(tr!);
    expect(next.doc.firstChild?.type.name).toBe('callout');
    expect(next.doc.firstChild?.attrs.type).toBe('note');

    void state;
    void view;
    await editor.destroy();
  });

  it('converts full-line > [!tip]  in a plain paragraph', async () => {
    const editor = await createCalloutEditor();
    const schema = editor.ctx.get(schemaCtx);
    const text = '> [!tip] ';
    const paragraph = schema.nodes.paragraph!.create(null, schema.text(text));
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, paragraph),
    });
    const start = 1;
    const end = start + text.length;
    const match = /^>\s*\[!(note|tip|warning|danger|info)]\s$/i.exec(text);
    expect(match).toBeTruthy();

    const tr = applyFullLineCalloutInputRule(state, match!, start, end, schema.nodes.callout);
    expect(tr).toBeTruthy();
    const next = state.apply(tr!);
    expect(next.doc.firstChild?.type.name).toBe('callout');
    expect(next.doc.firstChild?.attrs.type).toBe('tip');
    await editor.destroy();
  });
});

describe('callout render classes', () => {
  it('renders crepe-callout--{type} for all five types', async () => {
    for (const type of CALLOUT_TYPES as readonly CalloutType[]) {
      const editor = await createCalloutEditor(`> [!${type}]\n>\n> body\n`);
      const view = editor.ctx.get(editorViewCtx);
      const el = view.dom.querySelector(`.crepe-callout--${type}`);
      expect(el).toBeTruthy();
      expect(el?.classList.contains('crepe-callout')).toBe(true);
      expect(el?.getAttribute('data-callout-type')).toBe(type);
      expect(el?.querySelector('.crepe-callout__icon')).toBeTruthy();
      expect(el?.querySelector('.crepe-callout__content')).toBeTruthy();
      await editor.destroy();
    }
  });

  it('cycles type class when icon is clicked', async () => {
    const editor = await createCalloutEditor('> [!note]\n>\n> body\n');
    const view = editor.ctx.get(editorViewCtx);
    const icon = view.dom.querySelector('.crepe-callout__icon') as HTMLButtonElement | null;
    expect(icon).toBeTruthy();
    icon!.click();
    expect(view.state.doc.firstChild?.attrs.type).toBe('tip');
    expect(view.dom.querySelector('.crepe-callout--tip')).toBeTruthy();
    await editor.destroy();
  });
});

describe('parser/serializer smoke', () => {
  it('parser produces callout nodes from markdown string', async () => {
    const editor = await createCalloutEditor();
    const parser = editor.ctx.get(parserCtx);
    const doc = parser('> [!info] Hi\n>\n> text\n');
    expect(doc.firstChild?.type.name).toBe('callout');
    expect(doc.firstChild?.attrs.type).toBe('info');
    expect(doc.firstChild?.attrs.title).toBe('Hi');
    await editor.destroy();
  });
});
