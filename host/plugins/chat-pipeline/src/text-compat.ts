import { isRustWhitespace } from '../../../platform/util/index.ts';

/** `str::split_whitespace`, including the empty-input case. */
export function rustSplitWhitespace(text: string): string[] {
  const words: string[] = [];
  let word = '';
  for (const char of text) {
    if (isRustWhitespace(char.codePointAt(0)!)) {
      if (word !== '') words.push(word);
      word = '';
    } else word += char;
  }
  if (word !== '') words.push(word);
  return words;
}
