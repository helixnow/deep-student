/**
 * 文档分段的无重叠切分：token 估算、按段落/行/句/字符切分与硬切点吸附。
 */
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { charCount, isRustWhitespace, rustTrim, rustTrimEnd, rustTrimStart } from '../../../platform/util/index.ts';
import {
  DEFAULT_MAX_TOKENS_PER_SEGMENT,
  MIN_TOKENS_PER_SEGMENT,
  F32_0_2,
  F32_1_3,
  SENTENCE_END_SET,
  countOccurrences,
  isRustFloat,
  rustLines,
  splitInclusiveSentenceEnds,
} from './document-processing-text.ts';

export function estimateTokens(text: string): number {
  if (text === '') return 0;

  // Rust 侧逐项用 f32 运算后截断，这里用 Math.fround 精确复刻 f32 累加/乘法。
  let totalChars = 0;
  let chineseChars = 0;
  let wordCount = 0;
  let inWord = false;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    i += code > 0xffff ? 2 : 1;
    totalChars += 1;
    if (code >= 0x4e00 && code <= 0x9fff) {
      chineseChars += 1; // 基本汉字范围
    }
    // F4's Rust White_Space predicate has no members above U+3000. Avoid an
    // always-false call for CJK/kana/Hangul/emoji; keep the shared table below it.
    if (code <= 0x3000 && isRustWhitespace(code)) {
      inWord = false;
    } else if (!inWord) {
      wordCount += 1;
      inWord = true;
    }
  }

  const otherChars = totalChars - chineseChars;
  const estimatedTokens =
    chineseChars
    + Math.trunc(Math.fround(Math.fround(wordCount) * F32_1_3))
    + Math.trunc(Math.fround(Math.fround(otherChars) * F32_0_2));

  return Math.max(estimatedTokens, Math.trunc(totalChars / 4)); // 最少不低于字符数的1/4
}

/**
 * 计算每个分段的最大 token 数。
 *
 * - 默认 {@link DEFAULT_MAX_TOKENS_PER_SEGMENT}（10k，足以容纳完整章节/知识单元）；
 * - 用户设置了较小的 `max_output_tokens_override` / `max_tokens` 时，输入预算取其一半；
 * - 结果永远 ≥ {@link MIN_TOKENS_PER_SEGMENT}，修复旧实现 `max_tokens=0/1` 时预算为 0
 *   导致按字符硬切死循环的问题。
 */
export function calculateMaxTokensPerSegment(options: AnkiGenerationOptions): number {
  const baseLimit = DEFAULT_MAX_TOKENS_PER_SEGMENT;

  const maxTokens = options.max_output_tokens_override ?? options.max_tokens ?? null;
  if (maxTokens !== null && maxTokens < baseLimit * 2) {
    // 如果输出限制较小，输入也应该相应减少
    const derived = Math.min(baseLimit, Math.trunc(maxTokens / 2));
    return Math.max(derived, MIN_TOKENS_PER_SEGMENT);
  }

  return baseLimit;
}

/**
 * 无重叠的文档分段：段落边界优先。
 *
 * 按 `\n\n` 切分段落后贪心聚合：能放进当前分段就追加，放不下就另起新段；
 * 单段落超预算时降级为句子切分（{@link splitLongParagraph}）。
 * 因此只要段落本身不超预算，**返回的每个分段都由完整段落拼接而成**。
 */
export function segmentWithoutOverlap(
  content: string,
  maxTokensPerSegment: number,
  snapBoundaries: boolean,
): string[] {
  // 按自然段落分割
  const paragraphs = content.split('\n\n').filter((paragraph) => rustTrim(paragraph) !== '');

  const segments: string[] = [];
  let currentSegment = '';
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);

    // 如果单个段落就超过限制，需要进一步分割
    if (paragraphTokens > maxTokensPerSegment) {
      const subSegments = splitLongParagraph(paragraph, maxTokensPerSegment, snapBoundaries);
      // 很短的前导段（如「# 词表.xlsx」标题）并入下一段开头：单独成段时模型拿到的
      // 只有一个标题，会凭空编卡（实测标题段产出 12 张与资料无关的卡）
      const lead = rustTrim(currentSegment);
      const leadTokens = estimateTokens(lead);
      if (lead !== '') {
        // 前导段不超过预算 10% 时直接并入（允许下一段略超预算，远好过一段只有标题）
        const first = subSegments[0];
        if (first !== undefined && leadTokens * 10 <= maxTokensPerSegment) {
          subSegments[0] = `${lead}\n\n${first}`;
        } else {
          segments.push(lead);
        }
      }
      currentSegment = '';
      currentTokens = 0;
      segments.push(...subSegments);
      continue;
    }

    // 检查添加这个段落是否会超出限制
    if (currentTokens + paragraphTokens > maxTokensPerSegment && currentSegment !== '') {
      // 保存当前分段并开始新分段
      if (rustTrim(currentSegment) !== '') {
        segments.push(rustTrim(currentSegment));
      }
      currentSegment = paragraph;
      currentTokens = paragraphTokens;
    } else {
      // 添加到当前分段
      if (currentSegment !== '') {
        currentSegment += '\n\n';
      }
      currentSegment += paragraph;
      currentTokens += paragraphTokens;
    }
  }

  // 添加最后一个分段
  if (rustTrim(currentSegment) !== '') {
    segments.push(rustTrim(currentSegment));
  }

  // 确保至少有一个分段
  if (segments.length === 0) {
    segments.push(content);
  }

  return segments;
}

