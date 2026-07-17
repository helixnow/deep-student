import { expectDomTypeError } from '@milkdown/exception';
import { $nodeSchema } from '@milkdown/utils';

import { normalizeCalloutType, type CalloutType } from './types';

export const CALLOUT_DATA_TYPE = 'callout';

export const calloutSchema = $nodeSchema('callout', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  isolating: true,
  attrs: {
    type: {
      default: 'note' satisfies CalloutType,
      validate: 'string',
    },
    title: {
      default: '',
      validate: 'string',
    },
  },
  parseDOM: [
    {
      tag: `div[data-type="${CALLOUT_DATA_TYPE}"]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom);
        return {
          type: normalizeCalloutType(dom.getAttribute('data-callout-type')),
          title: dom.getAttribute('data-callout-title') ?? '',
        };
      },
    },
  ],
  toDOM: (node) => {
    const type = normalizeCalloutType(node.attrs.type as string);
    const title = String(node.attrs.title ?? '');
    return [
      'div',
      {
        'data-type': CALLOUT_DATA_TYPE,
        'data-callout-type': type,
        'data-callout-title': title,
        class: `crepe-callout crepe-callout--${type}`,
      },
      ['div', { class: 'crepe-callout__content' }, 0],
    ];
  },
  parseMarkdown: {
    match: (node) => node.type === 'callout',
    runner: (state, node, type) => {
      const calloutType = normalizeCalloutType(
        String(node.calloutType ?? node['data-callout-type'] ?? 'note'),
      );
      const title = String(node.calloutTitle ?? node['data-callout-title'] ?? '');
      state.openNode(type, { type: calloutType, title });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      const type = normalizeCalloutType(String(node.attrs.type ?? 'note'));
      const title = String(node.attrs.title ?? '').trim();
      const marker = title ? `[!${type}] ${title}` : `[!${type}]`;

      // Use html (not text) so remark-stringify does not escape `[` as `\[`.
      // Serialized form remains Obsidian-compatible: `> [!type] title`.
      state.openNode('blockquote');
      state.addNode('html', undefined, marker);
      state.next(node.content);
      state.closeNode();
    },
  },
}));
