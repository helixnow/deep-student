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

const EN_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const HAN_CHAR_RE = /\p{Script=Han}/u;
const PUNCT_CHAR_RE = /\p{P}/u;
const WHITESPACE_CHAR_RE = /\s/u;
const ASCII_PUNCT_CHAR_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

const CN_PUNCTUATION = new Set([
  '，', '。', '！', '？', '；', '：', '、', '（', '）', '【', '】', '《', '》', '〈', '〉',
  '「', '」', '『', '』', '〔', '〕', '“', '”', '‘', '’', '—', '–', '…', '．', '·',
]);

const countMatches = (text: string, regex: RegExp): number => {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(text) !== null) {
    count += 1;
  }
  return count;
};

/**
 * 中英混排字数统计：CJK 按字（Unicode 码点，含扩展区）、英文按词
 * （撇号/连字符连接的整体算一个词）。单趟逐码点扫描，避免多次全文
 * match 产生的中间数组分配。
 */
export function calculateEssayTextStats(text: string): EssayTextStats {
  const safeText = typeof text === 'string' ? text : '';
  let hanChars = 0;
  let punctuationTotal = 0;
  let cnPunctuation = 0;
  let enPunctuation = 0;
  let nonWhitespaceChars = 0;
  let totalChars = 0;

  for (const ch of safeText) {
    totalChars += 1;
    if (WHITESPACE_CHAR_RE.test(ch)) continue;
    nonWhitespaceChars += 1;
    if (HAN_CHAR_RE.test(ch)) {
      hanChars += 1;
      continue;
    }
    if (CN_PUNCTUATION.has(ch)) {
      cnPunctuation += 1;
    } else if (ASCII_PUNCT_CHAR_RE.test(ch)) {
      enPunctuation += 1;
    }
    // punctuationTotal 仅统计 Unicode \p{P}（与 en/cn 分类口径独立：
    // + < = > 等 ASCII 符号计入 enPunctuation 但不属于 \p{P}）
    if (PUNCT_CHAR_RE.test(ch)) {
      punctuationTotal += 1;
    }
  }

  const lineCount = safeText.length > 0 ? safeText.split(/\r?\n/u).length : 0;
  const paragraphCount = safeText
    .split(/\r?\n\s*\r?\n/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .length;

  return {
    hanChars,
    englishWords: countMatches(safeText, EN_WORD_RE),
    punctuationTotal,
    cnPunctuation,
    enPunctuation,
    nonWhitespaceChars,
    totalChars,
    lineCount,
    paragraphCount,
  };
}
