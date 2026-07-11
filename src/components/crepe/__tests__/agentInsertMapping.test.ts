import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';

import { createAgentInsertTransaction } from '../useCrepeEditor';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
});

function stateFromText(text: string): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, text ? [schema.text(text)] : undefined),
    ]),
  });
}

describe('createAgentInsertTransaction', () => {
  it('maps batched appends to the textblock end without splitting chunks', () => {
    let state = stateFromText('');
    const originalDoc = state.doc;
    let pos = state.doc.content.size;
    let ledgerFrom: number | null = null;
    let ledgerTo: number | null = null;

    for (const chunk of ['abc', 'DEF', 'ghi']) {
      const { transaction, from, to, cursor } = createAgentInsertTransaction(state, chunk, pos);
      if (ledgerFrom === null || ledgerTo === null) {
        ledgerFrom = from;
        ledgerTo = to;
      } else {
        ledgerFrom = Math.min(transaction.mapping.map(ledgerFrom, -1), from);
        ledgerTo = Math.max(transaction.mapping.map(ledgerTo, 1), to);
      }
      state = state.apply(transaction);
      pos = cursor;

      expect(state.doc.resolve(pos).parent.isTextblock).toBe(true);
    }

    expect(state.doc.textContent).toBe('abcDEFghi');
    expect(state.doc.lastChild?.textContent).toBe('abcDEFghi');
    expect(state.doc.childCount).toBe(2);

    const reverted = state.apply(state.tr.delete(ledgerFrom!, ledgerTo!));
    expect(reverted.doc.eq(originalDoc)).toBe(true);
  });
});
