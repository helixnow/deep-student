export interface EssayTextStats {
  hanChars: number;
  englishWords: number;
  punctuationTotal: number;
  cnPunctuation: number;
  enPunctuation: number;
  nonWhitespaceChars: number;
  totalChars: number;
  lineCount: number;
  paragraphCount: number;
}

const HAN_RE = /\p{Script=Han}/gu;
const EN_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const PUNCT_RE = /\p{P}/gu;

const CN_PUNCTUATION = new Set([
  '，', '。', '！', '？', '；', '：', '、', '（', '）', '【', '】', '《', '》', '〈', '〉',
  '「', '」', '『', '』', '〔', '〕', '“', '”', '‘', '’', '—', '–', '…', '．', '·',
]);

const isAsciiPunctuation = (ch: string): boolean => /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch);

const countMatches = (text: string, regex: RegExp): number => {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
};

export function calculateEssayTextStats(text: string): EssayTextStats {
  const safeText = text ?? '';
  let cnPunctuation = 0;
  let enPunctuation = 0;
  let nonWhitespaceChars = 0;

  for (const ch of safeText) {
    if (!/\s/u.test(ch)) nonWhitespaceChars += 1;
    if (CN_PUNCTUATION.has(ch)) {
      cnPunctuation += 1;
    } else if (isAsciiPunctuation(ch)) {
      enPunctuation += 1;
    }
  }

  const lineCount = safeText.length > 0 ? safeText.split(/\r?\n/u).length : 0;
  const paragraphCount = safeText
    .split(/\r?\n\s*\r?\n/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .length;

  return {
    hanChars: countMatches(safeText, HAN_RE),
    englishWords: countMatches(safeText, EN_WORD_RE),
    punctuationTotal: countMatches(safeText, PUNCT_RE),
    cnPunctuation,
    enPunctuation,
    nonWhitespaceChars,
    totalChars: Array.from(safeText).length,
    lineCount,
    paragraphCount,
  };
}
