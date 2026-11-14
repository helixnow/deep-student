/**
 * 作文文本统计（移植 `dstu-tutor/src/essay_grading/text_stats.rs`）。
 *
 * 统计口径与前端 `textStats.ts` 的 JS 正则保持一致：空白字符集显式列出，
 * 不直接使用 `\s`（v 版引擎之外的历史差异见 `isFrontendWhitespace`）。
 */

export interface EssayTextStats {
  /** 中文汉字数（Han script） */
  hanChars: number;
  /** 英文词数 */
  englishWords: number;
  /** 标点总数（Unicode punctuation） */
  punctuationTotal: number;
  /** 中文标点数（常见全角标点） */
  cnPunctuation: number;
  /** 英文标点数（ASCII 标点） */
  enPunctuation: number;
  /** 非空白字符数 */
  nonWhitespaceChars: number;
  /** 总字符数（Unicode scalar count） */
  totalChars: number;
  /** 行数 */
  lineCount: number;
  /** 段落数（按空行分段） */
  paragraphCount: number;
  /** 句子数（中英文句末标点 + 换行/文末兜底） */
  sentenceCount: number;
}

const CN_PUNCTUATION = new Set([
  '，', '。', '！', '？', '；', '：', '、', '（', '）', '【', '】', '《', '》', '〈', '〉', '「',
  '」', '『', '』', '〔', '〕', '“', '”', '‘', '’', '—', '–', '…', '．', '·',
]);

const ASCII_PUNCTUATION = new Set([
  '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=',
  '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~',
]);

/**
 * 与前端 `textStats.ts` 中 JS 正则 `\s` 完全一致的空白字符集。
 *
 * 注意与 Unicode White_Space 属性的两处差异：
 * - JS `\s` 包含 U+FEFF（BOM / 零宽不换行空格）；
 * - JS `\s` 不包含 U+0085（NEL）。
 * 统计口径以前端为准，保证 UI 字数与 prompt 注入的统计块一致。
 */
function isFrontendWhitespace(ch: string): boolean {
  const code = ch.codePointAt(0) ?? -1;
  return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d
    || code === 0x20 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
    || code === 0x3000 || code === 0xfeff;
}

/** 无歧义的句末终结符（'.' 单独用启发式处理，避免小数/缩写误计） */
function isSentenceTerminator(ch: string): boolean {
  return ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?'
    || ch === '…' || ch === '．' || ch === '‽' || ch === '⁉' || ch === '⁈' || ch === '⁇';
}

function isAsciiAlphabetic(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

const HAN_RE = /\p{Script=Han}/gu;
const EN_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const PUNCT_RE = /\p{P}/gu;
/** 段落分隔正则：空白类使用与前端 JS `\s` 一致的显式字符集 */
const PARAGRAPH_RE = /\r?\n[\t\n\x0B\x0C\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\r?\n/;

function countMatches(text: string, pattern: RegExp): number {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (regex.exec(text) !== null) count += 1;
  return count;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(PARAGRAPH_RE)
    .map((part) => {
      const chars = Array.from(part);
      let start = 0;
      let end = chars.length;
      while (start < end && isFrontendWhitespace(chars[start] as string)) start += 1;
      while (end > start && isFrontendWhitespace(chars[end - 1] as string)) end -= 1;
      return chars.slice(start, end).join('');
    })
    .filter((part) => part.length > 0);
}

export function calculateTextStats(text: string): EssayTextStats {
  const hanChars = countMatches(text, HAN_RE);
  const englishWords = countMatches(text, EN_WORD_RE);
  const punctuationTotal = countMatches(text, PUNCT_RE);

  let cnPunctuation = 0;
  let enPunctuation = 0;
  let nonWhitespaceChars = 0;
  let totalChars = 0;

  // 句子计数状态：pending 表示自上一个句末以来出现过"实质内容"
  // （非空白、非标点字符）；句末标点连用（！！、……）只计一句。
  let sentenceCount = 0;
  let pendingSentence = false;
  let prevChar: string | null = null;

  for (const ch of Array.from(text)) {
    totalChars += 1;
    if (!isFrontendWhitespace(ch)) {
      nonWhitespaceChars += 1;
    }
    const isCnPunctuation = CN_PUNCTUATION.has(ch);
    if (isCnPunctuation) {
      cnPunctuation += 1;
    } else if (ASCII_PUNCTUATION.has(ch)) {
      enPunctuation += 1;
    }

    // '.' 仅在紧跟字母后视为句号（排除 3.14 等小数；e.g. 类缩写可接受少量误差）
    const endsSentence = isSentenceTerminator(ch)
      || (ch === '.' && prevChar !== null && isAsciiAlphabetic(prevChar))
      || ch === '\n';
    if (endsSentence) {
      if (pendingSentence) {
        sentenceCount += 1;
        pendingSentence = false;
      }
    } else if (!isFrontendWhitespace(ch) && !isCnPunctuation && !ASCII_PUNCTUATION.has(ch)) {
      pendingSentence = true;
    }
    prevChar = ch;
  }
  if (pendingSentence) {
    sentenceCount += 1;
  }

  const normalizedLineText = text.replace(/\r\n/g, '\n');
  const lineCount = normalizedLineText.length === 0 ? 0 : normalizedLineText.split('\n').length;
  const paragraphCount = splitParagraphs(text).length;

  return {
    hanChars,
    englishWords,
    punctuationTotal,
    cnPunctuation,
    enPunctuation,
    nonWhitespaceChars,
    totalChars,
    lineCount,
    paragraphCount,
    sentenceCount,
  };
}

export function buildStatsPromptBlock(stats: EssayTextStats): string {
  return `【写作统计（系统自动计算）】\n- 中文字数（汉字）: ${stats.hanChars}\n- 英文词数: ${stats.englishWords}\n- 标点总数: ${stats.punctuationTotal}\n- 中文标点: ${stats.cnPunctuation}\n- 英文标点: ${stats.enPunctuation}\n- 非空白字符数: ${stats.nonWhitespaceChars}\n- 总字符数: ${stats.totalChars}\n- 句子数: ${stats.sentenceCount}\n- 段落数: ${stats.paragraphCount}\n- 行数: ${stats.lineCount}\n\n请在判断是否达到字数要求时，优先依据以上统计，不要依据 token 估算。\n\n`;
}