/**
 * 分割过长的段落：多行段落（表格 / 词表 / 列表）先按行聚合，单行不拆；
 * 其余先按句末标点切句，超预算的单句按字符硬切。
 */
function splitLongParagraph(
  paragraph: string,
  maxTokens: number,
  snapBoundaries: boolean,
): string[] {
  const lines = rustLines(paragraph).filter((line) => rustTrim(line) !== '');
  if (lines.length > 1) {
    return splitByLines(lines, maxTokens, snapBoundaries);
  }
  return splitBySentences(paragraph, maxTokens, snapBoundaries);
}

/** 识别制表符 / 竖线表格的表头：前 3 行里第一个与下一行列数相同（≥2 列）的行。 */
export function detectTableHeader(lines: readonly string[]): string | null {
  const columns = (line: string): number => {
    if (line.includes('\t')) {
      return line.split('\t').length;
    }
    if (rustTrimStart(line).startsWith('|')) {
      return countOccurrences(line, '|');
    }
    return 0;
  };
  // 表头特征：每格都是短文本且不是数字。否则段落首个数据行（如「explicit\t/ɪk…/\t…例句…」）
  // 会被当成表头，在后续每段开头重复
  const headerLike = (line: string): boolean =>
    line
      .split(/[\t|]/)
      .map((cell) => rustTrim(cell))
      .filter((cell) => cell !== '')
      .every((cell) => charCount(cell) <= 24 && !isRustFloat(cell));

  const pairCount = Math.min(3, Math.max(0, lines.length - 1));
  for (let index = 0; index < pairCount; index += 1) {
    const current = lines[index]!;
    const next = lines[index + 1]!;
    const n = columns(current);
    if (n >= 2 && n === columns(next) && headerLike(current)) return current;
  }
  return null;
}

/**
 * 按行聚合分段：表格行、词表行绝不从中间切断（按句末标点切会在例句译文的「。」处
 * 把一行拆进两段，被切断的词两边都不完整，模型直接丢掉——60 词只出 45 张卡）。
 * 表格在后续每段开头重复表头，模型才知道每列是什么。
 */
export function splitByLines(
  lines: readonly string[],
  maxTokens: number,
  snapBoundaries: boolean,
): string[] {
  const header = detectTableHeader(lines);
  const headerTokens = header === null ? 0 : estimateTokens(header);
  // 表头本身就吃掉大半预算时不重复，避免每段只剩一两行
  const repeatHeader = header !== null && headerTokens * 4 < maxTokens ? header : null;

  const segments: string[] = [];
  let current = '';
  let currentTokens = 0;
  let currentHasRows = false;
  let headerSeen = false;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    const isHeader = header !== null && header === line && !headerSeen;
    if (isHeader) {
      headerSeen = true;
    }

    if (lineTokens > maxTokens) {
      if (currentHasRows) {
        segments.push(rustTrimEnd(current));
      }
      current = '';
      currentTokens = 0;
      currentHasRows = false;
      segments.push(...splitBySentences(line, maxTokens, snapBoundaries));
      continue;
    }

    if (currentTokens + lineTokens > maxTokens && currentHasRows) {
      segments.push(rustTrimEnd(current));
      current = '';
      currentTokens = 0;
      currentHasRows = false;
      if (repeatHeader !== null && headerSeen) {
        current += repeatHeader;
        current += '\n';
        currentTokens = headerTokens;
      }
    }

    current += line;
    current += '\n';
    currentTokens += lineTokens;
    if (!isHeader) {
      currentHasRows = true;
    }
  }

  if (currentHasRows || segments.length === 0) {
    const tail = rustTrimEnd(current);
    if (tail !== '') {
      segments.push(tail);
    }
  }

  return segments;
}

/** 按句末标点切句聚合，超预算的单句按字符硬切。 */
export function splitBySentences(
  paragraph: string,
  maxTokens: number,
  snapBoundaries: boolean,
): string[] {
  // 按句子分割
  const sentences = splitInclusiveSentenceEnds(paragraph).filter((sentence) => rustTrim(sentence) !== '');

  const segments: string[] = [];
  let currentSegment = '';
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    // 如果单个句子就超过限制，按字符数强制分割
    if (sentenceTokens > maxTokens) {
      // 先保存当前分段
      if (rustTrim(currentSegment) !== '') {
        segments.push(rustTrim(currentSegment));
      }
      currentSegment = '';
      currentTokens = 0;

      // 按字符数分割长句子（硬切点可选边界吸附）
      const charSegments = splitByCharacters(sentence, maxTokens, snapBoundaries);
      segments.push(...charSegments);
      continue;
    }

    if (currentTokens + sentenceTokens > maxTokens && currentSegment !== '') {
      if (rustTrim(currentSegment) !== '') {
        segments.push(rustTrim(currentSegment));
      }
      currentSegment = sentence;
      currentTokens = sentenceTokens;
    } else {
      currentSegment += sentence;
      currentTokens += sentenceTokens;
    }
  }

  if (rustTrim(currentSegment) !== '') {
    segments.push(rustTrim(currentSegment));
  }

  return segments;
}

