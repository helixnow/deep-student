/**
 * 学术论文 PDF 文本归一化、引文格式化与语义高亮色板。
 *
 * 解决双栏 LaTeX / IEEE / ACL / arXiv 论文阅读的高频痛点：
 * 1. 跨行连字符断词（`trans-\nformer` → `transformer`，同时保留复合词连字符如 `self-\nattention` → `self-attention`）
 * 2. 段内硬换行重排（保留真实段落空行、列表项与中英文混排间距，中文跨行不插多余空格）
 * 3. 私有区连字还原（`ﬁ` → `fi`, `ﬂ` → `fl`）
 * 4. 一键学术引文格式化（行内 `"..." (Title, p. N)` 与带 `pdfref://` 回链的 Markdown 引文）
 */

import { buildPdfQuoteHref } from './pdfSelectionActions';
import { normalizePdfLigatures } from './pdfSearch';

/** 英文学术论文常见复合词前缀：跨行断在这些前缀后时应保留 `-`（如 `self-\nattention` → `self-attention`） */
const COMPOUND_HYPHEN_PREFIXES = new Set([
  'self',
  'non',
  'pre',
  'post',
  'multi',
  'cross',
  'co',
  're',
  'sub',
  'inter',
  'intra',
  'semi',
  'anti',
  'over',
  'under',
  'zero',
  'few',
  'one',
  'two',
  'three',
  'fine',
  'meta',
  'hyper',
  'super',
  'quasi',
  'pseudo',
  'state',
  'end',
  'high',
  'low',
  'long',
  'short',
  'real',
  'open',
  'closed',
  'large',
  'small',
  'full',
  'bi',
  'tri',
  'uni',
  'co',
  'counter',
  'out',
  'up',
  'down',
  'well',
  'ill',
  'task',
  'data',
  'model',
  'domain',
  'time',
  'step',
  'layer',
  'token',
  'scale',
]);

const CJK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_PUNCT_END_RE = /[，。！？；：、）》」』】”’—…]/;
const CJK_PUNCT_START_RE = /[，。！？；：、】（《「『“‘—…]/;

/** 识别列表行或公式编号行，避免段内重排把列表粘成一行（限定 1-2 位序号，避免 2024. 年份误判） */
const STRUCTURED_LINE_START_RE =
  /^\s*(?:[-*•◦▪‣]|\d{1,2}[.)]|\([a-zA-Z0-9ivxIVX]+\)|\[[0-9]{1,4}\])\s+/;

/** 单字母小写前缀后接这些学术量词/术语时保留连字符（如 k-means, n-gram, p-value, t-test, k-fold） */
const SINGLE_LETTER_COMPOUND_SUFFIX_RE =
  /^(?:means|nearest|fold|step|bit|way|shot|hop|gram|grams|ary|dimensional|layer|head|norm|value|values|divergence|test|tests|score|scores|distribution|tree|trees|space|plane|axis|axes|index|band|shell|type|wave|state|states|point|points|class|group|set|form|line|node|edge|path|cycle|graph|clique|core|color|coloring|factor|hull|map|mer|mers|plet|tuple|tuples)\b/i;

function isCjkBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return CJK_CHAR_RE.test(ch) || CJK_PUNCT_END_RE.test(ch) || CJK_PUNCT_START_RE.test(ch);
}

/**
 * 判断两行合并时是否无需插入英文空格（如中文跨行「注意力\n机制」→「注意力机制」）。
 */
function shouldJoinWithoutSpace(prevLine: string, nextLine: string): boolean {
  const lastChar = prevLine[prevLine.length - 1];
  const firstChar = nextLine[0];
  if (!lastChar || !firstChar) return true;
  if (lastChar === '/' || lastChar === '(' || lastChar === '[' || lastChar === '“' || lastChar === '「' || lastChar === '《') {
    return true;
  }
  if (isCjkBoundaryChar(lastChar) && isCjkBoundaryChar(firstChar)) {
    return true;
  }
  if (CJK_PUNCT_END_RE.test(lastChar) || CJK_PUNCT_START_RE.test(firstChar)) {
    return true;
  }
  return false;
}

/**
 * 合并单段内的 PDF 硬换行与跨行断词连字符。
 */
