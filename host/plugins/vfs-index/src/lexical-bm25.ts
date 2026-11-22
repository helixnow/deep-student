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

export const MAX_SCORED_DOC_CHARS = 100_000;

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
  if (text.length <= maxChars) return text;
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

function charBefore(text: string, offset: number): string | null {
  if (offset <= 0) return null;
  const code = text.charCodeAt(offset - 1);
  if (code >= 0xdc00 && code <= 0xdfff && offset >= 2) return text.slice(offset - 2, offset);
  return text[offset - 1]!;
}

function charAt(text: string, offset: number): string | null {
  if (offset >= text.length) return null;
  const cp = text.codePointAt(offset);
  return cp === undefined ? null : String.fromCodePoint(cp);
}

function isWholeTokenMatch(text: string, offset: number, term: string): boolean {
  if ([...term].some(isCjkChar)) return true;
  const prev = charBefore(text, offset);
  const next = charAt(text, offset + term.length);
  return (prev === null || !isWordChar(prev)) && (next === null || !isWordChar(next));
}

function earliestMatchedTermOffset(loweredFull: string, terms: readonly string[], minSearchFrom: number): number {
  let earliest = -1;
  for (const term of terms) {
    if (term.length === 0) continue;
    let pos = Math.max(0, minSearchFrom - term.length);
    while (pos < loweredFull.length) {
      const found = loweredFull.indexOf(term, pos);
      if (found < 0) break;
      if (isWholeTokenMatch(loweredFull, found, term)) {
        if (earliest < 0 || found < earliest) earliest = found;
        break;
      }
      pos = found + 1;
    }
  }
  return earliest;
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
    const head = headChars(doc, MAX_SCORED_DOC_CHARS);
    const loweredHead = head.toLowerCase();
    const freqs = termFreqs[docIndex]!;
    forEachToken(loweredHead, (token) => {
      const slot = termSlot.get(token);
      if (slot !== undefined) freqs[slot] = freqs[slot]! + 1;
    });
    if (head.length < doc.length) {
      const loweredFull = doc.toLowerCase();
      docLens[docIndex] = codePointLength(loweredFull);
      if (!freqs.some((freq) => freq > 0)) {
        const earliestOffset = earliestMatchedTermOffset(loweredFull, terms, loweredHead.length);
        if (earliestOffset >= 0) {
          const fullChars = [...loweredFull];
          const charOffset = codePointLength(loweredFull.slice(0, earliestOffset));
          const half = Math.floor(MAX_SCORED_DOC_CHARS / 2);
          const start = Math.max(0, Math.min(charOffset - half, fullChars.length - MAX_SCORED_DOC_CHARS));
          const end = Math.min(fullChars.length, start + MAX_SCORED_DOC_CHARS);
          const windowText = fullChars.slice(start, end).join('');
          forEachToken(windowText, (token) => {
            const slot = termSlot.get(token);
            if (slot !== undefined) freqs[slot] = freqs[slot]! + 1;
          });
        }
      }
    } else {
      docLens[docIndex] = codePointLength(loweredHead);
    }
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
