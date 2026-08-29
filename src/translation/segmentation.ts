/**
 * 翻译双语对照的统一分段/对齐规则
 *
 * 供工作台对照视图（ComparisonView）与只读查看器（TranslationViewerWrapper）
 * 共用，保证同一份译文在两处的分段结果一致：
 * - 段落级：按空行（连续 2+ 换行）切分，段落数一致时按段硬配对；
 * - 段落数不一致：双方按句子重切、按比例分桶对齐（usedSentenceFallback=true，
 *   调用方应明示「按句对齐」而非静默错位）。
 */

/**
 * 换行归一：CRLF（\r\n）与孤立 CR（\r）统一为 LF。
 * Windows 粘贴/文件导入的文本不归一会导致 \r\n\r\n 不被识别为空行分隔。
 */
const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * 按段落切分（空行分隔；空白段丢弃）。
 * 「空行」允许含空格/制表符（如 "\n  \n"）——仅有空白字符的行同样视为段落边界。
 */
export const splitParagraphs = (text: string): string[] =>
  normalizeNewlines(text)
    .split(/\n(?:[ \t]*\n)+/)
    .map((p) => p.trim())
    .filter(Boolean);

/**
 * 句子级切分：兼顾 CJK（。！？；）与西文（. ! ? ;）终止符，
 * 保留终止符本身，忽略纯空白片段。
 */
export const splitSentences = (text: string): string[] => {
  const matches = normalizeNewlines(text).match(/[^。！？；.!?;\n]+[。！？；.!?;]*/g);
  return (matches ?? []).map((s) => s.trim()).filter(Boolean);
};

export interface AlignedPair {
  src: string;
  tgt: string;
}

export interface AlignmentResult {
  pairs: AlignedPair[];
  /** 段落数不一致、退化到句子对齐 */
  usedSentenceFallback: boolean;
}

/**
 * 对齐策略：
 * 1. 段落数一致 → 直接按段配对（最稳）。
 * 2. 段落数不一致 → 双方按句子重切；按比例分桶对齐，
 *    并通过 usedSentenceFallback 明确提示「按句对齐」而非静默错位。
 */
export const alignTexts = (sourceText: string, translatedText: string): AlignmentResult => {
  const srcParas = splitParagraphs(sourceText);
  const tgtParas = splitParagraphs(translatedText);

  if (srcParas.length === tgtParas.length || tgtParas.length === 0) {
    const maxLen = Math.max(srcParas.length, tgtParas.length);
    const pairs: AlignedPair[] = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({ src: srcParas[i] || '', tgt: tgtParas[i] || '' });
    }
    return { pairs, usedSentenceFallback: false };
  }

  // 段落数不一致：句子级启发式
  const srcSents = splitSentences(sourceText);
  const tgtSents = splitSentences(translatedText);
  if (srcSents.length === 0 || tgtSents.length === 0) {
    const maxLen = Math.max(srcParas.length, tgtParas.length);
    const pairs: AlignedPair[] = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({ src: srcParas[i] || '', tgt: tgtParas[i] || '' });
    }
    return { pairs, usedSentenceFallback: false };
  }

  // 以较少的一侧为行数，按比例把较多一侧的句子分桶合并
  const rows = Math.min(srcSents.length, tgtSents.length);
  const bucket = (sents: string[], rowCount: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const start = Math.round((i * sents.length) / rowCount);
      const end = Math.round(((i + 1) * sents.length) / rowCount);
      out.push(sents.slice(start, end).join(' '));
    }
    return out;
  };
  const srcRows = bucket(srcSents, rows);
  const tgtRows = bucket(tgtSents, rows);
  const pairs: AlignedPair[] = srcRows.map((src, i) => ({ src, tgt: tgtRows[i] || '' }));
  return { pairs, usedSentenceFallback: true };
};
