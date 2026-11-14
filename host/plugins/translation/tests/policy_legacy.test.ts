import { describe, expect, it } from 'vitest';
import { buildSegments, detectSourceLang, isWhitespace, type TextSegment } from '../src/policy.ts';

/**
 * Frozen pre-extraction oracle copied from `dstu-tutor/src/translation/pipeline.rs`
 * (`mod legacy_policy`). The production code under test is
 * `dstu-translation-core::policy`, ported in `src/policy.ts`.
 */
function charLength(text: string): number {
  return Array.from(text).length;
}

function splitParagraphsKeepSeparators(text: string): Array<[string, string]> {
  const parts: Array<[string, string]> = [];
  let paragraph = '';
  const chars = Array.from(text);
  let index = 0;
  while (index < chars.length) {
    const ch = chars[index++]!;
    if (ch !== '\n') { paragraph += ch; continue; }
    let separator = ch;
    let newlineCount = 1;
    while (index < chars.length && ['\n', '\r', ' ', '\t'].includes(chars[index]!)) {
      const next = chars[index++]!;
      if (next === '\n') newlineCount++;
      separator += next;
    }
    if (newlineCount >= 2) {
      if (paragraph === '') {
        if (parts.length > 0) parts[parts.length - 1]![1] += separator;
      } else {
        parts.push([paragraph, separator]);
        paragraph = '';
      }
    } else {
      paragraph += separator;
    }
  }
  if (paragraph !== '') parts.push([paragraph, '']);
  return parts;
}

function splitSentenceChunks(paragraph: string, target: number): TextSegment[] {
  const sentences: string[] = [];
  let current = '';
  for (const ch of paragraph) {
    current += ch;
    if (['。', '！', '？', '；', '.', '!', '?', ';', '\n'].includes(ch)) {
      sentences.push(current);
      current = '';
    }
  }
  if (current !== '') sentences.push(current);

  const chunks: TextSegment[] = [];
  let buffer = '';
  let bufferChars = 0;
  for (const sentence of sentences) {
    const sentenceChars = charLength(sentence);
    if (bufferChars > 0 && bufferChars + sentenceChars > target) {
      chunks.push({ content: buffer, separator: '' });
      buffer = '';
      bufferChars = 0;
    }
    if (sentenceChars > target * 2) {
      if (buffer !== '') {
        chunks.push({ content: buffer, separator: '' });
        buffer = '';
        bufferChars = 0;
      }
      let piece = '';
      let pieceChars = 0;
      for (const ch of sentence) {
        piece += ch;
        pieceChars++;
        if (pieceChars >= target) {
          chunks.push({ content: piece, separator: '' });
          piece = '';
          pieceChars = 0;
        }
      }
      if (piece !== '') chunks.push({ content: piece, separator: '' });
    } else {
      buffer += sentence;
      bufferChars += sentenceChars;
    }
  }
  if (buffer !== '') chunks.push({ content: buffer, separator: '' });

  for (let i = 1; i < chunks.length; i++) {
    const chars = Array.from(chunks[i]!.content);
    let leadingChars = 0;
    while (leadingChars < chars.length && isWhitespace(chars[leadingChars]!)) leadingChars++;
    if (leadingChars > 0) {
      chunks[i - 1]!.separator = chars.slice(0, leadingChars).join('');
      chunks[i]!.content = chars.slice(leadingChars).join('');
    }
  }
  return chunks.filter((chunk) => chunk.content.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') !== '');
}

function legacyBuildSegments(text: string, targetChars: number): TextSegment[] {
  const paragraphs = splitParagraphsKeepSeparators(text);
  if (paragraphs.length === 0) return [{ content: text, separator: '' }];
  const segments: TextSegment[] = [];
  let buffer = '';
  let bufferChars = 0;
  let pendingSeparator = '';
  for (const [content, separator] of paragraphs) {
    const paragraphChars = charLength(content);
    if (paragraphChars > targetChars * 2) {
      if (buffer !== '') {
        segments.push({ content: buffer, separator: pendingSeparator });
        buffer = '';
        pendingSeparator = '';
        bufferChars = 0;
      } else {
        pendingSeparator = '';
      }
      const chunks = splitSentenceChunks(content, targetChars);
      if (chunks.length > 0) chunks[chunks.length - 1]!.separator = separator;
      segments.push(...chunks);
      continue;
    }
    if (bufferChars > 0 && bufferChars + paragraphChars > targetChars) {
      segments.push({ content: buffer, separator: pendingSeparator });
      buffer = '';
      pendingSeparator = '';
      bufferChars = 0;
    }
    if (bufferChars > 0) {
      buffer += pendingSeparator;
      bufferChars += charLength(pendingSeparator);
    }
    pendingSeparator = separator;
    buffer += content;
    bufferChars += paragraphChars;
  }
  if (buffer !== '') segments.push({ content: buffer, separator: pendingSeparator });
  return segments.length === 0 ? [{ content: text, separator: '' }] : segments;
}

function legacyDetectSourceLang(text: string): string | undefined {
  const sample = Array.from(text).filter((ch) => !isWhitespace(ch)).slice(0, 400);
  if (sample.length === 0) return undefined;
  let kana = 0, hangul = 0, han = 0, cyrillic = 0, arabic = 0, thai = 0, devanagari = 0, greek = 0, latin = 0, latinExtended = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) kana++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) hangul++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) han++;
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++;
    else if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f)) arabic++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari++;
    else if (cp >= 0x0370 && cp <= 0x03ff) greek++;
    else if ((cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a)) latin++;
    else if (cp >= 0x00c0 && cp <= 0x024f) latinExtended++;
  }
  const total = sample.length;
  const dominant = (count: number): boolean => count * 5 >= total;
  if (kana > 0 && dominant(kana + han)) return 'ja';
  if (hangul > 0 && dominant(hangul)) return 'ko';
  if (dominant(han)) return 'zh-CN';
  if (dominant(cyrillic)) return 'ru';
  if (dominant(arabic)) return 'ar';
  if (dominant(thai)) return 'th';
  if (dominant(devanagari)) return 'hi';
  if (dominant(greek)) return 'el';
  if (dominant(latin) && latinExtended * 20 < latin) return 'en';
  return undefined;
}

describe('pipeline.rs::legacy_policy', () => {
  it('extracted_policy_matches_pre_migration_implementation', () => {
    const texts = [
      '第一段。\n \nSecond paragraph!\n\n東京の天気。',
      'Hello 😀. '.repeat(500),
      '中'.repeat(5000),
      '\r\n\r\n\u0085A\u00a0B\ufeff\n\nEnd\n\n',
      '오늘 날씨가 좋아요',
      "Être à côté de la plaque, c'est embêtant",
    ];
    for (const text of texts) {
      expect(detectSourceLang(text)).toBe(legacyDetectSourceLang(text));
      for (const target of [1, 8, 60, 2000]) {
        expect(buildSegments(text, target)).toEqual(legacyBuildSegments(text, target));
      }
    }
  });
});