/**
 * 按字符强制分割（token 感知）。
 *
 * 修复两个旧实现的真实 bug：
 * 1. 旧实现用 `max_chars = max_tokens * 2` 的粗略换算，对 CJK（≈1 token/字）
 *    会产出约 2 倍超预算的分段；现在对切点做二分搜索，保证每段
 *    `estimateTokens(segment) <= max_tokens`（除非单个字符本身就超预算）。
 * 2. 旧实现 `max_tokens=0` 时 `max_chars=0`，`start` 永不前进 → 死循环；
 *    现在预算钳制为 ≥1 且每轮至少消费 1 个字符，保证终止。
 *
 * 始终在 `char` 边界切割（绝不切坏 UTF-8/CJK/emoji 标量值）；
 * `snapBoundaries` 开启时对硬切点执行 {@link snapCutToBoundary} 规则吸附。
 * 不做 trim：所有非纯空白分段拼接后与原文逐字节一致（纯空白块被跳过但仍推进游标）。
 */
export function splitByCharacters(
  text: string,
  maxTokens: number,
  snapBoundaries: boolean,
): string[] {
  if (text === '') {
    return [];
  }
  const budget = Math.max(maxTokens, 1);
  const chars = Array.from(text);
  const segments: string[] = [];

  let start = 0;
  while (start < chars.length) {
    // 二分搜索最大的 end 使 estimateTokens(chars[start..end]) <= budget。
    // estimateTokens 对前缀扩展单调不减，二分成立。
    let lo = start + 1;
    let hi = chars.length;
    let best = start + 1; // 即使单字符超预算也至少前进 1，保证终止
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const candidate = chars.slice(start, mid).join('');
      if (estimateTokens(candidate) <= budget) {
        best = mid;
        lo = mid + 1;
      } else if (mid <= start + 1) {
        break;
      } else {
        hi = mid - 1;
      }
    }

    let end = best;
    if (snapBoundaries && end < chars.length) {
      end = snapCutToBoundary(chars, start, end);
    }

    const segment = chars.slice(start, end).join('');
    if (rustTrim(segment) !== '') {
      segments.push(segment);
    }
    start = end;
  }

  return segments;
}

/**
 * 规则边界吸附（"semantic-ish" snap，**非 LLM 定界**）。
 *
 * 在硬切点 `hardEnd` 前的窗口（约本段长度的 20%，至少 16 字符）内，
 * 按优先级向后搜索更自然的切点：
 * 1. 段落边界 `\n\n`（切点落在其后，覆盖 Markdown 标题行前的空行）；
 * 2. 单个换行；
 * 3. 句末标点（。！？.!?，切点落在标点后）；
 * 4. 任意空白。
 *
 * 找不到边界或本段太短（<32 字符）则维持硬切点。返回值保证 `> start`
 * 且 `<= hardEnd`（只会把切点前移，不会扩大分段，因此不破坏 token 预算）。
 */
export function snapCutToBoundary(chars: readonly string[], start: number, hardEnd: number): number {
  const len = hardEnd - start;
  if (len < 32) {
    return hardEnd;
  }
  const window = Math.min(Math.max(Math.trunc(len / 5), 16), len - 1);
  const minCut = hardEnd - window;

  // 1) 段落边界 "\n\n"：切点在第二个换行之后
  let i = hardEnd;
  while (i > minCut) {
    if (chars[i - 1] === '\n' && i >= start + 2 && chars[i - 2] === '\n') {
      return i;
    }
    i -= 1;
  }
  // 2) 单个换行：切点在换行之后
  for (let index = hardEnd - 1; index >= minCut; index -= 1) {
    if (chars[index] === '\n') {
      return index + 1;
    }
  }
  // 3) 句末标点：切点在标点之后
  for (let index = hardEnd - 1; index >= minCut; index -= 1) {
    if (SENTENCE_END_SET.has(chars[index]!)) {
      return index + 1;
    }
  }
  // 4) 任意空白
  for (let index = hardEnd - 1; index >= minCut; index -= 1) {
    if (isRustWhitespace(chars[index]!.codePointAt(0)!)) {
      return index + 1;
    }
  }
  return hardEnd;
}

/**
 * 带重叠的文档分段。
 *
 * 先做无重叠基础分段，再给每个分段注入相邻分段的边界上下文
 * （前段尾部 → 本段前缀，后段头部 → 本段后缀），并在超预算时按
 * 后缀 → 前缀 → 正文 的顺序裁剪，保证每段不超 `maxTokensPerSegment`。
 */
