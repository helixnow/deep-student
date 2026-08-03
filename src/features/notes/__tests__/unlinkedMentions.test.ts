import { describe, expect, it } from 'vitest';

import { findUnlinkedMentions } from '../unlinkedMentions';

describe('findUnlinkedMentions', () => {
  it('finds case-insensitive plain-text mentions with original casing', () => {
    const markdown = 'calculus is fun. See CALCULUS basics and Calculus advanced.';
    const mentions = findUnlinkedMentions(markdown, 'Calculus');
    expect(mentions.map((m) => m.text)).toEqual(['calculus', 'CALCULUS', 'Calculus']);
    expect(mentions[0]).toMatchObject({ start: 0, end: 'calculus'.length });
  });

  it('skips occurrences already covered by wiki links and note mentions', () => {
    const markdown = [
      'Linked: [[Calculus]] and [[Calculus|the calculus note]].',
      'Mentioned: [Calculus](note://note_calc).',
      'Plain: calculus once more.',
    ].join('\n');
    const mentions = findUnlinkedMentions(markdown, 'Calculus');
    expect(mentions).toHaveLength(1);
    expect(markdown.slice(mentions[0].start, mentions[0].end)).toBe('calculus');
  });

  it('skips fenced blocks and inline code spans', () => {
    const markdown = [
      '```md',
      'Calculus inside fence',
      '```',
      'Inline `Calculus` stays code, Calculus outside counts.',
    ].join('\n');
    const mentions = findUnlinkedMentions(markdown, 'Calculus');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].text).toBe('Calculus');
  });

  it('enforces ASCII word boundaries but allows CJK adjacency', () => {
    expect(findUnlinkedMentions('Calculusish and precalculus.', 'Calculus')).toHaveLength(0);
    expect(findUnlinkedMentions('我在学微积分呢', '微积分')).toHaveLength(1);
  });

  it('escapes regex metacharacters in titles', () => {
    const mentions = findUnlinkedMentions('See C++ (advanced) here: c++ (advanced).', 'C++ (advanced)');
    expect(mentions.map((m) => m.text)).toEqual(['C++ (advanced)', 'c++ (advanced)']);
  });

  it('honors maxMentions and rejects too-short titles', () => {
    const markdown = 'aa aa aa aa';
    expect(findUnlinkedMentions(markdown, 'aa', { maxMentions: 2 })).toHaveLength(2);
    expect(findUnlinkedMentions(markdown, 'a')).toHaveLength(0);
    expect(findUnlinkedMentions(markdown, ' ')).toHaveLength(0);
  });
});
