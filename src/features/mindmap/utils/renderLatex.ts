/**
 * LaTeX 内联渲染工具
 * 解析文本中的 $...$ (inline) 和 $$...$$ (display) 公式，
 * 使用 KaTeX 渲染为 HTML。
 */
import katex from 'katex';

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  strict: false,
  trust: false,
};

/**
 * 统一的 LaTeX 匹配正则
 * - 分支 1：$$...$$ (display mode)
 * - 分支 2：$...$ (inline mode)，要求前面不是 \ 转义，
 *   且内容中至少包含一个 LaTeX 特征字符（\、^、_、{）以避免货币误匹配
 */
const LATEX_REGEX = /(\$\$.+?\$\$)|(?:(?:^|(?<=(?:[^\\])))\$(?!\$)((?:[^$]*?[\\^_{])[^$]*?)(?<!\\)\$)/gs;

/**
 * 检测文本是否包含 LaTeX 语法（$...$ 或 $$...$$）
 */
export function containsLatex(text: string): boolean {
  if (!text) return false;
  // 重置 lastIndex（共用正则对象时需要）
  LATEX_REGEX.lastIndex = 0;
  return LATEX_REGEX.test(text);
}

/** 对 HTML 特殊字符进行转义 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 将包含 LaTeX 的文本渲染为 HTML 字符串。
 * - $$...$$ → display mode
 * - $...$ → inline mode（内容须含 LaTeX 特征字符）
 * - 其余文本进行 HTML 转义
 *
 * 如果文本不含 LaTeX，返回 null（调用方可直接用纯文本）。
 */
export function renderLatexToHtml(text: string): string | null {
  if (!text) return null;

  // 使用与 containsLatex 相同的正则
  const regex = new RegExp(LATEX_REGEX.source, LATEX_REGEX.flags);

  let result = '';
  let lastIndex = 0;
  let hasLatexMatch = false;

  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    const matchStart = match.index!;
    hasLatexMatch = true;

    // 添加匹配前的纯文本
    if (matchStart > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, matchStart));
    }

    if (match[1]) {
      // $$...$$ display mode
      const latex = match[1].slice(2, -2).trim();
      try {
        result += katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode: true });
      } catch {
        result += `<span class="katex-error">${escapeHtml(latex)}</span>`;
      }
    } else {
      // $...$ inline mode
      const latex = (match[2] ?? fullMatch.replace(/^\$|\$$/g, '')).trim();
      try {
        result += katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode: false });
      } catch {
        result += `<span class="katex-error">${escapeHtml(latex)}</span>`;
      }
    }

    lastIndex = matchStart + fullMatch.length;
  }

  // 无任何 LaTeX 匹配 → 返回 null，调用方使用纯文本
  if (!hasLatexMatch) return null;

  // 添加剩余的纯文本
  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }

  return result;
}
