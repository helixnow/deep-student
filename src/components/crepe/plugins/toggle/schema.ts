/**
 * Toggle 节点 schema。
 *
 * attrs:
 *   - title: 标题纯文本（存 attr，NodeView 内 contenteditable 编辑）
 *   - open:  是否展开；序列化到 Markdown 时用 `[!toggle]-` / `[!toggle]` 持久化
 */

import { expectDomTypeError } from '@milkdown/exception'
import type { MarkdownNode } from '@milkdown/transformer'
import { $nodeSchema } from '@milkdown/utils'

import { formatToggleMarker, TOGGLE_TYPE } from './marker'

export const TOGGLE_DATA_TYPE = 'toggle'

export const toggleSchema = $nodeSchema(TOGGLE_TYPE, () => ({
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  attrs: {
    title: {
      default: '',
      validate: 'string',
    },
    open: {
      default: true,
      validate: 'boolean',
    },
  },
  parseDOM: [
    {
      tag: `div[data-type="${TOGGLE_DATA_TYPE}"]`,
      contentElement: '[data-toggle-body]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom)
        return {
          title: dom.getAttribute('data-title') ?? '',
          open: dom.getAttribute('data-open') !== 'false',
        }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': TOGGLE_DATA_TYPE,
      'data-title': node.attrs.title as string,
      'data-open': node.attrs.open ? 'true' : 'false',
      class: 'milkdown-toggle',
    },
    ['div', { 'data-toggle-body': 'true', class: 'milkdown-toggle__body' }, 0],
  ],
  parseMarkdown: {
    match: ({ type }) => type === TOGGLE_TYPE,
    runner: (state, node, type) => {
      const md = node as MarkdownNode & { open?: boolean; title?: string }
      const open = Boolean(md.open ?? true)
      const title = String(md.title ?? '')
      state.openNode(type, { title, open })
      state.next(md.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === TOGGLE_TYPE,
    runner: (state, node) => {
      const title = String(node.attrs.title ?? '')
      const open = Boolean(node.attrs.open)
      state.openNode('blockquote')
      state.openNode('paragraph')
      state.addNode('text', undefined, formatToggleMarker(title, open))
      state.closeNode()
      state.next(node.content)
      state.closeNode()
    },
  },
}))
