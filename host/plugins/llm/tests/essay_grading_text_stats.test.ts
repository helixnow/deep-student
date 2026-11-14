import { describe, expect, it } from 'vitest';
import { calculateTextStats } from '../src/essay_grading/text_stats.ts';

describe('text_stats.rs', () => {
  it('calculates_mixed_zh_en_stats', () => {
    const text = "你好，world! It's fine.\n第二段……";
    const stats = calculateTextStats(text);
    expect(stats.hanChars).toBe(5);
    expect(stats.englishWords).toBe(3);
    expect(stats.punctuationTotal).toBeGreaterThanOrEqual(5);
    expect(stats.paragraphCount).toBe(1);
    expect(stats.lineCount).toBe(2);
  });

  it('handles_empty_text', () => {
    const stats = calculateTextStats('');
    expect(stats.hanChars).toBe(0);
    expect(stats.englishWords).toBe(0);
    expect(stats.punctuationTotal).toBe(0);
    expect(stats.lineCount).toBe(0);
    expect(stats.paragraphCount).toBe(0);
  });

  it('paragraph_split_handles_windows_newline_and_blank_spaces', () => {
    const text = '第一段\r\n\r\n   \r\n第二段';
    const stats = calculateTextStats(text);
    expect(stats.paragraphCount).toBe(2);
  });

  /** 前端 JS `\s` 包含 U+FEFF（BOM），因此 BOM 不计入非空白字符 */
  it('bom_is_whitespace_like_frontend', () => {
    const text = '\uFEFF你好';
    const stats = calculateTextStats(text);
    expect(stats.totalChars).toBe(3);
    expect(stats.nonWhitespaceChars).toBe(2);
    expect(stats.hanChars).toBe(2);
  });

  /** 前端 JS `\s` 不包含 U+0085（NEL），因此 NEL 计入非空白字符 */
  it('nel_is_not_whitespace_like_frontend', () => {
    const text = 'a\u0085b';
    const stats = calculateTextStats(text);
    expect(stats.nonWhitespaceChars).toBe(3);
  });

  /** 空行中夹杂 BOM 时仍视为段落分隔（与前端 /\r?\n\s*\r?\n/ 一致） */
  it('paragraph_split_treats_bom_blank_line_as_separator', () => {
    const text = '第一段\n\uFEFF\n第二段';
    const stats = calculateTextStats(text);
    expect(stats.paragraphCount).toBe(2);
  });

  /** 英文缩写与连字符按单词整体计数（与前端 EN_WORD_RE 一致） */
  it('english_words_count_contractions_and_hyphens', () => {
    const text = "state-of-the-art isn't don’t two words";
    const stats = calculateTextStats(text);
    expect(stats.englishWords).toBe(5);
  });

  /** 中英文标点分别归类，且互不重复计数 */
  it('cn_and_en_punctuation_are_disjoint', () => {
    const text = '你好，世界。Hello, world!';
    const stats = calculateTextStats(text);
    expect(stats.cnPunctuation).toBe(2);
    expect(stats.enPunctuation).toBe(2);
    expect(stats.punctuationTotal).toBe(4);
  });

  /** 尾部空段不计入段落数 */
  it('trailing_blank_lines_do_not_add_paragraphs', () => {
    const text = '唯一段落\n\n\n';
    const stats = calculateTextStats(text);
    expect(stats.paragraphCount).toBe(1);
  });

  /** 中英混排句子计数：句末标点连用只计一句，文末无标点兜底计一句 */
  it('sentence_count_handles_mixed_zh_en', () => {
    const text = '今天天气很好。我们去公园玩！！This is great. 最后一句没有标点';
    const stats = calculateTextStats(text);
    expect(stats.sentenceCount).toBe(4);
  });

  /** 小数点不计为句号；省略号连用只计一句 */
  it('sentence_count_ignores_decimal_points_and_collapses_ellipsis', () => {
    const text = '圆周率约为3.14，很神奇……真的很神奇。';
    const stats = calculateTextStats(text);
    expect(stats.sentenceCount).toBe(2);
  });

  /** 换行视为句子边界；句末标点后的收尾引号不会多计一句 */
  it('sentence_count_newline_boundary_and_closing_quotes', () => {
    const text = '他说：「走吧。」\n第二行没有句号';
    const stats = calculateTextStats(text);
    expect(stats.sentenceCount).toBe(2);
  });

  it('sentence_count_empty_text_is_zero', () => {
    const stats = calculateTextStats('');
    expect(stats.sentenceCount).toBe(0);
  });
});
