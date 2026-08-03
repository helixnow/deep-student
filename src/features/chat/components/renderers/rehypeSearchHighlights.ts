import type { Element, ElementContent, Root } from 'hast';
import { findTextSearchOccurrences } from '../messageSearch';

const SKIP_TAGS = new Set(['annotation', 'math', 'script', 'style', 'svg']);

function splitTextNode(node: Root | Element, index: number, query: string): number {
  const child = node.children[index];
  if (!child || child.type !== 'text') return 0;

  const occurrences = findTextSearchOccurrences(child.value, query);
  if (occurrences.length === 0) return 0;

  const replacement: ElementContent[] = [];
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (occurrence.start > cursor) {
      replacement.push({
        type: 'text',
        value: child.value.slice(cursor, occurrence.start),
      });
    }
    replacement.push({
      type: 'element',
      tagName: 'mark',
      properties: {
        className: ['chat-search-match'],
        dataChatSearchMatch: 'true',
      },
      children: [{
        type: 'text',
        value: child.value.slice(occurrence.start, occurrence.end),
      }],
    });
    cursor = occurrence.end;
  }
  if (cursor < child.value.length) {
    replacement.push({ type: 'text', value: child.value.slice(cursor) });
  }

  node.children.splice(index, 1, ...replacement);
  return replacement.length;
}

function walk(node: Root | Element, query: string, insideSkipped = false): void {
  const children = node.children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type === 'element') {
      const shouldSkip = insideSkipped || SKIP_TAGS.has(child.tagName);
      if (!shouldSkip) walk(child, query, false);
      continue;
    }
    if (child.type !== 'text' || insideSkipped) continue;

    const replacementLength = splitTextNode(node, index, query);
    if (replacementLength > 0) index += replacementLength - 1;
  }
}

export function rehypeSearchHighlights(options: { query: string }) {
  return function transformer(tree: Root): void {
    if (!options.query.trim()) return;
    walk(tree, options.query);
  };
}

export default rehypeSearchHighlights;
