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

  it('counts supplementary-plane CJK characters (surrogate pairs) as single chars', () => {
    // 𠮷 (U+20BB7) 与 𡃁 均为扩展区汉字，按码点各计 1
    const stats = calculateEssayTextStats('𠮷野家𡃁');
    expect(stats.hanChars).toBe(4);
    expect(stats.totalChars).toBe(4);
    expect(stats.nonWhitespaceChars).toBe(4);
  });

  it('treats contractions and hyphenated words as single english words', () => {
    const stats = calculateEssayTextStats("don't well-known it's a state-of-the-art");
    expect(stats.englishWords).toBe(5);
  });

  it('does not count digits or standalone numbers as english words', () => {
    const stats = calculateEssayTextStats('2024 年有 365 天 abc');
    expect(stats.englishWords).toBe(1);
  });

  it('handles CRLF line breaks for line and paragraph counting', () => {
    const stats = calculateEssayTextStats('第一段\r\n\r\n第二段\r\n还是第二段');
    expect(stats.lineCount).toBe(4);
    expect(stats.paragraphCount).toBe(2);
  });

  it('counts whitespace-only input correctly', () => {
    const stats = calculateEssayTextStats('  \n\t ');
    expect(stats.nonWhitespaceChars).toBe(0);
    expect(stats.hanChars).toBe(0);
    expect(stats.paragraphCount).toBe(0);
    expect(stats.totalChars).toBe(5);
  });

  it('classifies fullwidth CJK punctuation separately from ASCII punctuation', () => {
    const stats = calculateEssayTextStats('你好，世界。Hello, world!');
    expect(stats.cnPunctuation).toBe(2);
    expect(stats.enPunctuation).toBe(2);
    expect(stats.punctuationTotal).toBe(4);
  });

  it('counts ASCII symbols like < > + as english punctuation but not \\p{P}', () => {
    const stats = calculateEssayTextStats('a < b + c');
    expect(stats.enPunctuation).toBe(2);
    expect(stats.punctuationTotal).toBe(0);
  });

  it('keeps CJK-word boundary counting stable on long mixed text', () => {
    const chunk = '汉字abc测试 word，';
    const text = chunk.repeat(500);
    const stats = calculateEssayTextStats(text);
    expect(stats.hanChars).toBe(4 * 500);
    expect(stats.englishWords).toBe(2 * 500);
    expect(stats.cnPunctuation).toBe(500);
  });
});
