import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';
import { readFormattingState } from '../formattingState';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: { content: 'text*', group: 'block', attrs: { level: { default: 1 } } },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    text: {},
  },
  marks: { strong: {}, emphasis: {}, link: { attrs: { href: {} } } },
});

const paragraph = () => schema.node('paragraph', null, schema.text('hello'));

it('uses pending typing marks, including explicitly cleared marks', () => {
  let state = EditorState.create({ schema, doc: schema.node('doc', null, paragraph()) });
  state = state.apply(state.tr.setStoredMarks([schema.marks.strong.create()]));
  expect(readFormattingState(state).bold).toBe(true);
  state = state.apply(state.tr.setStoredMarks([]));
  expect(readFormattingState(state).bold).toBe(false);
});

it('reads selected formatting even when the selection begins outside the mark', () => {
  let state = EditorState.create({ schema, doc: schema.node('doc', null, paragraph()) });
  const tr = state.tr.addMark(3, 6, schema.marks.strong.create());
  state = state.apply(tr.setSelection(TextSelection.create(tr.doc, 1, 6)));
  expect(readFormattingState(state).bold).toBe(true);
});

describe('block context', () => {
  it.each([false, true])('recognizes checked=%s tasks without highlighting ordinary bullets', (checked) => {
    const doc = schema.node('doc', null, schema.node('bullet_list', null,
      schema.node('list_item', { checked }, paragraph())));
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3) });
    expect(readFormattingState(state)).toMatchObject({ task: true, bullet: false });
  });
  it('clears the task state when moving to an ordinary list', () => {
    const doc = schema.node('doc', null, schema.node('bullet_list', null,
      schema.node('list_item', null, paragraph())));
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3) });
    expect(readFormattingState(state)).toMatchObject({ task: false, bullet: true });
  });
  it('reflects the current heading level', () => {
    const doc = schema.node('doc', null, schema.node('heading', { level: 2 }, schema.text('title')));
    expect(readFormattingState(EditorState.create({ schema, doc }))).toMatchObject({ h1: false, h2: true, h3: false });
  });
});
