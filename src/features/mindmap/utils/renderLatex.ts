/**
 * LaTeX 内联渲染工具
 * 解析文本中的 $...$ (inline) 和 $$...$$ (display) 公式，
 * 使用 KaTeX 渲染为 HTML。
 */
import katex from 'katex';
import 'katex/contrib/mhchem';

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  strict: false,
  trust: false,
};

/**
 * 统一的 LaTeX 匹配正则
 * - 分支 1：$$...$$ (display mode)
 * - 分支 2：$...$ (inline mode)，按 Pandoc 规则区分公式与货币：
 *   开 $ 后紧跟非空白、闭 $ 前是非空白、闭 $ 后不紧跟数字，且不跨行、开 $ 未被 \ 转义。
 *   `$Ax = 0$`、`$A$`、`$r(A)$` 是公式；`$5 and $10`、`$5-$10`、`价格 $5 到 $10` 不是。
 *   （旧规则要求内容含 \ ^ _ { 之一，笔记大纲里大量 `$Ax = 0$` / `$A$` 被原样显示成源码。）
 */
const LATEX_REGEX = /(\$\$.+?\$\$)|(?:(?:^|(?<=[^\\]))\$(?!\$)(?=\S)([^$\n]*?\S)(?<!\\)\$(?!\d))/gs;

/**
 * 宽松匹配：$...$ 内容不要求 LaTeX 特征字符。题干/选项里 `$A$`、`$f'(0)$`、
 * `$1, 2, -1$` 都是公式而非货币，严格规则会把它们原样漏成 `$…$` 源码。
 */
const LATEX_REGEX_PERMISSIVE = /(\$\$.+?\$\$)|(?:(?:^|(?<=(?:[^\\])))\$(?!\$)([^$\n]+?)(?<!\\)\$)/gs;

export interface RenderLatexOptions {
  /** 题目场景：任何 $...$ 都按公式渲染（默认严格模式，避免货币误判） */
  permissive?: boolean;
}

const MAX_LATEX_HTML_CACHE = 1000;
const latexHtmlCache = new Map<string, string | null>();

function readCachedLatexHtml(key: string): string | null | undefined {
  if (!latexHtmlCache.has(key)) return undefined;
  const cached = latexHtmlCache.get(key)!;
  // LRU 触达刷新
  latexHtmlCache.delete(key);
  latexHtmlCache.set(key, cached);
  return cached;
}

function writeCachedLatexHtml(key: string, value: string | null): void {
  if (latexHtmlCache.size >= MAX_LATEX_HTML_CACHE) {
    const oldestKey = latexHtmlCache.keys().next().value;
    if (oldestKey !== undefined) latexHtmlCache.delete(oldestKey);
  }
  latexHtmlCache.set(key, value);
}

/**
 * 检测文本是否包含 LaTeX 语法（$...$ 或 $$...$$）
 */
export function containsLatex(text: string, options: RenderLatexOptions = {}): boolean {
  if (!text || !text.includes('$')) return false;
  const regex = options.permissive ? LATEX_REGEX_PERMISSIVE : LATEX_REGEX;
  // 重置 lastIndex（共用正则对象时需要）
  regex.lastIndex = 0;
  return regex.test(text);
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
 * 将包含 LaTeX 的文本渲染为 HTML 字符串（带模块级有界 LRU 缓存）。
 * - $$...$$ → display mode
 * - $...$ → inline mode（Pandoc 规则，见 LATEX_REGEX）
 * - 其余文本进行 HTML 转义
 *
 * 如果文本不含 LaTeX，返回 null（调用方可直接用纯文本）。
 */
export function renderLatexToHtml(text: string, options: RenderLatexOptions = {}): string | null {
  if (!text || !text.includes('$')) return null;

  const cacheKey = `${options.permissive ? '1' : '0'}:${text}`;
  const cached = readCachedLatexHtml(cacheKey);
  if (cached !== undefined) return cached;

  // 同步执行复用模块级正则，避免每次调用 new RegExp 分配
  const regex = options.permissive ? LATEX_REGEX_PERMISSIVE : LATEX_REGEX;
  regex.lastIndex = 0;

  let result = '';
  let lastIndex = 0;
  let hasLatexMatch = false;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const fullMatch = match[0];
    const matchStart = match.index;
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
  if (!hasLatexMatch) {
    writeCachedLatexHtml(cacheKey, null);
    return null;
  }

  // 添加剩余的纯文本
  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }

  writeCachedLatexHtml(cacheKey, result);
  return result;
}
