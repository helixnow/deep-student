import { describe, expect, it } from 'vitest';
import { splitTagDraft } from '../tagDraft';

describe('splitTagDraft', () => {
  it('leaves drafts without a separator untouched', () => {
    expect(splitTagDraft('physics ')).toEqual({ tokens: [], rest: 'physics ' });
  });

  it('commits the text before an ASCII comma typed on a soft keyboard', () => {
    expect(splitTagDraft('physics,')).toEqual({ tokens: ['physics'], rest: '' });
  });

  it('treats the full-width comma from CJK keyboards as a separator', () => {
    expect(splitTagDraft('物理，')).toEqual({ tokens: ['物理'], rest: '' });
  });

  it('splits pasted lists and keeps the trailing draft', () => {
    expect(splitTagDraft(' a , b，,c,  d')).toEqual({ tokens: ['a', 'b', 'c'], rest: '  d' });
  });
});
