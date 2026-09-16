/**
 * Lightweight markdown body for Generative UI panels (notes summary, research report).
 * Avoids Chat `MarkdownRenderer` which pulls citation/search/capability hooks
 * that require the chat tree.
 */
import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  ensureKatexLoaded,
  getLoadedKatex,
} from '@/features/chat/components/renderers/lazyKatex';
import { cn } from '@/utils/cn';
import { ensureKatexStyles } from '@/utils/lazyStyles';

type MarkdownPlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']>;

const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      'className',
      ['role', 'note'],
      'ariaLabel',
      'dataCitation',
    ],
  },
};

const rehypePlugins: MarkdownPlugins = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

function MarkdownMath({ latex, displayMode }: { latex: string; displayMode: boolean }) {
  const [katex, setKatex] = useState(getLoadedKatex);

  useEffect(() => {
    ensureKatexStyles();
    let cancelled = false;
    void ensureKatexLoaded()
      .then((loaded) => {
        if (!cancelled) setKatex(loaded);
      })
      .catch((error: unknown) => {
        console.error('[GenerativeMarkdownBody] KaTeX load failed:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const html = useMemo(() => {
    if (!katex) return null;
    try {
      return katex.renderToString(latex, {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
        macros: {
          '\\RR': '\\mathbb{R}',
          '\\NN': '\\mathbb{N}',
          '\\ZZ': '\\mathbb{Z}',
          '\\QQ': '\\mathbb{Q}',
          '\\CC': '\\mathbb{C}',
        },
      });
    } catch {
      return null;
    }
  }, [katex, latex, displayMode]);

  return html === null
    ? <span>{latex}</span>
    : <span dangerouslySetInnerHTML={{ __html: html }} />;
}

const components: Components = {
  code: ({ children, className, node: _node, ...props }) => {
    const classes = className?.split(/\s+/) ?? [];
    if (classes.includes('language-math')) {
      return (
        <MarkdownMath
          latex={String(children).trim()}
          displayMode={!classes.includes('math-inline')}
        />
      );
    }
    return <code className={className} {...props}>{children}</code>;
  },
  pre: ({ children, node, ...props }) => {
    const code = node?.children[0];
    if (
      code?.type === 'element'
      && code.tagName === 'code'
      && Array.isArray(code.properties.className)
      && code.properties.className.includes('language-math')
    ) {
      return <div className="max-w-full overflow-x-auto">{children}</div>;
    }
    return <pre {...props}>{children}</pre>;
  },
  a: ({ children, href, node: _node, ...props }) => (
    <a
      {...props}
      href={href}
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!href || href.startsWith('#')) return;
        event.preventDefault();
        void import('@/utils/urlOpener')
          .then(({ openUrl }) => openUrl(href))
          .catch((error: unknown) => {
            console.error('[GenerativeMarkdownBody] Link open failed:', error);
          });
      }}
    >
      {children}
    </a>
  ),
};

export interface GenerativeMarkdownBodyProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  extraRemarkPlugins?: MarkdownPlugins;
}

export function GenerativeMarkdownBody({
  content,
  className,
  isStreaming = false,
  extraRemarkPlugins,
}: GenerativeMarkdownBodyProps) {
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkMath, ...(extraRemarkPlugins ?? [])],
    [extraRemarkPlugins],
  );
  return (
    <div
      className={cn('generative-markdown-body markdown-content text-sm break-words', className)}
      data-generative-markdown-body
      data-streaming={isStreaming || undefined}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default GenerativeMarkdownBody;
