import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { vi } from 'vitest';
import { installSearchWorkerHarness } from './searchWorkerTestHarness';
import {
  collectSearchMatches,
  collectSearchMatchesAsync,
  replaceAllSearchMatches,
  compileSearchRegex,
  expandReplacement,
  type SearchOptions,
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

function collectRegexWithBudget(doc: ReturnType<typeof docFromText>, query: string, options: SearchOptions = {}) {
  return collectSearchMatchesAsync(doc, query, { ...options, useRegex: true });
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
  let harness: ReturnType<typeof installSearchWorkerHarness>;
  beforeEach(() => { harness = installSearchWorkerHarness(); });
  afterEach(() => harness.cleanup());
  it('matches with a regex pattern (case-insensitive by default)', async () => {
    const doc = docFromText('Foo1 foo2 bar3');
    const matches = await collectRegexWithBudget(doc, 'foo\\d');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ from: 1, to: 5 });
  });

  it('respects caseSensitive in regex mode', async () => {
    const doc = docFromText('Foo foo');
    expect(await collectRegexWithBudget(doc, 'Foo', { caseSensitive: true }))
      .toHaveLength(1);
  });

  it('reports invalid regex from the worker', async () => {
    const doc = docFromText('anything');
    await expect(collectRegexWithBudget(doc, '([')).rejects.toThrow('invalid_regex');
  });

  it('skips zero-length regex matches without looping forever', async () => {
    const doc = docFromText('abc');
    expect(await collectRegexWithBudget(doc, 'x*')).toEqual([]);
  });

  it('advances zero-width matches over emoji and still finds later text', async () => {
    expect(await collectRegexWithBudget(docFromText('😀x😀'), 'x*')).toEqual([
      { from: 3, to: 4, captures: ['x'] },
    ]);
    expect(await collectRegexWithBudget(docFromText('😀'), '$')).toEqual([]);
  });

  it('also advances zero-width matches when a legacy pattern falls back from Unicode mode', async () => {
    expect(compileSearchRegex('\\a*', false)?.unicode).toBe(false);
    expect(await collectRegexWithBudget(docFromText('😀a'), '\\a*')).toEqual([
      { from: 3, to: 4, captures: ['a'] },
    ]);
  });

  it('advances rejected whole-word matches over astral letters', async () => {
    expect(await collectRegexWithBudget(docFromText('𐐀xcat cat'), '𐐀x|cat', { wholeWord: true })).toEqual([
      { from: 8, to: 11, captures: ['cat'] },
    ]);
  });

  it('retries inside a rejected emoji/barrier match without skipping later valid text', async () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('😀'),
        schema.node('hard_break'),
        schema.text('cat'),
      ]),
    ]);
    expect(await collectRegexWithBudget(doc, '😀.cat|cat')).toEqual([
      { from: 4, to: 7, captures: ['cat'] },
    ]);
  });

  it('keeps accepted regex matches non-overlapping across marks', async () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('😀', [schema.marks.strong.create()]),
        schema.text('😀😀'),
      ]),
    ]);
    const state = EditorState.create({ schema, doc });
    const matches = await collectRegexWithBudget(doc, '😀😀');
    expect(matches).toEqual([{ from: 1, to: 5, captures: ['😀😀'] }]);
    expect(state.apply(replaceAllSearchMatches(state.tr, matches, 'x')).doc.textContent).toBe('x😀');
  });

  it('does not match across a hard break in regex mode', async () => {
    const brokenDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hel'),
        schema.node('hard_break'),
        schema.text('lo'),
      ]),
    ]);
    expect(await collectRegexWithBudget(brokenDoc, 'hel.lo')).toEqual([]);
  });

  it('carries capture groups and expands $1 / $& / $$ in replacements', async () => {
    const doc = docFromText('item-42');
    const matches = await collectRegexWithBudget(doc, 'item-(\\d+)');
    expect(matches).toHaveLength(1);
    expect(matches[0].captures?.[1]).toBe('42');
    expect(expandReplacement('#$1 ($&) $$', matches[0])).toBe('#42 (item-42) $');
  });

  it('replaceAllSearchMatches expands captures per match', async () => {
    const state = EditorState.create({ schema, doc: docFromText('a1 b2') });
    const matches = await collectRegexWithBudget(state.doc, '([a-z])(\\d)');
    const transaction = replaceAllSearchMatches(state.tr, matches, '$2$1');
    expect(state.apply(transaction).doc.textContent).toBe('1a 2b');
  });
  it('never executes user regex on the main thread and terminates catastrophic work on cancel', async () => {
    const doc = docFromText('a'.repeat(100000) + '!');
    expect(collectSearchMatches(doc, '(a+)+$', { useRegex: true })).toEqual([]);
    const controller = new AbortController();
    const pending = collectSearchMatchesAsync(doc, '(a+)+$', { useRegex: true }, controller.signal);
    setTimeout(() => controller.abort(), 80);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.terminated).toBe(1);
    expect(await collectRegexWithBudget(docFromText('safe42'), '\\d+')).toHaveLength(1);
  });
  it('terminates catastrophic regex at the execution deadline', async () => {
    await expect(collectRegexWithBudget(docFromText('a'.repeat(100000) + '!'), '(a+)+$')).rejects.toThrow('search_timeout');
    expect(harness.terminated).toBe(1);
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
