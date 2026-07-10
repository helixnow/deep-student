import { Schema } from '@milkdown/prose/model';
import { collectSearchMatches } from '../searchHighlight';

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

  it('wholeWord with CJK query falls back to substring match', () => {
    const doc = docFromText('高等数学与高等代数');
    // Without CJK fallback, treating 汉 as word chars would often yield 0 matches
    const matches = collectSearchMatches(doc, '高等', { wholeWord: true });
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
