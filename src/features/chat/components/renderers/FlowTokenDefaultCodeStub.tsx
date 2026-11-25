import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import {
  getLoadedPrismGrammar,
  loadPrismLanguage,
  resolvePrismLanguage,
  type PrismToken,
  type PrismTokenStream,
} from '@/utils/lazyPrism';

export function renderPrismTokenStream(
  tokens: PrismTokenStream,
  keyPrefix = 'pt',
): React.ReactNode {
  return tokens.map((token, index) => {
    if (typeof token === 'string') return token;
    const alias = Array.isArray(token.alias) ? token.alias.join(' ') : token.alias || '';
    const className = alias ? `token ${token.type} ${alias}` : `token ${token.type}`;
    const content: React.ReactNode = Array.isArray(token.content)
      ? renderPrismTokenStream(token.content, `${keyPrefix}-${index}`)
      : typeof token.content === 'string'
        ? token.content
        : renderPrismTokenStream([token.content], `${keyPrefix}-${index}`);
    return (
      <span key={`${keyPrefix}-${index}`} className={className}>
        {content}
      </span>
    );
  });
}

interface FlowTokenDefaultCodeStubProps extends React.HTMLAttributes<HTMLElement> {
  node?: unknown;
  className?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  codeStyle?: unknown;
  animateText?: (value: React.ReactNode) => React.ReactNode;
  animation?: string;
  animationDuration?: string;
  animationTimingFunction?: string;
}

const CopyIconSvg = () => (
  <svg
    className="ft-copy-icon ft-copy-icon-default"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIconSvg = () => (
  <svg
    className="ft-copy-icon ft-copy-icon-success"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * Lightweight drop-in replacement for `@nvq/flowtoken/dist/components/DefaultCode.js`.
 *
 * Eliminates FlowToken's CJS imports of `@tabler/icons-react` (4 MB barrel),
 * `react-syntax-highlighter`, and `highlight.js` (~1,001 KiB gz across 470 chunks),
 * delegating syntax highlighting to the shared lazy `prismjs` loader instead.
 */
const FlowTokenDefaultCodeStub: React.FC<FlowTokenDefaultCodeStubProps> = ({
  node: _node,
  className,
  children,
  style,
  codeStyle: _codeStyle,
  animateText,
  animation: _animation,
  animationDuration: _animationDuration,
  animationTimingFunction: _animationTimingFunction,
  ...props
}) => {
  const [copied, setCopied] = useState(false);
  const [tokens, setTokens] = useState<PrismTokenStream | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFenced = Boolean(className && className.startsWith('language-'));
  const language = isFenced ? (className!.substring(9).trim() || 'text') : '';
  const codeText = useMemo(
    () => (Array.isArray(children) ? children.join('') : String(children ?? '')),
    [children],
  );

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isFenced || !resolvePrismLanguage(language)) {
      setTokens(null);
      return;
    }

    const cached = getLoadedPrismGrammar(language);
    if (cached) {
      setTokens(cached.prism.tokenize(codeText, cached.grammar));
      return;
    }

    let cancelled = false;
    void loadPrismLanguage(language).then((loaded) => {
      if (cancelled || !loaded) return;
      setTokens(loaded.prism.tokenize(codeText, loaded.grammar));
    });

    return () => {
      cancelled = true;
    };
  }, [isFenced, language, codeText]);

  if (!isFenced) {
    return (
      <code {...props} className="ft-inline-code">
        {animateText ? animateText(children) : children}
      </code>
    );
  }

  const handleCopy = () => {
    void navigator.clipboard?.writeText(codeText);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div {...props} className="ft-code-container" style={style}>
      <div className="ft-code-header">
        <div style={{ paddingLeft: '0.75rem' }}>
          <span className="ft-code-language">{language}</span>
        </div>
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          className="ft-copy-button [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          onClick={handleCopy}
          aria-label={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? <CheckIconSvg /> : <CopyIconSvg />}
        </DsButton>
      </div>
      <div className="ft-code-content rsh-container">
        <pre
          style={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.775rem',
            overflow: 'auto',
            borderRadius: '0 0 0.75rem 0.75rem',
          }}
        >
          <code className={className}>
            {tokens ? renderPrismTokenStream(tokens) : codeText}
          </code>
        </pre>
      </div>
    </div>
  );
};

export default FlowTokenDefaultCodeStub;
