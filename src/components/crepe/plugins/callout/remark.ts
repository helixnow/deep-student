import type { MarkdownNode } from '@milkdown/transformer';
import { $remark } from '@milkdown/utils';

import { parseCalloutMarker } from './types';

function getNodeText(node: MarkdownNode | undefined): string {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  if (!node.children?.length) return '';
  return node.children.map((child) => getNodeText(child)).join('');
}

/**
 * If a blockquote's first paragraph is an Obsidian callout marker
 * (`[!note] optional title`), convert the AST node to `callout`.
 */
export function promoteBlockquoteToCallout(node: MarkdownNode): boolean {
  if (node.type !== 'blockquote' || !node.children?.length) return false;

  const [first, ...rest] = node.children;
  // Authors write a paragraph; our serializer emits a bare html line to avoid `\[` escapes.
  if (!first || (first.type !== 'paragraph' && first.type !== 'html')) return false;

  const marker = parseCalloutMarker(getNodeText(first));
  if (!marker) return false;

  node.type = 'callout';
  node.calloutType = marker.type;
  node.calloutTitle = marker.title;
  node.children = rest.length > 0 ? rest : [{ type: 'paragraph', children: [] }];
  return true;
}

function walk(node: MarkdownNode): void {
  if (!node.children?.length) return;
  for (const child of node.children) {
    if (child.type === 'blockquote') {
      promoteBlockquoteToCallout(child);
    }
    walk(child);
  }
}

function remarkCalloutTransform(tree: MarkdownNode) {
  walk(tree);
}

export const remarkCalloutPlugin = $remark(
  'remark-callout',
  () => () => remarkCalloutTransform as never,
);
