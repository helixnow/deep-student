import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { afterEach, describe, expect, it } from 'vitest';

import { blockSelectionKey, blockSelectionProsePlugin } from '../index';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});

const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach((view) => { view.dom.parentElement?.remove(); view.destroy(); }); });

function mount(texts: string[], caretInBlock = 0, parent: HTMLElement = document.body) {
  const doc = schema.node('doc', null, texts.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])));
  let pos = 1;
  for (let i = 0; i < caretInBlock; i++) pos += doc.child(i).nodeSize;
  const state = EditorState.create({ schema, doc, plugins: [blockSelectionProsePlugin()], selection: TextSelection.create(doc, pos) });
  const host = document.createElement('div');
  parent.appendChild(host);
  const view = new EditorView(host, { state });
  views.push(view);
  return view;
}

const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
  !!view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key, ...init })));
const texts = (view: EditorView) => { const out: string[] = []; view.state.doc.forEach((n) => out.push(n.textContent)); return out; };

describe('block selection', () => {
  it('Esc selects the caret block, decorates it and covers it with the text selection', () => {
    const view = mount(['one', 'two', 'three'], 1);
    expect(press(view, 'Escape')).toBe(true);
    expect(blockSelectionKey.getState(view.state)).toEqual({ anchor: 1, head: 1 });
    expect(view.dom.querySelectorAll('.ds-block-selected')).toHaveLength(1);
    expect(view.dom.classList.contains('ds-block-selecting')).toBe(true);
    const { from, to } = view.state.selection;
    expect(view.state.doc.textBetween(from, to)).toBe('two');
  });

  it('Shift+Arrow extends, Arrow moves, second Esc clears', () => {
    const view = mount(['one', 'two', 'three'], 1);
    press(view, 'Escape');
    press(view, 'ArrowDown', { shiftKey: true });
    expect(blockSelectionKey.getState(view.state)).toEqual({ anchor: 1, head: 2 });
    expect(view.dom.querySelectorAll('.ds-block-selected')).toHaveLength(2);
    press(view, 'ArrowUp');
    expect(blockSelectionKey.getState(view.state)).toEqual({ anchor: 1, head: 1 });
    press(view, 'Escape');
    expect(blockSelectionKey.getState(view.state)).toBeNull();
    expect(view.dom.classList.contains('ds-block-selecting')).toBe(false);
  });

  it('Backspace deletes whole blocks and keeps a valid document', () => {
    const view = mount(['one', 'two', 'three'], 0);
    press(view, 'Escape');
    press(view, 'ArrowDown', { shiftKey: true });
    press(view, 'Backspace');
    expect(texts(view)).toEqual(['three']);
    expect(blockSelectionKey.getState(view.state)).toBeNull();

    press(view, 'Escape');
    press(view, 'Delete');
    expect(texts(view)).toEqual(['']);
  });

  it('Mod-D duplicates the selection after itself and selects the copy', () => {
    const view = mount(['one', 'two'], 0);
    press(view, 'Escape');
    press(view, 'd', { metaKey: true });
    expect(texts(view)).toEqual(['one', 'one', 'two']);
    expect(blockSelectionKey.getState(view.state)).toEqual({ anchor: 1, head: 1 });
  });

  it('Enter returns to editing at the end of the block; typing exits block mode', () => {
    const view = mount(['one', 'two'], 0);
    press(view, 'Escape');
    press(view, 'Enter');
    expect(blockSelectionKey.getState(view.state)).toBeNull();
    expect(view.state.selection.from).toBe(4);

    press(view, 'Escape');
    expect(press(view, 'x')).toBe(false);
    expect(blockSelectionKey.getState(view.state)).toBeNull();
  });

  it('leaves Escape to focus mode and AI review surfaces', () => {
    const shell = document.createElement('div');
    shell.className = 'notes-crepe-shell';
    shell.setAttribute('data-focus-mode', 'true');
    document.body.appendChild(shell);
    const view = mount(['one'], 0, shell);
    expect(press(view, 'Escape')).toBe(false);
    shell.setAttribute('data-focus-mode', 'false');
    const review = document.createElement('section');
    review.className = 'notes-ai-diff-inline';
    shell.appendChild(review);
    expect(press(view, 'Escape')).toBe(false);
    review.remove();
    expect(press(view, 'Escape')).toBe(true);
    shell.remove();
  });
});
