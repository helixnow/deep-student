import React, { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from './MarkdownRenderer';
import { shallowEqualSpans, makeUncertaintyHighlightPlugin } from './rendererUtils';

interface BaseStreamingProps {
  content: string;
  isStreaming: boolean;
  chainOfThought?: {
    enabled: boolean;
    details?: any;
  };
  onLinkClick?: (url: string) => void;
  highlightSpans?: Array<{ start: number; end: number; reason?: string }>;
}

export type RendererMode = 'legacy' | 'enhanced';

type Range = { start: number; end: number };
type Replacement = { start: number; end: number; value: string };

type PrepareResult = {
  content: string;
  meta: {
    hasPartialMath: boolean;
    touchedMarkdown: boolean;
  };
};

const normalizeLineEndings = (content: string) => content.replace(/\r\n/g, '\n');

const trimTrailingWhitespace = (content: string) => content.replace(/[ \t]+$/gm, '');

const cleanupMatrix = (content: string) =>
  content.replace(/\\begin{bmatrix}([\s\S]*?)\\end{bmatrix}/g, (_, matrix) => {
    let cleaned = matrix.replace(/\s*\\\\\s*/g, ' \\\\ ');
    cleaned = cleaned.replace(/\s*&\s*/g, '&');
    cleaned = cleaned.split(' \\\\ ').map((row: string) => row.trim()).join(' \\\\ ');
    return `\\begin{bmatrix}${cleaned}\\end{bmatrix}`;
  });

const baseNormalize = (content: string) => {
  let processed = content ?? '';
  processed = normalizeLineEndings(processed);
  processed = cleanupMatrix(processed);
  processed = trimTrailingWhitespace(processed);
  return processed;
};

const stripUiPlaceholderTags = (content: string): string => {
  // Some models occasionally print ChatAnki UI placeholders as literal text.
  // The actual preview block is event-driven and should not be shown in markdown.
  return content.replace(
    /^[ \t]*<anki_cards\b[^>\n]*\bid="blk_[^"\n]+"\b[^>\n]*\bdocumentId="[^"\n]+"\b[^>\n]*\/>[ \t]*$/gim,
    ''
  );
};

const mergeRanges = (ranges: Range[]): Range[] => {
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

const computeExcludedRanges = (content: string): Range[] => {
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

const isIndexExcluded = (index: number, ranges: Range[]) => {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) return true;
    if (index < range.start) break;
  }
  return false;
};

const applyReplacements = (text: string, replacements: Replacement[]): string => {
  if (replacements.length === 0) return text;
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let result = text;
  for (const rep of ordered) {
    result = result.slice(0, rep.start) + rep.value + result.slice(rep.end);
  }
  return result;
};

const sanitizeDanglingMarkdown = (content: string): { text: string; touched: boolean } => {
  let text = content;
  let touched = false;

  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    text += '\n```';
    touched = true;
  }

  const linkMatch = text.match(/!?(\[[^\]]*)$/);
  if (linkMatch && linkMatch.index !== undefined) {
    text = text.slice(0, linkMatch.index);
    touched = true;
  }

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

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const looksLikeMathContinuation = (segment: string) => {
  if (!segment) return false;
  const sample = segment.substring(0, 48);
  if (/[a-zA-Z\\^_]/.test(sample)) return true;
  if (/\\(frac|sum|int|begin|left|right|mathrm|mathbb)/.test(sample)) return true;
  return false;
};

const sanitizeDanglingMath = (content: string, streaming: boolean) => {
  if (!streaming) {
    return { text: content, hasPartialMath: false };
  }

  const excluded = computeExcludedRanges(content);
  const replacements: Replacement[] = [];
  let hasPartialMath = false;

  const tokens: Array<{ type: 'inline' | 'display'; index: number; length: number }> = [];
  for (let i = 0; i < content.length; i++) {
    if (isIndexExcluded(i, excluded)) continue;
    const char = content[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '$') {
      if (content[i + 1] === '$') {
        tokens.push({ type: 'display', index: i, length: 2 });
        i += 1;
      } else {
        tokens.push({ type: 'inline', index: i, length: 1 });
      }
    }
  }

  const displayTokens = tokens.filter(token => token.type === 'display');
  if (displayTokens.length % 2 === 1) {
    const last = displayTokens[displayTokens.length - 1];
    replacements.push({ start: last.index, end: last.index + last.length, value: '\\$\\$' });
    hasPartialMath = true;
  }

  const inlineTokens = tokens.filter(token => token.type === 'inline');
  if (inlineTokens.length % 2 === 1) {
    const last = inlineTokens[inlineTokens.length - 1];
    const continuation = content.slice(last.index + last.length);
    if (looksLikeMathContinuation(continuation)) {
      replacements.push({ start: last.index, end: last.index + last.length, value: '\\$' });
      hasPartialMath = true;
    }
  }

  const openParenRegex = /\\\(/g;
  const closeParenRegex = /\\\)/g;
  const openBracketRegex = /\\\[/g;
  const closeBracketRegex = /\\\]/g;

  const collect = (regex: RegExp) => {
    const indexes: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (!isIndexExcluded(match.index, excluded)) {
        indexes.push(match.index);
      }
    }
    return indexes;
  };

  const openParens = collect(openParenRegex);
  const closeParens = collect(closeParenRegex);
  if (openParens.length > closeParens.length) {
    const last = openParens[openParens.length - 1];
    replacements.push({ start: last, end: last + 2, value: '(' });
    hasPartialMath = true;
  }

  const openBrackets = collect(openBracketRegex);
  const closeBrackets = collect(closeBracketRegex);
  if (openBrackets.length > closeBrackets.length) {
    const last = openBrackets[openBrackets.length - 1];
    replacements.push({ start: last, end: last + 2, value: '[' });
    hasPartialMath = true;
  }

  const beginRegex = /\\begin\{([^}]+)\}/g;
  let beginMatch: RegExpExecArray | null;
  const begins: Array<{ index: number; full: string; env: string }> = [];
  while ((beginMatch = beginRegex.exec(content)) !== null) {
    if (!isIndexExcluded(beginMatch.index, excluded)) {
      begins.push({ index: beginMatch.index, full: beginMatch[0], env: beginMatch[1] });
    }
  }
  if (begins.length > 0) {
    const last = begins[begins.length - 1];
    const after = content.slice(last.index + last.full.length);
    const endRegex = new RegExp(`\\\\end\\{${escapeRegex(last.env)}\\}`);
    if (!endRegex.test(after)) {
      replacements.push({ start: last.index, end: content.length, value: '' });
      hasPartialMath = true;
    }
  }

  const sanitized = applyReplacements(content, replacements);
  return { text: sanitized, hasPartialMath };
};

