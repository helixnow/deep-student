/** Paragraph-aware source segmentation, translation_executor.rs:531-586. */
import { isWhitespace } from './policy.ts';

/** `chars[start..end]` ends with `suffix`; every suffix character must be a single code point. */
function endsWithinSegment(chars: readonly string[], start: number, end: number, suffix: string): boolean {
  if (end - start < suffix.length) return false;
  for (let index = 0; index < suffix.length; index++) {
    if (chars[end - suffix.length + index] !== suffix[index]) return false;
  }
  return true;
}

/**
 * Split at the latest paragraph boundary in the latter half of each segment.
 * Newline, whitespace, and hard character boundaries are fallbacks (in that
 * order, so a hard cut never lands mid-word when any whitespace exists in the
 * latter half), and concatenating all returned segments reconstructs the input.
 */
export function splitTranslationText(text: string, maxChars: number): string[] {
  return splitCodePoints(Array.from(text), maxChars);
}

/** {@link splitTranslationText} over the code points of the source. */
export function splitCodePoints(chars: readonly string[], maxChars: number): string[] {
  if (maxChars <= 0) throw new Error('translation segment size must be positive');
  if (chars.length === 0) return [];
  const segments: string[] = [];
  let start = 0;
  const preferredBoundaryAfter = Math.max(Math.trunc(maxChars / 2), 1);

  while (start < chars.length) {
    let charsSeen = 0;
    let hardEnd: number | undefined;
    let paragraphEnd: number | undefined;
    let newlineEnd: number | undefined;
    let whitespaceEnd: number | undefined;

    for (let offset = start; offset < chars.length; offset++) {
      if (charsSeen === maxChars) {
        hardEnd = offset;
        break;
      }
      charsSeen++;
      const character = chars[offset]!;
      if (charsSeen < preferredBoundaryAfter || !isWhitespace(character)) continue;
      const end = offset + 1;
      whitespaceEnd = end;
      if (character !== '\n') continue;
      newlineEnd = end;
      if (endsWithinSegment(chars, start, end, '\n\n') || endsWithinSegment(chars, start, end, '\r\n\r\n')) {
        paragraphEnd = end;
      }
    }

    const end = hardEnd === undefined
      ? chars.length
      : paragraphEnd ?? newlineEnd ?? whitespaceEnd ?? hardEnd;
    if (end <= start) throw new Error('translation segmentation failed to advance');
    segments.push(chars.slice(start, end).join(''));
    start = end;
  }
  return segments;
}
