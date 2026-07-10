/**
 * 流式 markdown 半截闭合预处理
 *
 * 业界最佳实践（对齐 Vercel remend / Streamdown）：
 * 在字符串层自动闭合未配对的 markdown 标记，确保 react-markdown 拿到永远合法的 AST。
 *
 * 仅处理 markdown 标记（bold/italic/link/strikethrough/inline-code/fence），
 * 不处理数学（$...$ / \begin{...}），后者交给 remark-math + KaTeX throwOnError 优雅降级。
 *
 * 规则：
 * - 代码块(fence)和行内代码(`)内部不计数
 * - 奇数个标记自动补尾闭合
 * - 半截 [link 截断（等闭合后完整显示）
 */

export type Range = { start: number; end: number };

export const mergeRanges = (ranges: Range[]): Range[] => {
  if (ranges.length === 0) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
    } else if (range.end > last.end) {
      last.end = range.end;
    }
  }
  return merged;
};

export const computeExcludedRanges = (content: string): Range[] => {
  const ranges: Range[] = [];
  const fenceRegex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  const inlineRegex = /`[^`]*`/g;
  while ((match = inlineRegex.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return mergeRanges(ranges);
};

export const isIndexExcluded = (index: number, ranges: Range[]) => {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) return true;
    if (index < range.start) break;
  }
  return false;
};

// 结构性标记不参与配对计数：
// - `* item` 的列表标记 `*`（否则奇数个列表项会在尾部补出多余的 `*`）
// - `***` / `___` / `---` 水平线（否则一条 hr 会永久打乱后续 **bold 的奇偶配对）
const HR_LINE_RE = /^[ \t]*(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const LIST_MARKER_RE = /^[ \t]*\*[ \t]/;

const computeStructuralExcludedRanges = (content: string): Range[] => {
  const ranges: Range[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    if (HR_LINE_RE.test(line)) {
      ranges.push({ start: offset, end: offset + line.length });
    } else if (LIST_MARKER_RE.test(line)) {
      const markerIndex = line.indexOf('*');
      ranges.push({ start: offset + markerIndex, end: offset + markerIndex + 1 });
    }
    offset += line.length + 1;
  }
  return ranges;
};

/**
 * 对未闭合的 markdown 标记进行自动闭合。
 * 仅在流式期间调用（静态已完成消息通常标记已配对，但本函数是幂等的）。
 */
export const sanitizeDanglingMarkdown = (content: string): { text: string; touched: boolean } => {
  let text = content;
  let touched = false;

  // 1. 未闭合的 fenced code block
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    text += '\n```';
    touched = true;
  }

  // 2. 半截 link [text](url  → 截断到 [ 之前（等闭合后完整渲染）
  // 仅当悬垂 `[` 位于最后一行且不在代码区内时才截断：
  // - 旧实现 `[^\]]*` 可跨行匹配，几行之前的普通 `[`（如 arr[i）会把
  //   后续所有正文连同刚补上的 ``` 闭栏一起吞掉
  // - 代码内的 `[`（行内代码/围栏）不是链接起始，不应触发截断
  const preExcluded = computeExcludedRanges(text);
  const linkMatch = text.match(/!?\[[^\]\n]*$/);
  if (
    linkMatch &&
    linkMatch.index !== undefined &&
    !isIndexExcluded(linkMatch.index, preExcluded)
  ) {
    text = text.slice(0, linkMatch.index);
    touched = true;
  }

  // 3. 配对标记计数（排除代码块/行内代码/列表标记/hr 行内的标记）
  const excluded = mergeRanges([
    ...computeExcludedRanges(text),
    ...computeStructuralExcludedRanges(text),
  ]);
  const counts: Record<string, number> = Object.create(null);
  const bump = (token: string) => {
    counts[token] = (counts[token] || 0) + 1;
  };

  const pairedTokens = ['**', '__', '~~'];
  // 注意：不再对单个 `~` 计数/补尾。remark-gfm 默认 singleTilde=true，
  // 给 "约~5ms" 这类正文补 `~` 会凭空生成删除线，比留着原字符更糟。
  const singleTokens = ['*', '_', '`'];

  // 词内字符判断：CommonMark 规则下 `_` 两侧都是字母数字时不构成强调边界
  const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9]/.test(c);

  for (let i = 0; i < text.length; i++) {
    if (isIndexExcluded(i, excluded)) continue;

    const ch = text[i];
    // 反斜杠转义的标记（\* \_ \` 等）不参与配对计数
    if (ch === '\\') {
      i++;
      continue;
    }

    let matched = false;
    for (const token of pairedTokens) {
      if (text.startsWith(token, i)) {
        // snake__case 之类词内 `__` 不构成强调，跳过计数
        const intraword =
          token === '__' && isWordChar(text[i - 1]) && isWordChar(text[i + token.length]);
        if (!intraword) {
          bump(token);
        }
        i += token.length - 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (singleTokens.includes(ch)) {
      if (ch === '`' && text.startsWith('```', i)) {
        i += 2;
        continue;
      }
      // snake_case 之类词内 `_` 不构成强调，跳过计数
      if (ch === '_' && isWordChar(text[i - 1]) && isWordChar(text[i + 1])) {
        continue;
      }
      bump(ch);
    }
  }

  // 4. 补尾：奇数标记 → 添闭合
  const appendBuffer: string[] = [];
  const ensureEven = (token: string) => {
    if (counts[token] && counts[token] % 2 === 1) {
      appendBuffer.push(token);
      touched = true;
    }
  };

  pairedTokens.forEach(ensureEven);
  singleTokens.forEach(ensureEven);

  if (appendBuffer.length > 0) {
    text += appendBuffer.join('');
  }

  return { text, touched };
};
