/**
 * remark 插件：将 text 中的 [[target|label]] 提升为 mdast `wikilink` 节点，
 * 以便 parseMarkdown 映射到 atom node；避免落入 text 后被 stringify 转义为 \[\[（Milkdown#1278）。
 */

import { $remark } from '@milkdown/utils';
import { visit } from 'unist-util-visit';

import { parseWikiLinkInner, wikiLinkGlobalPattern } from './format';

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  target?: string;
  label?: string;
};

function remarkWikilinkTransform() {
  return (tree: MdastNode) => {
    visit(tree, 'text', (node: MdastNode, index: number | undefined, parent: MdastNode | undefined) => {
      if (!parent?.children || typeof index !== 'number' || !node.value) return;

      const pattern = wikiLinkGlobalPattern();
      const value = node.value;
      const parts: MdastNode[] = [];
      let last = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(value))) {
        if (match.index > last) {
          parts.push({ type: 'text', value: value.slice(last, match.index) });
        }
        const parsed = parseWikiLinkInner(match[1]);
        if (parsed) {
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

      if (parts.length === 0) return;
      if (last < value.length) {
        parts.push({ type: 'text', value: value.slice(last) });
      }

      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

export const remarkWikilinkPlugin = $remark('remark-wikilink', () => remarkWikilinkTransform);
