/**
 * remark 插件：将 text 中的 [[target|label]] 提升为 mdast `wikilink` 节点，
 * 以便 parseMarkdown 映射到 atom node；避免落入 text 后被 stringify 转义为 \[\[（Milkdown#1278）。
 */

import { $remark } from '@milkdown/kit/utils';
import { visit } from 'unist-util-visit';

import { AUTOMD_PLACEHOLDER_PATTERN, parseWikiLinkInner, wikiLinkGlobalPattern } from './format';

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  target?: string;
  label?: string;
};

function splitWikilinkParts(value: string): MdastNode[] | null {
  const pattern = wikiLinkGlobalPattern();
  const parts: MdastNode[] = [];
  let last = 0;
  let foundWikilink = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    if (match.index > last) {
      parts.push({ type: 'text', value: value.slice(last, match.index) });
    }
    // Never turn a span containing an @milkdown/plugin-automd inline-sync
    // cursor placeholder (⁂ / ∴ / ∅) into an atom wikilink node: atom nodes
    // have empty textContent so automd's calcOffset cannot find or remove
    // the placeholder, causing it to leak visibly into the document.
    const inner = match[1];
    const parsed = AUTOMD_PLACEHOLDER_PATTERN.test(inner) ? null : parseWikiLinkInner(inner);
    if (parsed) {
      foundWikilink = true;
      parts.push({
        type: 'wikilink',
        target: parsed.target,
        label: parsed.label,
        value: match[0],
      });
    } else {
      parts.push({ type: 'text', value: match[0] });
    }
    last = match.index + match[0].length;
  }

  if (!foundWikilink) return null;
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) });
  }
  return parts;
}

function remarkWikilinkTransform() {
  return (tree: MdastNode) => {
    const visitNode = (
      node: MdastNode,
      index: number | undefined,
      parent: MdastNode | undefined,
    ) => {
      if (!parent?.children || typeof index !== 'number' || !node.value) return;
      // Only promote raw [[...]] emitted as mdast `html` nodes (e.g. by
      // wikilinkSchema.toMarkdown) — never rewrite real HTML tags/attributes.
      if (node.type === 'html' && /[<>]/.test(node.value)) return;

      const parts = splitWikilinkParts(node.value);
      if (!parts) return;

      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    };

    visit(tree, 'text', visitNode);
    visit(tree, 'html', visitNode);
  };
}

export const remarkWikilinkPlugin = $remark('remark-wikilink', () => remarkWikilinkTransform);
