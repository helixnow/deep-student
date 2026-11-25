/**
 * CompanionAnswerRenderer
 *
 * Lightweight Markdown + KaTeX renderer for MediaCompanionQaCard.
 * Renders Markdown (GFM tables, lists, bold/italic, code, headings) and
 * LaTeX math ($...$, $$...$$, \(...\), \[...\]) via react-markdown +
 * remark-math + remark-gfm, while lazy-loading KaTeX + mhchem and
 * preserving clickable [mm:ss] timestamp citation pills via
 * tokenizeTimestampText.
 *
 * Intentionally self-contained (no deep cross-feature imports into
 * `@/features/chat/components/renderers/*`) so frontend-layers stays clean.
 */

import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { KatexOptions } from 'katex';
import { DsButton } from '@/components/ui/DsButton';
import { ensureKatexStyles } from '@/utils/lazyStyles';
import { tokenizeTimestampText } from '../mediaCompanionQa';

// ---------------------------------------------------------------------------
// Local KaTeX lazy-loader (mirrors lazyKatex.ts without cross-feature import)
// ---------------------------------------------------------------------------
type KatexModule = typeof import('katex').default;

let loadedKatex: KatexModule | null = null;
let loadPromise: Promise<KatexModule> | null = null;
let idlePrefetchScheduled = false;

const katexHtmlCache = new Map<string, string>();
const KATEX_CACHE_MAX_SIZE = 200;

function getLoadedKatex(): KatexModule | null {
  return loadedKatex;
}

function ensureKatexLoaded(): Promise<KatexModule> {
  if (loadedKatex) return Promise.resolve(loadedKatex);
  if (!loadPromise) {
    loadPromise = Promise.all([
      import('katex'),
      import('katex/contrib/mhchem'),
    ])
      .then(([katexModule]) => {
        loadedKatex = katexModule.default;
        return loadedKatex;
      })
      .catch((error) => {
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

function scheduleKatexIdlePrefetch(): void {
  if (idlePrefetchScheduled || loadedKatex || typeof window === 'undefined') return;
  idlePrefetchScheduled = true;
  const run = () => {
    ensureKatexLoaded().catch(() => {
      idlePrefetchScheduled = false;
    });
  };
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof win.requestIdleCallback === 'function') {
    win.requestIdleCallback(run, { timeout: 3000 });
  } else {
    window.setTimeout(run, 1000);
  }
}

function getCachedKatex(latex: string, displayMode: boolean): string | undefined {
  return katexHtmlCache.get(`${displayMode ? 'b' : 'i'}|${latex}`);
}

function setCachedKatex(latex: string, displayMode: boolean, html: string): void {
  if (katexHtmlCache.size >= KATEX_CACHE_MAX_SIZE) {
    const half = Math.floor(KATEX_CACHE_MAX_SIZE / 2);
    const keys = Array.from(katexHtmlCache.keys()).slice(0, half);
    for (const key of keys) katexHtmlCache.delete(key);
  }
  katexHtmlCache.set(`${displayMode ? 'b' : 'i'}|${latex}`, html);
}

const KATEX_OPTIONS: KatexOptions = {
  throwOnError: false,
  strict: false,
  trust: false,
};

// ---------------------------------------------------------------------------
// Preprocessor: convert \(...\) and \[...\] to $...$ and $$...$$ for remark-math
// ---------------------------------------------------------------------------
const CJK_CONSECUTIVE_RE = /[\u4e00-\u9fff]{2,}/;

export function preprocessCompanionMarkdown(content: string): string {
  if (!content) return '';
  let text = content.includes('\r') ? content.replace(/\r\n/g, '\n') : content;

  const codePlaceholders: string[] = [];
  if (text.includes('`')) {
    text = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
      codePlaceholders.push(match);
      return `\x00CB${codePlaceholders.length - 1}\x00`;
    });
  }

  if (text.includes('\\')) {
    if (text.includes('\\(')) {
      text = text.replace(/(?<!\\)\\\((.+?)(?<!\\)\\\)/g, (match, math: string) => {
        if (CJK_CONSECUTIVE_RE.test(math) && !/\\[a-zA-Z]+/.test(math)) return match;
        return `$${math}$`;
      });
    }
    if (text.includes('\\[')) {
      text = text.replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, (match, math: string) => {
        if (CJK_CONSECUTIVE_RE.test(math) && !/\\[a-zA-Z]+/.test(math)) return match;
        return `$$${math}$$`;
      });
    }
  }

  if (codePlaceholders.length > 0) {
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\x00CB(\d+)\x00/g, (_m, idx: string) => codePlaceholders[Number(idx)] ?? '');
  }

  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractTextFromReactNode(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromReactNode).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractTextFromReactNode(node.props.children);
  }
  return '';
}

