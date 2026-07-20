import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { describe, expect, it, vi } from 'vitest';

import { createLinkKeymapBindings, createModKLinkCommand } from '../index';
import { resolveLinkKeymapAction } from '../resolveLinkAction';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: { default: '' } },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href') }) }],
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
});

function stateWithSelection(text: string, from: number, to: number, linked = false): EditorState {
  const marks = linked ? [schema.marks.link.create({ href: 'https://example.com' })] : [];
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text, marks)] : []),
  ]);
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

describe('resolveLinkKeymapAction', () => {
  it('expands caret to the current word (add)', () => {
    const state = stateWithSelection('hello world', 3, 3);
    expect(resolveLinkKeymapAction(state)).toEqual({ type: 'add', from: 1, to: 6 });
  });

  it('expands caret in the second word to its own boundaries', () => {
    const state = stateWithSelection('hello world', 9, 9);
    expect(resolveLinkKeymapAction(state)).toEqual({ type: 'add', from: 7, to: 12 });
  });

  it('returns null when caret sits in whitespace with no word around', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a  b')]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    expect(resolveLinkKeymapAction(state)).toBeNull();
  });

  it('returns null for caret in an empty paragraph', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [])]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
    });
    expect(resolveLinkKeymapAction(state)).toBeNull();
  });

  it('edits the whole link when caret is inside a link', () => {
    const state = stateWithSelection('hello', 3, 3, true);
    const action = resolveLinkKeymapAction(state);
    expect(action).not.toBeNull();
    expect(action!.type).toBe('edit');
    if (action!.type === 'edit') {
      expect(action.from).toBe(1);
      expect(action.to).toBe(6);
      expect(action.mark.attrs.href).toBe('https://example.com');
    }
  });

  it('returns add for non-empty selection without link', () => {
    const state = stateWithSelection('hello', 1, 6);
    expect(resolveLinkKeymapAction(state)).toEqual({ type: 'add', from: 1, to: 6 });
  });

  it('returns edit when selection covers a link mark', () => {
    const state = stateWithSelection('hello', 1, 6, true);
    const action = resolveLinkKeymapAction(state);
    expect(action).not.toBeNull();
    expect(action!.type).toBe('edit');
    if (action!.type === 'edit') {
      expect(action.mark.attrs.href).toBe('https://example.com');
      expect(action.from).toBe(1);
      expect(action.to).toBe(6);
    }
  });
});

describe('createLinkKeymapBindings / Mod-k', () => {
  it('binds Mod-k', () => {
    const bindings = createLinkKeymapBindings({ get: () => ({}) } as never);
    expect(Object.keys(bindings)).toEqual(['Mod-k']);
  });

  it('Mod-k expands caret to word and calls addLink', () => {
    const addLink = vi.fn();
    const editLink = vi.fn();
    const cmd = createModKLinkCommand({
      get: () => ({ addLink, editLink }),
    } as never);
    const state = stateWithSelection('hello', 2, 2);
    const dispatch = vi.fn();
    expect(cmd(state, dispatch)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(addLink).toHaveBeenCalledWith(1, 6);
    expect(editLink).not.toHaveBeenCalled();
  });

  it('Mod-k no-ops when caret has no word around', () => {
    const addLink = vi.fn();
    const editLink = vi.fn();
    const cmd = createModKLinkCommand({
      get: () => ({ addLink, editLink }),
    } as never);
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [])]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
    });
    expect(cmd(state)).toBe(false);
    expect(addLink).not.toHaveBeenCalled();
    expect(editLink).not.toHaveBeenCalled();
  });

  it('Mod-k calls addLink on non-empty selection', () => {
    const addLink = vi.fn();
    const editLink = vi.fn();
    const cmd = createModKLinkCommand({
      get: () => ({ addLink, editLink }),
    } as never);
    const state = stateWithSelection('hello', 1, 6);
    expect(cmd(state)).toBe(true);
    expect(addLink).toHaveBeenCalledWith(1, 6);
    expect(editLink).not.toHaveBeenCalled();
  });

  it('Mod-k calls editLink when selection has link', () => {
    const addLink = vi.fn();
    const editLink = vi.fn();
    const cmd = createModKLinkCommand({
      get: () => ({ addLink, editLink }),
    } as never);
    const state = stateWithSelection('hello', 1, 6, true);
    expect(cmd(state)).toBe(true);
    expect(editLink).toHaveBeenCalledTimes(1);
    expect(addLink).not.toHaveBeenCalled();
  });
});
