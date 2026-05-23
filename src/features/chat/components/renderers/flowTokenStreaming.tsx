import React from 'react';
import SplitText from '@nvq/flowtoken/dist/components/SplitText.js';

const FLOWTOKEN_SKIP_TAGS = new Set([
  'br',
  'code',
  'img',
  'hr',
  'pre',
  'script',
  'style',
  'svg',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

const FLOWTOKEN_SKIP_DATA_ATTRS = [
  'data-citation',
  'data-mindmap-citation',
  'data-pdf-ref',
  'data-qbank-citation',
] as const;

const FLOWTOKEN_ANIMATION = 'ft-fadeIn';
const FLOWTOKEN_DURATION = '0.32s';
const FLOWTOKEN_TIMING = 'ease-out';

function shouldSkipFlowTokenNode(node: React.ReactElement<any>): boolean {
  if (typeof node.type === 'string' && FLOWTOKEN_SKIP_TAGS.has(node.type)) {
    return true;
  }

  const props = (node.props ?? {}) as Record<string, unknown>;
  if (FLOWTOKEN_SKIP_DATA_ATTRS.some((attr) => props[attr] === 'true')) {
    return true;
  }

  const className = typeof props.className === 'string' ? props.className : '';
  if (
    className.includes('citation-inline-image') ||
    className.includes('citation-badge') ||
    className.includes('katex')
  ) {
    return true;
  }

  return false;
}

function renderFlowTokenChild(child: React.ReactNode, key: React.Key): React.ReactNode {
  if (typeof child === 'string') {
    if (child.length === 0) return child;
    return (
      <SplitText
        key={key}
        input={child}
        sep="diff"
        animation={FLOWTOKEN_ANIMATION}
        animationDuration={FLOWTOKEN_DURATION}
        animationTimingFunction={FLOWTOKEN_TIMING}
        animationIterationCount={1}
      />
    );
  }

  if (typeof child === 'number') {
    return (
      <SplitText
        key={key}
        input={String(child)}
        sep="diff"
        animation={FLOWTOKEN_ANIMATION}
        animationDuration={FLOWTOKEN_DURATION}
        animationTimingFunction={FLOWTOKEN_TIMING}
        animationIterationCount={1}
      />
    );
  }

  if (!React.isValidElement(child)) {
    return child;
  }

  if (shouldSkipFlowTokenNode(child)) {
    return child;
  }

  const element = child as React.ReactElement<any>;
  const props = (element.props ?? {}) as { children?: React.ReactNode };
  if (props.children === undefined || props.children === null) {
    return element;
  }

  return React.cloneElement(
    element,
    { key },
    renderFlowTokenStreamingChildren(props.children, true),
  );
}

export function renderFlowTokenStreamingChildren(
  children: React.ReactNode,
  enabled: boolean,
): React.ReactNode {
  if (!enabled) {
    return children;
  }

  return React.Children.map(children, (child, index) =>
    renderFlowTokenChild(child, `flowtoken-${index}`),
  );
}
