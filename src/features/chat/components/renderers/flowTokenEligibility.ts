const FLOWTOKEN_CITATION_RE = /\[[^\]]+?-\d+(?::图片)?\]/;
const FLOWTOKEN_MATH_RE = /(^|[^\\])\$(?!\$)|\\\(|\\\[|\\begin\{/;
const FLOWTOKEN_IMAGE_RE = /!\[[^\]]*]\(([^)]+)\)/;

// 🔒 P1 (2026-07-08 审阅 21 P1-1)：比 FLOWTOKEN_HTML_RE 更严格的"疑似 HTML"检测。
// 不要求闭合 `>`，覆盖流式期间尚未闭合的标签片段（如 `<img src=x onerror=`），
// 同时覆盖注释 `<!--`、声明 `<!` 与处理指令 `<?`。
const FLOWTOKEN_HTML_LIKE_RE = /<[a-zA-Z/!?]/;

/**
 * 检测内容中是否存在可能被 rehype-raw 当作 HTML 解析的序列（含行内 HTML 与
 * 流式中未闭合的标签起始）。用于块级 flowtoken 门禁，堵住
 * StreamingBlockRenderer 只按块类型判断导致的绕过路径。
 */
export function containsHtmlTagLikeContent(content: string): boolean {
  return FLOWTOKEN_HTML_LIKE_RE.test(content);
}

const HTML_TAG_OPEN_ESCAPE_RE = /<(?=[a-zA-Z/!?])/g;

/**
 * 🔒 P1 (2026-07-08 审阅 21 P1-1)：flowtoken 的 AnimatedMarkdown 内部 rehype
 * 管线只挂 rehype-raw、没有 rehype-sanitize，任何进入该渲染器的原始 HTML 都会被
 * 原样渲染。此函数把疑似 HTML 起始的 `<` 转义为 `&lt;`，作为门禁失效时的最后一道
 * 防线——与主管线 rehype-sanitize 的 fail-closed 语义一致：HTML 一律不作为标记
 * 解析，仅降级为纯文本显示。合规内容（已通过 flowtoken 门禁）本就不含此类序列，
 * 因此该转义对正常渲染无影响。
 */
export function escapeHtmlTagsForFlowToken(content: string): string {
  if (!content) return content;
  return content.replace(HTML_TAG_OPEN_ESCAPE_RE, '&lt;');
}

// Full flowtoken markdown is best for plain prose.
// As soon as we see math, raw HTML, citations, or image references,
// we fall back to the app markdown renderer so the tree stays stable.
const FLOWTOKEN_BARE_LATEX_RE =
  /\\(?:frac|sqrt|sum|int|prod|lim|lambda|gamma|alpha|beta|theta|pi|sigma|omega|delta|epsilon|varepsilon|mu|nu|rho|tau|phi|varphi|psi|chi|eta|zeta|kappa|xi|infty|partial|nabla|cdot|times|approx|equiv|vec|hat|bar|tilde|overline|mathrm|mathbb|text|Gamma|Delta|Theta|Lambda|Sigma|Phi|Psi|Omega|hbar|ell|[lg]eq?|neq?|pm|mp|div|sim|propto|binom|bmatrix|matrix|cases|align|aligned)\b|[_^]\{/i;

export function canUseDirectFlowTokenMarkdown(
  content: string,
  hasExtendedMarkdownFeatures: boolean,
): boolean {
  if (!content || hasExtendedMarkdownFeatures) {
    return false;
  }

  // HTML 检测使用与块级门禁一致的"疑似 HTML"宽松匹配（不要求闭合 `>`），
  // 否则流式期间尚未闭合的标签片段（如 `<img src=x onerror=`）会绕过整段门禁，
  // 只能依赖 escapeHtmlTagsForFlowToken 的最后防线并以纯文本形式展示。
  if (
    FLOWTOKEN_CITATION_RE.test(content) ||
    FLOWTOKEN_MATH_RE.test(content) ||
    containsHtmlTagLikeContent(content) ||
    FLOWTOKEN_BARE_LATEX_RE.test(content)
  ) {
    return false;
  }

  const imageMatch = content.match(FLOWTOKEN_IMAGE_RE);
  if (!imageMatch) {
    return true;
  }

  const src = imageMatch[1]?.trim() ?? '';
  return (
    !src ||
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('blob:')
  );
}
