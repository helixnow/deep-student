import { afterEach, describe, expect, it } from 'vitest';
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';
import { editorApi } from '../editor';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'text*', toDOM: () => ['h1', 0] },
    text: {},
  },
});

const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const views: EditorView[] = [];

function makeView(...paragraphs: string[]): EditorView {
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ schema, doc: schema.node('doc', null, paragraphs.map(p)) }) });
  views.push(view);
  return view;
}

function select(view: EditorView, from: number, to: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** A Milkdown ctx with the three slices editorApi reads; `# x` parses to a heading, other lines to paragraphs. */
function fakeCtx(view: EditorView): Ctx {
  const parser = (markdown: string): ProseNode => schema.node('doc', null, markdown.split('\n').filter(Boolean).map((line) =>
    line.startsWith('# ') ? schema.node('heading', null, [schema.text(line.slice(2))]) : p(line)));
  const serializer = (doc: ProseNode) => {
    const lines: string[] = [];
    doc.forEach((node) => lines.push(node.type.name === 'heading' ? `# ${node.textContent}` : node.textContent));
    return lines.join('\n\n');
  };
  const slices = new Map<unknown, unknown>([[editorViewCtx, view], [parserCtx, parser], [serializerCtx, serializer]]);
  return { get: (slice: unknown) => slices.get(slice) } as unknown as Ctx;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('editorApi', () => {
  it('reads and replaces the selection through an EditorView (block menu)', () => {
    const view = makeView('hello world', 'second');
    select(view, 7, 12);
    const editor = editorApi(view);
    expect(editor.getSelectionText()).toBe('world');
    expect(editor.getSelection()).toEqual({ from: 7, to: 12, empty: false });
    expect(editor.replaceSelection('there')).toBe(true);
    expect(editor.getText()).toBe('hello there\nsecond');
    // Without a Milkdown ctx, Markdown falls back to plain text.
    expect(editor.insertMarkdown('!')).toBe(true);
    expect(editor.getMarkdown()).toBe('hello there!\nsecond');
  });

  it('inserts parsed Markdown and serializes the document through a Milkdown ctx (toolbar / slash menu)', () => {
    const view = makeView('alpha beta');
    select(view, 7, 11);
    const editor = editorApi(fakeCtx(view));
    expect(editor.insertMarkdown('gamma')).toBe(true);
    expect(editor.getMarkdown()).toBe('alpha gamma');
    expect(editor.appendMarkdownAfterSelection('# Notes\nmore')).toBe(true);
    expect(editor.getMarkdown()).toBe('alpha gamma\n\n# Notes\n\nmore');
    // Writes are ordinary transactions: the document changed through dispatch.
    expect(view.state.doc.childCount).toBe(3);
  });

  it('turns into a no-op once the editor is destroyed', () => {
    const view = makeView('x');
    const editor = editorApi(view);
    view.destroy();
    expect(editor.insertText('y')).toBe(false);
    expect(editor.getSelectionText()).toBe('');
  });
});
