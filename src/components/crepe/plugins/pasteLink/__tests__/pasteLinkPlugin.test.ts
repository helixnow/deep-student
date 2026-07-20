import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection, Plugin } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';

import {
  applyPasteUrlLink,
  shouldSkipPasteLinkContext,
} from '../applyPasteUrlLink';
import { createPasteLinkProsePluginForTest, handlePasteUrl } from '../pasteLinkPlugin';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },
    table: {
      content: 'table_row+',
      group: 'block',
      tableRole: 'table',
      isolating: true,
      toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: {
      content: '(table_cell | table_header)*',
      tableRole: 'row',
      toDOM: () => ['tr', 0],
    },
    table_cell: {
      content: 'inline*',
      tableRole: 'cell',
      isolating: true,
      toDOM: () => ['td', 0],
    },
    table_header: {
      content: 'inline*',
      tableRole: 'header_cell',
      isolating: true,
      toDOM: () => ['th', 0],
    },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: {
        href: { default: null },
        title: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (dom) => ({
            href: (dom as HTMLElement).getAttribute('href'),
            title: (dom as HTMLElement).getAttribute('title'),
          }),
        },
      ],
      toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
    },
    strong: { toDOM: () => ['strong', 0] },
    inlineCode: { toDOM: () => ['code', 0] },
  },
});

function paraDoc(text: string) {
  return schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
}

function stateWithSelection(doc: ReturnType<typeof paraDoc>, from: number, to: number) {
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

function linkHrefAt(state: EditorState, pos: number): string | null {
  const node = state.doc.nodeAt(pos);
  if (node?.isText) {
    const link = schema.marks.link.isInSet(node.marks);
    return link ? (link.attrs.href as string) : null;
  }
  const $pos = state.doc.resolve(pos);
  const after = $pos.nodeAfter;
  if (after?.isText) {
    const link = schema.marks.link.isInSet(after.marks);
    return link ? (link.attrs.href as string) : null;
  }
  return null;
}

describe('applyPasteUrlLink', () => {
  it('adds link mark to selection without replacing text', () => {
    const state = stateWithSelection(paraDoc('hello world'), 1, 6); // "hello"
    const tr = applyPasteUrlLink(state, 'https://example.com');
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    expect(next.doc.textContent).toBe('hello world');
    expect(linkHrefAt(next, 2)).toBe('https://example.com');
    // outside selection remains unmarked
    expect(linkHrefAt(next, 8)).toBeNull();
  });

  it('inserts linked URL text when selection is empty', () => {
    const state = stateWithSelection(paraDoc('ab'), 2, 2); // between a and b
    const tr = applyPasteUrlLink(state, 'https://example.com/x');
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    expect(next.doc.textContent).toBe('ahttps://example.com/xb');
    expect(linkHrefAt(next, 3)).toBe('https://example.com/x');
  });

  it('normalizes www. to https href while keeping display text', () => {
    const state = stateWithSelection(paraDoc(''), 1, 1);
    const tr = applyPasteUrlLink(state, 'www.example.com');
    const next = state.apply(tr!);
    expect(next.doc.textContent).toBe('www.example.com');
    expect(linkHrefAt(next, 2)).toBe('https://www.example.com');
  });

  it('is a single transaction (one undo step)', () => {
    const state = stateWithSelection(paraDoc('sel'), 1, 4);
    const tr = applyPasteUrlLink(state, 'https://example.com');
    expect(tr).not.toBeNull();
    expect(tr!.steps.length).toBeGreaterThanOrEqual(1);
    // applying once yields the final doc — no multi-dispatch
    const next = state.apply(tr!);
    expect(next.doc.textContent).toBe('sel');
    expect(linkHrefAt(next, 2)).toBe('https://example.com');
  });
});

describe('shouldSkipPasteLinkContext', () => {
  it('skips inside code_block', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('x')]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
    });
    expect(shouldSkipPasteLinkContext(state)).toBe(true);
  });

  it('skips inside table_cell', () => {
    const doc = schema.node('doc', null, [
      schema.node('table', null, [
        schema.node('table_row', null, [
          schema.node('table_cell', null, [schema.text('cell')]),
        ]),
      ]),
    ]);
    // pos 3 is inside the cell text
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    expect(shouldSkipPasteLinkContext(state)).toBe(true);
  });

  it('does not skip in normal paragraph', () => {
    const state = stateWithSelection(paraDoc('hi'), 1, 1);
    expect(shouldSkipPasteLinkContext(state)).toBe(false);
  });

  it('skips when selection end reaches into a table cell', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('before')]),
      schema.node('table', null, [
        schema.node('table_row', null, [
          schema.node('table_cell', null, [schema.text('cell')]),
        ]),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 11),
    });
    expect(shouldSkipPasteLinkContext(state)).toBe(true);
  });

  it('skips when selection text carries an inline code mark', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('code', [schema.marks.inlineCode.create()]),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 5),
    });
    expect(shouldSkipPasteLinkContext(state)).toBe(true);
  });

  it('skips when caret marks include inline code', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('code', [schema.marks.inlineCode.create()]),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    expect(shouldSkipPasteLinkContext(state)).toBe(true);
  });
});