const LazyMath: React.FC<{ latex: string; displayMode: boolean }> = ({ latex, displayMode }) => {
  const trimmed = latex.trim();
  const cached = getCachedKatex(trimmed, displayMode);
  const katex = getLoadedKatex();
  const [, forceRender] = useState(0);

  const needsLoad = Boolean(trimmed) && cached === undefined && !katex;
  useEffect(() => {
    if (!needsLoad) return;
    let cancelled = false;
    ensureKatexLoaded()
      .then(() => {
        if (!cancelled) forceRender((n) => n + 1);
      })
      .catch(() => {
        // Fallback to raw LaTeX text if KaTeX fails to load
      });
    return () => {
      cancelled = true;
    };
  }, [needsLoad]);

  if (!trimmed) return null;

  if (cached !== undefined) {
    return (
      <span
        className={displayMode ? 'block my-1.5 overflow-x-auto' : 'inline-block align-baseline'}
        dangerouslySetInnerHTML={{ __html: cached }}
      />
    );
  }

  if (!katex) {
    return (
      <span
        className="katex-loading"
        style={{ display: displayMode ? 'block' : 'inline' }}
      >
        {trimmed}
      </span>
    );
  }

  try {
    const html = katex.renderToString(trimmed, { ...KATEX_OPTIONS, displayMode });
    setCachedKatex(trimmed, displayMode, html);
    return (
      <span
        className={displayMode ? 'block my-1.5 overflow-x-auto' : 'inline-block align-baseline'}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return (
      <span
        className="katex-error"
        style={{ display: displayMode ? 'block' : 'inline' }}
      >
        {trimmed}
      </span>
    );
  }
};

export const CompanionCitationJumpPill: React.FC<{
  seconds: number;
  label: string;
  onSeek: (seconds: number) => void;
  titleText: string;
}> = ({ seconds, label, onSeek, titleText }) => (
  <DsButton
    type="button"
    variant="ghost"
    size="sm"
    onClick={() => onSeek(seconds)}
    data-media-qa-citation={label}
    data-media-qa-citation-seconds={seconds}
    aria-label={titleText}
    title={titleText}
    className="mx-0.5 !inline-flex !h-auto !min-h-0 !px-1.5 !py-0.5 align-baseline gap-0.5 rounded bg-primary/10 font-mono text-2xs font-medium tabular-nums !text-primary hover:!bg-primary/20 active:scale-[0.98] transition-colors motion-reduce:transition-none motion-reduce:active:scale-100"
  >
    <span aria-hidden="true">▶</span>
    <span>{label}</span>
  </DsButton>
);

function injectTimestampCitations(
  children: React.ReactNode,
  onSeek: (seconds: number) => void,
  jumpTitle: (label: string) => string,
): React.ReactNode {
  return React.Children.map(children, (child, idx) => {
    if (typeof child !== 'string') return child;
    const tokens = tokenizeTimestampText(child);
    if (tokens.length === 0) return child;
    if (tokens.length === 1 && tokens[0].kind === 'text') return child;
    return tokens.map((token, tokenIdx) =>
      token.kind === 'citation' ? (
        <CompanionCitationJumpPill
          key={`cit-${idx}-${tokenIdx}-${token.seconds}`}
          seconds={token.seconds}
          label={token.label}
          onSeek={onSeek}
          titleText={jumpTitle(token.label)}
        />
      ) : (
        <React.Fragment key={`txt-${idx}-${tokenIdx}`}>{token.value}</React.Fragment>
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const REMARK_PLUGINS = [remarkMath, remarkGfm];

export interface CompanionAnswerRendererProps {
  content: string;
  onSeek: (seconds: number) => void;
  jumpTitle: (label: string) => string;
  className?: string;
}

export const CompanionAnswerRenderer: React.FC<CompanionAnswerRendererProps> = ({
  content,
  onSeek,
  jumpTitle,
  className,
}) => {
  useEffect(() => {
    ensureKatexStyles();
    scheduleKatexIdlePrefetch();
  }, []);

  const processed = useMemo(() => preprocessCompanionMarkdown(content), [content]);

  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => {
        const childArray = React.Children.toArray(children);
        const codeEl = childArray.find(
          (c): c is React.ReactElement<{ className?: string; children?: React.ReactNode }> =>
            React.isValidElement(c) && (c.type === 'code' || typeof c.type === 'function'),
        );
        const codeClass = codeEl?.props?.className ?? '';
        if (codeClass.includes('language-math') || codeClass.includes('math-display')) {
          const latex = extractTextFromReactNode(codeEl?.props?.children).replace(/\n$/, '');
          return <LazyMath latex={latex} displayMode={true} />;
        }
        return (
          <pre className="my-1.5 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-2xs leading-relaxed">
            {children}
          </pre>
        );
      },
      code: ({ className: codeClass, children, node: _node, ...rest }) => {
        const cls = typeof codeClass === 'string' ? codeClass : '';
        if (cls.includes('language-math') || cls.includes('math-inline') || cls.includes('math-display')) {
          const latex = extractTextFromReactNode(children).replace(/\n$/, '');
          return <LazyMath latex={latex} displayMode={cls.includes('math-display')} />;
        }
        return (
          <code
            className="rounded bg-muted/60 px-1 py-0.5 font-mono text-2xs"
            {...rest}
          >
            {children}
          </code>
        );
      },
      p: ({ children, node: _node, ...rest }) => (
        <p className="my-1 first:mt-0 last:mb-0" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </p>
      ),
      li: ({ children, node: _node, ...rest }) => (
        <li className="my-0.5" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </li>
      ),
      ul: ({ children, node: _node, ...rest }) => (
        <ul className="my-1 list-disc pl-4" {...rest}>
          {children}
        </ul>
      ),
      ol: ({ children, node: _node, ...rest }) => (
        <ol className="my-1 list-decimal pl-4" {...rest}>
          {children}
        </ol>
      ),
      blockquote: ({ children, node: _node, ...rest }) => (
        <blockquote className="my-1.5 border-l-2 border-primary/40 pl-2.5 text-muted-foreground" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </blockquote>
      ),
      strong: ({ children, node: _node, ...rest }) => (
        <strong className="font-semibold" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </strong>
      ),
      em: ({ children, node: _node, ...rest }) => (
        <em {...rest}>{injectTimestampCitations(children, onSeek, jumpTitle)}</em>
      ),
      td: ({ children, node: _node, ...rest }) => (
        <td className="border border-border/40 px-1.5 py-0.5" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </td>
      ),
      th: ({ children, node: _node, ...rest }) => (
        <th className="border border-border/40 bg-muted/40 px-1.5 py-0.5 font-semibold" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </th>
      ),
      h1: ({ children, node: _node, ...rest }) => (
        <h1 className="my-1 text-xs font-semibold" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </h1>
      ),
      h2: ({ children, node: _node, ...rest }) => (
        <h2 className="my-1 text-xs font-semibold" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </h2>
      ),
      h3: ({ children, node: _node, ...rest }) => (
        <h3 className="my-1 text-xs font-semibold" {...rest}>
          {injectTimestampCitations(children, onSeek, jumpTitle)}
        </h3>
      ),
    }),
    [onSeek, jumpTitle],
  );

  return (
    <div
      data-media-qa-markdown="true"
      className={['break-words leading-relaxed', className ?? ''].filter(Boolean).join(' ')}
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
};
