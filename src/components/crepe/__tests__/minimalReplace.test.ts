import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';
import { minimalReplace } from '../minimalReplace';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});
const doc = (...texts: string[]) => schema.node('doc', null, texts.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])));

describe('minimalReplace', () => {
  it('rewrites only the changed block and keeps untouched node identity', () => {
    const state = EditorState.create({ schema, doc: doc('one', 'two', 'three') });
    const tr = minimalReplace(state, doc('one', 'TWO', 'three'))!;
    expect(tr.doc.eq(doc('one', 'TWO', 'three'))).toBe(true);
    expect(tr.doc.child(0)).toBe(state.doc.child(0));
    expect(tr.doc.child(2)).toBe(state.doc.child(2));
  });

  it('returns null for identical documents', () => {
    const state = EditorState.create({ schema, doc: doc('a', 'b') });
    expect(minimalReplace(state, doc('a', 'b'))).toBeNull();
  });

  it.each([
    [['a', 'b'], ['x', 'a', 'b']],
    [['a', 'b'], ['a', 'b', 'c']],
    [['a', 'b', 'c'], ['a', 'c']],
    [['aaa'], ['aa']],
    [['ab', 'ab'], ['ab']],
    [['a'], ['']],
  ])('matches a full replace for %j → %j', (from, to) => {
    const state = EditorState.create({ schema, doc: doc(...from) });
    const tr = minimalReplace(state, doc(...to))!;
    expect(tr.doc.eq(doc(...to))).toBe(true);
  });
});
