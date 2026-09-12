import { describe, it, expect } from 'vitest';
import { findTypeShortages } from '../paperValidation';

describe('findTypeShortages', () => {
  it('returns empty when every requested count fits the bank', () => {
    const shortages = findTypeShortages(
      { single_choice: 20, essay: 5 },
      { single_choice: 20, essay: 30 },
    );
    expect(shortages).toEqual([]);
  });

  it('flags types whose request exceeds the available count', () => {
    const shortages = findTypeShortages(
      { single_choice: 30, essay: 3 },
      { single_choice: 12, essay: 10 },
    );
    expect(shortages).toEqual([{ questionType: 'single_choice', requested: 30, available: 12 }]);
  });

  it('treats missing bank entries as zero available', () => {
    const shortages = findTypeShortages({ true_false: 1 }, {});
    expect(shortages).toEqual([{ questionType: 'true_false', requested: 1, available: 0 }]);
  });

  it('ignores zero and non-finite requests', () => {
    const shortages = findTypeShortages(
      { single_choice: 0, essay: Number.NaN },
      {},
    );
    expect(shortages).toEqual([]);
  });

  it('does not flag requests within supply even when other types are short', () => {
    const shortages = findTypeShortages(
      { fill_blank: 4, short_answer: 8 },
      { fill_blank: 4 },
    );
    expect(shortages).toEqual([{ questionType: 'short_answer', requested: 8, available: 0 }]);
  });
});
