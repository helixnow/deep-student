/**
 * 卡面纯文本回退视图的 LaTeX 渲染（KaTeX，已是项目依赖）。
 *
 * 支持 Anki/MathJax 常用定界符：
 * - \( ... \)（inline）与 \[ ... \]（display）
 * - $$...$$（display）与 $...$（inline；内容须含 LaTeX 特征字符，避免货币误匹配）
 *
 * 仅用于非模板（fallback）卡面：模板卡面在 sandbox iframe 内渲染，
 * 注入 KaTeX 样式/字体成本高，暂不覆盖（见遗留事项）。
 */
import katex from 'katex';
import 'katex/contrib/mhchem';
import { ensureKatexStyles } from '@/utils/lazyStyles';

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  strict: false,
  trust: false,
};

/**
 * 分支：
 * 1. \[ ... \] display
 * 2. \( ... \) inline
 * 3. $$...$$ display
 * 4. $...$ inline（前面非 \ 转义，内容至少含一个 \、^、_、{ 特征字符）
 */
const LATEX_SEGMENT_REGEX =
  /(\\\[[\s\S]+?\\\])|(\\\([\s\S]+?\\\))|(\$\$[\s\S]+?\$\$)|(?:(?:^|(?<=[^\\]))\$(?!\$)((?:[^$\n]*?[\\^_{])[^$\n]*?)(?<!\\)\$)/g;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSegment(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode });
  } catch {
    return `<span class="katex-error">${escapeHtml(latex)}</span>`;
  }
}

/**
 * 将含 LaTeX 的纯文本渲染为 HTML（非公式部分做 HTML 转义）。
 * 文本不含任何 LaTeX 定界符时返回 null（调用方直接用纯文本，零成本）。
 * 返回非 null 时已自动触发 KaTeX 样式懒加载。
 */
export function renderCardFaceLatexHtml(text: string): string | null {
  if (!text) return null;
  const regex = new RegExp(LATEX_SEGMENT_REGEX.source, LATEX_SEGMENT_REGEX.flags);

  let result = '';
  let lastIndex = 0;
  let matched = false;

  for (const match of text.matchAll(regex)) {
    const full = match[0];
    const start = match.index!;
    matched = true;
    if (start > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, start));
    }
    if (match[1]) {
      result += renderSegment(match[1].slice(2, -2).trim(), true);
    } else if (match[2]) {
      result += renderSegment(match[2].slice(2, -2).trim(), false);
    } else if (match[3]) {
      result += renderSegment(match[3].slice(2, -2).trim(), true);
    } else {
      const inline = (match[4] ?? full.replace(/^\$|\$$/g, '')).trim();
      result += renderSegment(inline, false);
    }
    lastIndex = start + full.length;
  }

  if (!matched) return null;
  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }
  ensureKatexStyles();
  return result;
}
