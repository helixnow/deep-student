import { describe, expect, it } from 'vitest';
import {
  hasValidCloze,
  parseClozeDeletions,
  renderClozeText,
} from '@/features/flashcards/cloze';

describe('flashcard Cloze rendering', () => {
  it('masks and reveals every valid deletion across indices', () => {
    const text = 'Use {{c1::alpha}} with {{c2::beta}} and {{c1::gamma}}.';
    expect(renderClozeText(text, false)).toBe('Use [...] with [...] and [...].');
    expect(renderClozeText(text, true)).toBe('Use alpha with beta and gamma.');
    expect(parseClozeDeletions(text)).toEqual([
      { index: 1, answer: 'alpha', hint: null },
      { index: 2, answer: 'beta', hint: null },
      { index: 1, answer: 'gamma', hint: null },
    ]);
  });

  it('uses the optional hint on the front and the answer on the back', () => {
    const text = 'The capital is {{c1::Paris::city}}.';
    expect(renderClozeText(text, false)).toBe('The capital is [city].');
    expect(renderClozeText(text, true)).toBe('The capital is Paris.');
  });

  it('leaves malformed or empty deletions untouched', () => {
    const text = '{{c0::zero}} {{c1::}} {{cX::bad}} {{c2::open';
    expect(renderClozeText(text, false)).toBe(text);
    expect(parseClozeDeletions(text)).toEqual([]);
    expect(hasValidCloze(text)).toBe(false);
  });
});
