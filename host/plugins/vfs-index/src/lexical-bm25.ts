/**
 * BM25 lexical scoring for the SQLite text-ledger route.
 *
 * Ported from `crates/dstu-vfs/src/vfs/lexical_bm25.rs`, which itself follows
 * BA7MLV/wangke-agent `src/harness/lexical.ts`:
 * - CJK runs emit every unigram and adjacent bigram; latin/number runs stay whole.
 * - Non-negative idf: `ln(1 + (N - df + 0.5) / (df + 0.5))`.
 * - Coverage bonus: `score *= 1 + bonus * matched / queryTerms`.
 * All accumulation runs in query-term order over arrays, so equal inputs produce
 * bit-identical scores and a stable ranking.
 */

export const MAX_SCORED_DOC_CHARS = 12_000;

export interface Bm25Options {
  /** Term-frequency saturation. */
  readonly k1: number;
  /** Length-normalisation strength (0 = none, 1 = full). */
  readonly b: number;
  /** Coverage bonus factor; 0 disables it. */
  readonly coverageBonus: number;
}

export function defaultBm25Options(): Bm25Options {
  return { k1: 1.2, b: 0.75, coverageBonus: 0.5 };
}

/** CJK ideographs and Japanese kana; full-width punctuation is a separator. */
export function isCjkChar(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
  );
}

const wordCharacter = /[\p{L}\p{N}]/u;

function isWordChar(character: string): boolean {
  return !isCjkChar(character) && wordCharacter.test(character);
}

/** Calls `emit` for every token of an already lower-cased `text`, in text order. */
function forEachToken(text: string, emit: (token: string) => void): void {
  const chars = [...text];
  let index = 0;
  while (index < chars.length) {
    const character = chars[index]!;
    if (isCjkChar(character)) {
      let end = index + 1;
      while (end < chars.length && isCjkChar(chars[end]!)) end += 1;
      const count = end - index;
      for (let position = 0; position < count; position += 1) {
        emit(chars.slice(index + position, index + position + 1).join(''));
        if (position + 2 <= count) {
          emit(chars.slice(index + position, index + position + 2).join(''));
        }
      }
      index = end;
    } else if (isWordChar(character)) {
      let end = index + 1;
      while (end < chars.length && isWordChar(chars[end]!)) end += 1;
      emit(chars.slice(index, end).join(''));
      index = end;
    } else {
      index += 1;
    }
  }
}

/** Tokenises `text` case-insensitively (see module docs). */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  forEachToken(text.toLowerCase(), (token) => tokens.push(token));
  return tokens;
}

/** Non-negative BM25 idf. */
export function bm25Idf(docCount: number, docFreq: number): number {
  const n = docCount;
  const df = docFreq;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function headChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * Scores every document against the (deduplicated, ordered) query terms.
 * Returns one score per input document, in input order; non-matches score 0.
 */
export function bm25Scores(
  terms: readonly string[],
  docs: readonly string[],
  options: Bm25Options = defaultBm25Options(),
): number[] {
  const docCount = docs.length;
  if (terms.length === 0 || docCount === 0) return new Array<number>(docCount).fill(0);

  const termSlot = new Map<string, number>();
  terms.forEach((term, slot) => termSlot.set(term, slot));

  const termFreqs: number[][] = Array.from({ length: docCount }, () => new Array<number>(terms.length).fill(0));
  const docLens = new Array<number>(docCount).fill(0);
  const docFreqs = new Array<number>(terms.length).fill(0);

  docs.forEach((doc, docIndex) => {
    const lowered = headChars(doc, MAX_SCORED_DOC_CHARS).toLowerCase();
    docLens[docIndex] = [...lowered].length;
    const freqs = termFreqs[docIndex]!;
    forEachToken(lowered, (token) => {
      const slot = termSlot.get(token);
      if (slot !== undefined) freqs[slot] = freqs[slot]! + 1;
    });
    freqs.forEach((freq, slot) => {
      if (freq > 0) docFreqs[slot] = docFreqs[slot]! + 1;
    });
  });

  const totalLen = docLens.reduce((sum, len) => sum + len, 0);
  const avgLen = totalLen === 0 ? 1 : totalLen / docCount;
  const idfs = docFreqs.map((df) => bm25Idf(docCount, df));

  return termFreqs.map((freqs, docIndex) => {
    const len = docLens[docIndex]!;
    const lenNorm = 1 - options.b + options.b * (len / avgLen);
    let score = 0;
    let matched = 0;
    freqs.forEach((freq, slot) => {
      if (freq === 0) return;
      matched += 1;
      const tf = freq;
      score += idfs[slot]! * ((tf * (options.k1 + 1)) / (tf + options.k1 * lenNorm));
    });
    if (score <= 0) return 0;
    if (options.coverageBonus > 0) {
      score *= 1 + options.coverageBonus * (matched / terms.length);
    }
    return score;
  });
}
