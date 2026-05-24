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
  const linkMatch = text.match(/!?(\[[^\]]*)$/);
  if (linkMatch && linkMatch.index !== undefined) {
    text = text.slice(0, linkMatch.index);
    touched = true;
  }

  // 3. 配对标记计数（排除代码块/行内代码内的标记）
  const excluded = computeExcludedRanges(text);
  const counts: Record<string, number> = Object.create(null);
  const bump = (token: string) => {
    counts[token] = (counts[token] || 0) + 1;
  };

  const pairedTokens = ['**', '__', '~~'];
  const singleTokens = ['*', '_', '~', '`'];

  for (let i = 0; i < text.length; i++) {
    if (isIndexExcluded(i, excluded)) continue;

    let matched = false;
    for (const token of pairedTokens) {
      if (text.startsWith(token, i)) {
        bump(token);
        i += token.length - 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const ch = text[i];
    if (singleTokens.includes(ch)) {
      if (ch === '`' && text.startsWith('```', i)) {
        i += 2;
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
