import { describe, expect, it } from 'vitest';
import { buildSegments, detectSourceLang } from '../src/policy.ts';

describe('dstu-tutor/translation/pipeline.rs', () => {
  it('detect_japanese_with_kanji_mix', () => { expect(detectSourceLang('東京の天気はとても良いです')).toBe('ja'); });
  it('detect_chinese', () => { expect(detectSourceLang('今天天气很好，我们去公园散步吧。')).toBe('zh-CN'); });
  it('detect_korean', () => { expect(detectSourceLang('오늘 날씨가 정말 좋아요')).toBe('ko'); });
  it('detect_english', () => { expect(detectSourceLang('The quick brown fox jumps over the lazy dog')).toBe('en'); });
  it('accented_latin_not_reported_as_english', () => { expect(detectSourceLang("Être à côté de la plaque, c'est embêtant")).toBeUndefined(); });
  it('empty_text_returns_none', () => { expect(detectSourceLang('   ')).toBeUndefined(); });
  it('segments_roundtrip_preserves_text', () => {
    const text = '第一段内容。\n\n第二段内容，稍微长一点。\n\n\n第三段。';
    expect(buildSegments(text, 8).map(s => s.content + s.separator).join('')).toBe(text);
  });
  it('small_text_stays_single_segment', () => {
    const text = '短文本。\n\n第二段。';
    const segments = buildSegments(text, 1000);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.content).toBe(text);
  });
  it('oversized_paragraph_falls_back_to_sentence_chunks', () => {
    const text = '这是一句话。'.repeat(50);
    const segments = buildSegments(text, 60);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map(s => s.content + s.separator).join('')).toBe(text);
  });
  it('latin_sentence_chunks_keep_word_spacing', () => {
    const text = 'This is a sentence. '.repeat(30).trimEnd();
    const segments = buildSegments(text, 60);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map(s => s.content + s.separator).join('')).toBe(text);
  });
  it('no_punctuation_text_hard_splits_on_char_boundary', () => {
    const text = '中'.repeat(500);
    const segments = buildSegments(text, 60);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map(s => s.content).join('')).toBe(text);
  });
});
