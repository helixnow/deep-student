/**
 * wikilink inline atom node schema
 *
 * toMarkdown 使用 mdast `html` 节点承载原始 `[[...]]` 字符串，
 * 利用 remark-stringify 的 html handler 原样输出，避免 text 路径下的 `\[` 转义（Milkdown#1278）。
 */

import { $nodeSchema } from '@milkdown/utils';

import { formatWikiLink } from './format';

export const WIKILINK_NODE_NAME = 'wikilink';

export const wikilinkSchema = $nodeSchema(WIKILINK_NODE_NAME, () => ({
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,
  marks: '',
  attrs: {
    target: { default: '', validate: 'string' },
    label: { default: '', validate: 'string' },
  },
  parseDOM: [
    {
      tag: `span[data-type="${WIKILINK_NODE_NAME}"]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          target: dom.getAttribute('data-target') || '',
          label: dom.getAttribute('data-label') || '',
        };
      },
    },
  ],
  toDOM: (node) => {
    const display = (node.attrs.label as string) || (node.attrs.target as string) || '';
    return [
      'span',
      {
        'data-type': WIKILINK_NODE_NAME,
        'data-target': node.attrs.target,
        'data-label': node.attrs.label || '',
        class: 'crepe-wikilink',
        spellcheck: 'false',
      },
      display,
    ];
  },
  parseMarkdown: {
    match: (node) => node.type === 'wikilink',
    runner: (state, node, type) => {
      const target = typeof node.target === 'string' ? node.target : '';
      const label = typeof node.label === 'string' ? node.label : '';
      if (!target) return;
      state.addNode(type, { target, label });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === WIKILINK_NODE_NAME,
    runner: (state, node) => {
      const raw = formatWikiLink(node.attrs.target as string, node.attrs.label as string);
      // html → stringify 不转义方括号；parse 时由 remark 再提回 wikilink
      state.addNode('html', undefined, raw);
    },
  },
}));
