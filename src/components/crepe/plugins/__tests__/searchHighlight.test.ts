import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import {
  collectSearchMatches,
  replaceAllSearchMatches,
  compileSearchRegex,
  expandReplacement,
} from '../searchHighlight';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br'],
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: { toDOM: () => ['strong', 0] },
    em: { toDOM: () => ['em', 0] },
  },
});

function docFromText(text: string) {
  return schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]);
}

describe('collectSearchMatches', () => {
  it('matches case-insensitively by default', () => {
    const doc = docFromText('Hello hello HELLO');
    expect(collectSearchMatches(doc, 'hello')).toHaveLength(3);
  });

  it('respects caseSensitive', () => {
    const doc = docFromText('Hello hello HELLO');
    expect(collectSearchMatches(doc, 'hello', { caseSensitive: true })).toHaveLength(1);
  });

  it('wholeWord matches latin word boundaries', () => {
    const doc = docFromText('cat catalog cat');
    const matches = collectSearchMatches(doc, 'cat', { wholeWord: true });
    expect(matches).toHaveLength(2);
  });

  it('does not treat half of an adjacent astral letter as a word boundary', () => {
    const doc = docFromText('\u{10400}cat cat\u{10400} cat');
    const matches = collectSearchMatches(doc, 'cat', { wholeWord: true });

    expect(matches).toEqual([{ from: 13, to: 16 }]);
  });

  it('wholeWord with CJK query falls back to substring match', () => {
    const doc = docFromText('高等数学与高等代数');
    // Without CJK fallback, treating 汉 as word chars would often yield 0 matches
    const matches = collectSearchMatches(doc, '高等', { wholeWord: true });
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('collects non-overlapping ranges for repeated text', () => {
    const doc = docFromText('aaaa');
    expect(collectSearchMatches(doc, 'aa')).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ]);
  });

  it('replaces overlapping input ranges without corrupting a real transaction', () => {
    const state = EditorState.create({ schema, doc: docFromText('aaaa') });
    const transaction = replaceAllSearchMatches(
      state.tr,
      [
        { from: 1, to: 3 },
        { from: 2, to: 4 },
        { from: 3, to: 5 },
      ],
      'b',
    );

    expect(state.apply(transaction).doc.textContent).toBe('bb');
  });

  it('maps expanding lowercase folds back to original document offsets', () => {
    const state = EditorState.create({ schema, doc: docFromText('\u0130\u0130') });
    const matches = collectSearchMatches(state.doc, 'i');
    expect(matches).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);

    const transaction = replaceAllSearchMatches(state.tr, matches, 'x');
    expect(state.apply(transaction).doc.textContent).toBe('xx');
  });

  it('finds and replaces text split across strong and emphasis marks', () => {
    const markedDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('he'),
        schema.text('ll', [schema.marks.strong.create()]),
        schema.text('o', [schema.marks.em.create()]),
      ]),
    ]);
    const state = EditorState.create({ schema, doc: markedDoc });
    const matches = collectSearchMatches(state.doc, 'hello');

    expect(matches).toEqual([{ from: 1, to: 6 }]);
    const transaction = replaceAllSearchMatches(state.tr, matches, 'hi');
    expect(state.apply(transaction).doc.textContent).toBe('hi');
  });

  it('does not match across a hard break', () => {
    const brokenDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hel'),
        schema.node('hard_break'),
        schema.text('lo'),
      ]),
    ]);

    expect(collectSearchMatches(brokenDoc, 'hello')).toEqual([]);
  });
});

describe('regex search', () => {
  it('matches with a regex pattern (case-insensitive by default)', () => {
    const doc = docFromText('Foo1 foo2 bar3');
    const matches = collectSearchMatches(doc, 'foo\\d', { useRegex: true });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ from: 1, to: 5 });
  });

  it('respects caseSensitive in regex mode', () => {
    const doc = docFromText('Foo foo');
    expect(collectSearchMatches(doc, 'Foo', { useRegex: true, caseSensitive: true }))
      .toHaveLength(1);
  });

  it('treats an invalid regex as zero matches', () => {
    const doc = docFromText('anything');
    expect(collectSearchMatches(doc, '([', { useRegex: true })).toEqual([]);
  });

  it('skips zero-length regex matches without looping forever', () => {
    const doc = docFromText('abc');
    expect(collectSearchMatches(doc, 'x*', { useRegex: true })).toEqual([]);
  });

  it('does not match across a hard break in regex mode', () => {
    const brokenDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hel'),
        schema.node('hard_break'),
        schema.text('lo'),
      ]),
    ]);
    expect(collectSearchMatches(brokenDoc, 'hel.lo', { useRegex: true })).toEqual([]);
  });

  it('carries capture groups and expands $1 / $& / $$ in replacements', () => {
    const doc = docFromText('item-42');
    const matches = collectSearchMatches(doc, 'item-(\\d+)', { useRegex: true });
    expect(matches).toHaveLength(1);
    expect(matches[0].captures?.[1]).toBe('42');
    expect(expandReplacement('#$1 ($&) $$', matches[0])).toBe('#42 (item-42) $');
  });

  it('replaceAllSearchMatches expands captures per match', () => {
    const state = EditorState.create({ schema, doc: docFromText('a1 b2') });
    const matches = collectSearchMatches(state.doc, '([a-z])(\\d)', { useRegex: true });
    const transaction = replaceAllSearchMatches(state.tr, matches, '$2$1');
    expect(state.apply(transaction).doc.textContent).toBe('1a 2b');
  });
});

describe('compileSearchRegex', () => {
  it('returns a global regex for a valid pattern', () => {
    const regex = compileSearchRegex('a+', false);
    expect(regex).not.toBeNull();
    expect(regex?.flags).toContain('g');
    expect(regex?.flags).toContain('i');
  });

  it('returns null for invalid syntax and empty query', () => {
    expect(compileSearchRegex('([', false)).toBeNull();
    expect(compileSearchRegex('', false)).toBeNull();
  });
});
