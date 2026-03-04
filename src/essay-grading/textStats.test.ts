import { describe, expect, it } from 'vitest';
import { calculateEssayTextStats } from './textStats';

describe('calculateEssayTextStats', () => {
  it('counts mixed chinese english and punctuation', () => {
    const text = "你好，world! It's fine.\n第二段……";
    const stats = calculateEssayTextStats(text);

    expect(stats.hanChars).toBe(5);
    expect(stats.englishWords).toBe(3);
    expect(stats.punctuationTotal).toBeGreaterThanOrEqual(5);
    expect(stats.cnPunctuation).toBeGreaterThanOrEqual(2);
    expect(stats.enPunctuation).toBeGreaterThanOrEqual(2);
    expect(stats.lineCount).toBe(2);
    expect(stats.paragraphCount).toBe(1);
  });

  it('returns zero stats for empty input', () => {
    const stats = calculateEssayTextStats('');
    expect(stats).toMatchObject({
      hanChars: 0,
      englishWords: 0,
      punctuationTotal: 0,
      cnPunctuation: 0,
      enPunctuation: 0,
      nonWhitespaceChars: 0,
      totalChars: 0,
      lineCount: 0,
      paragraphCount: 0,
    });
  });
});
