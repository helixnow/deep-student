const FLOWTOKEN_CITATION_RE = /\[[^\]]+?-\d+(?::图片)?\]/;
const FLOWTOKEN_MATH_RE = /(^|[^\\])\$(?!\$)|\\\(|\\\[|\\begin\{/;
const FLOWTOKEN_HTML_RE = /<\/?[a-zA-Z][\s\S]*?>/;
const FLOWTOKEN_IMAGE_RE = /!\[[^\]]*]\(([^)]+)\)/;

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

  if (
    FLOWTOKEN_CITATION_RE.test(content) ||
    FLOWTOKEN_MATH_RE.test(content) ||
    FLOWTOKEN_HTML_RE.test(content) ||
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