describe('handlePasteUrl', () => {
  function mockView(initial: EditorState) {
    let state = initial;
    return {
      get state() {
        return state;
      },
      props: { editable: () => true },
      dispatch(tr: ReturnType<EditorState['tr']>) {
        state = state.apply(tr);
      },
      _getState: () => state,
    };
  }

  function mockEvent(plain: string, extras?: { html?: string; vscode?: string; files?: boolean }) {
    const files = extras?.files
      ? ({ length: 1 } as unknown as FileList)
      : ({ length: 0 } as unknown as FileList);
    return {
      clipboardData: {
        files,
        types: extras?.files ? ['Files', 'text/plain'] : ['text/plain'],
        getData(type: string) {
          if (type === 'text/plain') return plain;
          if (type === 'text/html') return extras?.html ?? '';
          if (type === 'vscode-editor-data') return extras?.vscode ?? '';
          return '';
        },
      },
    } as unknown as ClipboardEvent;
  }

  it('returns false for non-URL plain text', () => {
    const view = mockView(stateWithSelection(paraDoc('hi'), 1, 1));
    expect(handlePasteUrl(view as never, mockEvent('not a url'))).toBe(false);
  });

  it('returns false for multiline', () => {
    const view = mockView(stateWithSelection(paraDoc('hi'), 1, 1));
    expect(handlePasteUrl(view as never, mockEvent('https://a.com\nhttps://b.com'))).toBe(false);
  });

  it('returns false when files present', () => {
    const view = mockView(stateWithSelection(paraDoc('hi'), 1, 1));
    expect(
      handlePasteUrl(view as never, mockEvent('https://example.com', { files: true })),
    ).toBe(false);
  });

  it('returns false for vscode-editor-data', () => {
    const view = mockView(stateWithSelection(paraDoc('hi'), 1, 1));
    expect(
      handlePasteUrl(
        view as never,
        mockEvent('https://example.com', { vscode: '{"mode":"typescript"}' }),
      ),
    ).toBe(false);
  });

  it('applies selection path via handlePaste', () => {
    const view = mockView(stateWithSelection(paraDoc('hello'), 1, 6));
    expect(handlePasteUrl(view as never, mockEvent('https://example.com'))).toBe(true);
    const next = view._getState();
    expect(next.doc.textContent).toBe('hello');
    expect(linkHrefAt(next, 2)).toBe('https://example.com');
  });

  it('applies empty-selection insert path via handlePaste', () => {
    const view = mockView(stateWithSelection(paraDoc(''), 1, 1));
    expect(handlePasteUrl(view as never, mockEvent('https://example.com'))).toBe(true);
    const next = view._getState();
    expect(next.doc.textContent).toBe('https://example.com');
    expect(linkHrefAt(next, 2)).toBe('https://example.com');
  });

  it('still handles when text/html is also present (browser address-bar copy)', () => {
    const view = mockView(stateWithSelection(paraDoc('t'), 1, 2));
    expect(
      handlePasteUrl(
        view as never,
        mockEvent('https://example.com', {
          html: '<a href="https://example.com">https://example.com</a>',
        }),
      ),
    ).toBe(true);
    expect(view._getState().doc.textContent).toBe('t');
    expect(linkHrefAt(view._getState(), 1)).toBe('https://example.com');
  });

  it('exposes a Plugin with handlePaste via createPasteLinkProsePluginForTest', () => {
    const plugin = createPasteLinkProsePluginForTest();
    expect(plugin).toBeInstanceOf(Plugin);
    expect(typeof plugin.props.handlePaste).toBe('function');
  });
});