function reflowParagraphLines(lines: string[]): string {
  let acc = '';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim().replace(/[ \t]+/g, ' ');
    if (!trimmed) continue;

    if (!acc) {
      acc = trimmed;
      continue;
    }

    // 新行本身是列表项 / 参考文献条目时保留换行
    if (STRUCTURED_LINE_START_RE.test(trimmed)) {
      acc = `${acc}\n${trimmed}`;
      continue;
    }

    // 处理行尾软连字符（U+00AD）直接无缝拼接
    if (acc.endsWith('\u00ad')) {
      acc = `${acc.slice(0, -1)}${trimmed}`;
      continue;
    }

    // 处理英文行尾连字符断词：`trans-` + `former` vs `self-` + `attention` / `GPT-` + `4`
    const hyphenTail = /([A-Za-z0-9]+)-$/.exec(acc);
    const nextWordHead = /^([A-Za-z0-9]+)/.exec(trimmed);
    if (hyphenTail && nextWordHead) {
      const prefix = hyphenTail[1]!;
      const suffix = nextWordHead[1]!;
      const lowerPrefix = prefix.toLowerCase();
      const preserveHyphen =
        // 后半段首字母大写或纯数字（如 `Cross-\nEntropy`, `GPT-\n4`, `L-\nBFGS`）
        /^[A-Z0-9]/.test(suffix) ||
        // 前半段含大写缩写或数字（如 `3D-\nCNN`, `U-\nNet`）
        /[A-Z0-9]/.test(prefix.slice(1)) ||
        // 单字母前缀：大写（如 `X-\nray`, `B-\nspline`）或接常见学术复合词根（如 `k-\nmeans`, `p-\nvalue`），
        // 避免把普通单词音节断词（如 `a-\nmazing`, `e-\nvaluation`）误保留连字符
        (prefix.length === 1 &&
          (/^[A-Z0-9]$/.test(prefix) || SINGLE_LETTER_COMPOUND_SUFFIX_RE.test(suffix))) ||
        COMPOUND_HYPHEN_PREFIXES.has(lowerPrefix);

      if (preserveHyphen) {
        acc = `${acc}${trimmed}`;
      } else {
        acc = `${acc.slice(0, -1)}${trimmed}`;
      }
      continue;
    }

    if (shouldJoinWithoutSpace(acc, trimmed)) {
      acc = `${acc}${trimmed}`;
    } else {
      acc = `${acc} ${trimmed}`;
    }
  }
  return acc;
}

/**
 * 将 PDF 文本层选区还原为干净的学术文本：
 * - 还原 fi/fl/ff/ffi/ffl 私有区连字与不间断空格
 * - 消除排版软连字符与跨行断词连字符
 * - 合并双栏/单栏硬换行，同时保留真实段落分隔（空行）与列表结构
 */
export function normalizePdfAcademicText(raw: string): string {
  if (!raw) return '';
  const unified = normalizePdfLigatures(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');

  const rawLines = unified.split('\n');
  const paragraphs: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const merged = reflowParagraphLines(buffer);
    if (merged) paragraphs.push(merged);
    buffer = [];
  };

  for (const line of rawLines) {
    if (!line.trim()) {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return paragraphs.join('\n\n').trim();
}

/**
 * 清理 PDF 文件名后缀，生成适合引文展示的文献标题。
 */
export function cleanAcademicDocumentTitle(fileName?: string | null): string {
  if (!fileName) return '';
  return fileName
    .trim()
    .replace(/\.pdf$/i, '')
    .trim();
}

export interface AcademicCitationInput {
  text: string;
  documentTitle?: string | null;
  page?: number;
  sourceId?: string | null;
  style?: 'inline' | 'markdown';
}

/**
 * 生成学术引文字符串：
 * - inline: `"Attention mechanisms have become..." (Vaswani et al., p. 2)`
 * - markdown: 引用块 + 可点击跳回原页的 `pdfref://` 来源行
 */
export function formatAcademicCitation(input: AcademicCitationInput): string {
  const cleanText = normalizePdfAcademicText(input.text);
  if (!cleanText) return '';

  const title = cleanAcademicDocumentTitle(input.documentTitle);
  const validPage =
    typeof input.page === 'number' && Number.isInteger(input.page) && input.page > 0
      ? input.page
      : undefined;

  const metaParts: string[] = [];
  if (title) metaParts.push(title);
  if (validPage !== undefined) metaParts.push(`p. ${validPage}`);
  const metaLabel = metaParts.join(', ');

  if (input.style === 'markdown') {
    const quoted = cleanText
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    if (!metaLabel) return quoted;
    const trimmedSourceId = input.sourceId?.trim();
    if (trimmedSourceId && validPage !== undefined) {
      const href = buildPdfQuoteHref(trimmedSourceId, validPage, cleanText);
      return `${quoted}\n\n— [${metaLabel}](${href})`;
    }
    return `${quoted}\n\n— ${metaLabel}`;
  }

  const singleLineQuote = cleanText.replace(/\n+/g, ' ');
  return metaLabel ? `"${singleLineQuote}" (${metaLabel})` : `"${singleLineQuote}"`;
}

// ============================================================================
// 学术批注五色语义色板（对标 Zotero 7 / MarginNote 学术配色）
// ============================================================================

export const ACADEMIC_HIGHLIGHT_COLORS = {
  yellow: '#fef08a',
  green: '#bbf7d0',
  blue: '#bfdbfe',
  red: '#fecaca',
  purple: '#e9d5ff',
} as const;

export type AcademicHighlightColorKey = keyof typeof ACADEMIC_HIGHLIGHT_COLORS;

const COLOR_HEX_TO_KEY: Record<string, AcademicHighlightColorKey> = {
  '#fef08a': 'yellow',
  '#bbf7d0': 'green',
  '#bfdbfe': 'blue',
  '#fecaca': 'red',
  '#e9d5ff': 'purple',
};

/**
 * 将十六进制颜色解析为预定义学术语义键（自定义未知颜色返回 null）。
 */
export function resolveHighlightSemanticKey(
  color: string | null | undefined,
): AcademicHighlightColorKey | null {
  if (!color) return null;
  return COLOR_HEX_TO_KEY[color.trim().toLowerCase()] ?? null;
}
