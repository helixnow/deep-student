/**
 * ACR 4.0 A4：clean 破坏类直改（note_replace / note_set）的演出定位辅助。
 *
 * setMarkdown 整篇瞬变后，noteDriver 调用 CrepeEditorApi.agentFlashChange，
 * 本模块负责纯文本层面的定位：
 * 1. findFirstDiffLine：逐行比对新旧 markdown，返回首个差异行；
 * 2. extractFlashSnippet：把差异行剥掉 Markdown 语法，得到可在
 *    ProseMirror 文档 textContent 里检索的纯文本片段。
 *
 * CrepeEditor 用该片段找到承载段落 → 滚动 + agent-flash decoration 渐隐；
 * 找不到片段时退化为整个编辑器内容区一次轻微 opacity 脉冲。
 */

export interface FirstDiffLine {
  /** 差异行在「新 markdown」里的行号（0-based） */
  lineIndex: number;
  /** 新 markdown 中该行内容；删除类变更时可能为空串 */
  lineText: string;
  /** 差异行前最近的非空「共同上下文」行（新旧一致），用于删除类兜底定位 */
  contextText: string | null;
}

/** 逐行找首个差异；完全一致返回 null。 */
export function findFirstDiffLine(before: string, after: string): FirstDiffLine | null {
  if (before === after) return null;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);

  let contextText: string | null = null;
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      if (a && a.trim().length > 0) contextText = a;
      continue;
    }
    return {
      lineIndex: Math.min(i, Math.max(0, afterLines.length - 1)),
      lineText: afterLines[i] ?? '',
      contextText,
    };
  }
  return null;
}

/**
 * 剥掉常见 Markdown 语法，产出用于 textContent 检索的纯文本片段。
 * 结果过短（<3 字符）视为不可靠，返回 ''。
 */
export function extractFlashSnippet(lineText: string, maxLength = 48): string {
  let text = lineText;
  // 块级前缀：标题 / 引用 / 列表 / 任务框 / 有序列表
  text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
  // 图片/链接 → 保留可见文本
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 行内标记
  text = text.replace(/(\*\*|__|~~|`)/g, '');
  text = text.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2');
  text = text.trim();
  if (text.length > maxLength) text = text.slice(0, maxLength).trim();
  return text.length >= 3 ? text : '';
}

/**
 * 综合：从新旧 markdown 求出用于定位/高亮的片段。
 * 差异行本身没有可用文本（如整段删除）时回退到共同上下文行。
 * 返回 null 表示两文一致（无需演出）。
 */
export function resolveFlashSnippet(
  before: string,
  after: string,
): { snippet: string } | null {
  const diff = findFirstDiffLine(before, after);
  if (!diff) return null;
  const primary = extractFlashSnippet(diff.lineText);
  if (primary) return { snippet: primary };
  const fallback = diff.contextText ? extractFlashSnippet(diff.contextText) : '';
  return { snippet: fallback };
}
