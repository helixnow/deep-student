import { Schema, type Node as ProseNode } from '@milkdown/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/prose/state';
import { history } from '@milkdown/prose/history';
import type { EditorView } from '@milkdown/prose/view';
import { vi } from 'vitest';

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } }, toDOM: () => ['h2', 0] },
    blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0] },
    callout: { group: 'block', content: 'block+', isolating: true,
      attrs: { title: { default: '' }, type: { default: 'note' } }, toDOM: () => ['aside', 0] },
    toggle: { group: 'block', content: 'block+', isolating: true,
      attrs: { title: { default: '' }, open: { default: true } }, toDOM: () => ['section', 0] },
    bullet_list: { group: 'block', content: 'list_item+', toDOM: () => ['ul', 0] },
    ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } }, toDOM: () => ['ol', 0] },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } }, toDOM: () => ['li', 0] },
    code_block: { group: 'block', content: 'text*', marks: '', code: true, toDOM: () => ['pre', ['code', 0]] },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: {} }, toDOM: (node) => ['img', { src: node.attrs.src }] },
    table: { group: 'block', content: 'table_row+', toDOM: () => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', toDOM: () => ['tr', 0] },
    table_cell: { content: 'block+', isolating: true, toDOM: () => ['td', 0] },
    text: { group: 'inline' },
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
});

export const p = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : undefined);
export const item = (...children: ProseNode[]) => schema.node('list_item', null, children);
export const bullet = (...children: ProseNode[]) => schema.node('bullet_list', null, children);
export const doc = (...children: ProseNode[]) => schema.node('doc', null, children);
export const wrap = (type: string, ...children: ProseNode[]) => schema.node(type, null, children);

export function textPos(document: ProseNode, text: string): number {
  let result = -1;
  document.descendants((node, pos) => { if (node.isText && node.text === text) result = pos; });
  if (result < 0) throw new Error(`Missing text: ${text}`);
  return result;
}

export function testView(document: ProseNode, from = 1, to = from): EditorView {
  const state = EditorState.create({ doc: document, selection: TextSelection.create(document, from, to), plugins: [history()] });
  const view = {
    state, editable: true, isDestroyed: false, focus: vi.fn(),
    dispatch: vi.fn((tr: Transaction) => { view.state = view.state.apply(tr); }),
  };
  return view as unknown as EditorView;
}