const prepareContent = (content: string, streaming: boolean): PrepareResult => {
  if (!content) {
    return { content: '', meta: { hasPartialMath: false, touchedMarkdown: false } };
  }
  const normalized = stripUiPlaceholderTags(baseNormalize(content));
  const markdownResult = sanitizeDanglingMarkdown(normalized);
  const mathResult = sanitizeDanglingMath(markdownResult.text, streaming);
  return {
    content: mathResult.text,
    meta: {
      hasPartialMath: mathResult.hasPartialMath,
      touchedMarkdown: markdownResult.touched,
    },
  };
};

export type EnhancedMarkdownRendererProps = React.ComponentProps<typeof MarkdownRenderer>;

export const EnhancedMarkdownRenderer: React.FC<EnhancedMarkdownRendererProps> = ({ content, ...rest }) => {
  const prepared = useMemo(() => prepareContent(content, Boolean(rest.isStreaming)), [content, rest.isStreaming]);
  return <MarkdownRenderer {...rest} content={prepared.content} />;
};

const parseChainOfThought = (content: string) => {
  if (!content) return null;
  const tryMatch = (src: string, tag: 'thinking' | 'think') =>
    src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>\\s*`, 'i'));

  let thinkingMatch = tryMatch(content, 'thinking');
  if (!thinkingMatch) thinkingMatch = tryMatch(content, 'think');
  if (thinkingMatch) {
    const thinkingContent = (thinkingMatch[1] || '').trim();
    const mainContent = content.replace(thinkingMatch[0], '').trim();
    return { thinkingContent, mainContent };
  }
  return null;
};

const preprocessStreaming = (content: string, streaming: boolean) => prepareContent(content, streaming);

export const EnhancedStreamingMarkdownRenderer: React.FC<BaseStreamingProps> = memo(({
  content,
  isStreaming,
  onLinkClick,
  highlightSpans
}) => {
  const { t } = useTranslation('chatV2');
  // 🔧 P1修复：使用 useMemo 替代 useEffect+setState，避免额外渲染周期
  const prepared = useMemo(() => preprocessStreaming(content, isStreaming), [content, isStreaming]);
  const displayContent = prepared.content;
  const isPartialMath = prepared.meta.hasPartialMath;

  const [showCursor, setShowCursor] = useState(true);
  // 🔧 P1修复：使用稳定引用比较替代 JSON.stringify
  const highlightSpansRef = React.useRef(highlightSpans);
  if (!shallowEqualSpans(highlightSpansRef.current, highlightSpans)) {
    highlightSpansRef.current = highlightSpans;
  }

  useEffect(() => {
    if (isStreaming) {
      const timer = setInterval(() => {
        setShowCursor(prev => !prev);
      }, 500);
      return () => clearInterval(timer);
    }
    setShowCursor(false);
    return undefined;
  }, [isStreaming]);

  const parsed = useMemo(() => parseChainOfThought(displayContent), [displayContent]);
  const stableHighlightSpans = highlightSpansRef.current;

  const renderedContent = useMemo(() => {
    if (!displayContent) return null;
    const extraPlugins = (!isStreaming && Array.isArray(stableHighlightSpans) && stableHighlightSpans.length > 0)
      ? [makeUncertaintyHighlightPlugin(displayContent, stableHighlightSpans, t('renderer.uncertain'))]
      : [];
    return <MarkdownRenderer content={displayContent} isStreaming={isStreaming} onLinkClick={onLinkClick} extraRemarkPlugins={extraPlugins} />;
  }, [displayContent, isStreaming, onLinkClick, stableHighlightSpans, t]);

  return (
    <div className="streaming-markdown">
      {parsed ? (
        <>
          {parsed.thinkingContent && (
            <div className="chain-of-thought">
              <div className="chain-header">
                <span className="chain-icon">🧠</span>
                <span className="chain-title">{t('renderer.aiThinkingProcess')}</span>
              </div>
              <div className="thinking-content">
                <MarkdownRenderer content={parsed.thinkingContent} isStreaming={isStreaming} onLinkClick={onLinkClick} />
              </div>
            </div>
          )}

          <div className="main-content">
            {parsed.mainContent ? (
              <MarkdownRenderer
                content={parsed.mainContent}
                isStreaming={isStreaming}
                onLinkClick={onLinkClick}
                extraRemarkPlugins={(!isStreaming && Array.isArray(stableHighlightSpans) && stableHighlightSpans.length > 0) ? [makeUncertaintyHighlightPlugin(parsed.mainContent, stableHighlightSpans, t('renderer.uncertain'))] : []}
              />
            ) : (
              renderedContent
            )}
            {isStreaming && (<span className="streaming-cursor" data-active={showCursor ? 'true' : 'false'} aria-hidden="true">▋</span>)}
            {isPartialMath && isStreaming && (
              <span className="partial-math-indicator" title={t('renderer.incompleteMathFormula')}>📝</span>
            )}
          </div>
        </>
      ) : (
        <div className="normal-content">
          {renderedContent}
          {isStreaming && (<span className="streaming-cursor" data-active={showCursor ? 'true' : 'false'} aria-hidden="true">▋</span>)}
          {isPartialMath && isStreaming && (
            <span className="partial-math-indicator" title={t('renderer.incompleteMathFormula')}>📝</span>
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) => (
  prev.content === next.content &&
  prev.isStreaming === next.isStreaming &&
  shallowEqualSpans(prev.highlightSpans, next.highlightSpans)
));
