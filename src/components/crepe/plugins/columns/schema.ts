import { $nodeSchema } from '@milkdown/utils'
import { COLUMNS_TYPE, COLUMN_TYPE } from './format'

export const columnsSchema = $nodeSchema(COLUMNS_TYPE, () => ({
  group: 'block',
  content: `${COLUMN_TYPE} ${COLUMN_TYPE}`,
  defining: true,
  isolating: true,
  attrs: { layout: { default: 'equal', validate: (value: unknown) => {
    if (value !== 'equal' && value !== 'cornell') throw new RangeError('Unsupported columns layout')
  } } },
  parseDOM: [{ tag: 'div[data-ds-columns="1"]', getAttrs: (dom) => ({
    layout: (dom as HTMLElement).getAttribute('data-layout') === 'cornell' ? 'cornell' : 'equal',
  }) }],
  toDOM: (node) => ['div', {
    'data-ds-columns': '1', 'data-layout': node.attrs.layout,
    class: 'ds-note-columns',
  }, 0],
  parseMarkdown: {
    match: (node) => node.type === COLUMNS_TYPE,
    runner: (state, node, type) => {
      state.openNode(type, { layout: node.layout })
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === COLUMNS_TYPE,
    runner: (state, node) => {
      state.openNode(COLUMNS_TYPE, undefined, { layout: node.attrs.layout })
      state.next(node.content)
      state.closeNode()
    },
  },
}))

export const columnSchema = $nodeSchema(COLUMN_TYPE, () => ({
  // No `block` group: columns cannot become free-standing document blocks.
  content: 'block+',
  defining: true,
  isolating: true,
  selectable: false,
  parseDOM: [{ tag: 'div[data-ds-column]' }],
  toDOM: () => ['div', { 'data-ds-column': '', class: 'ds-note-column' }, 0],
  parseMarkdown: {
    match: (node) => node.type === COLUMN_TYPE,
    runner: (state, node, type) => { state.openNode(type); state.next(node.children); state.closeNode() },
  },
  toMarkdown: {
    match: (node) => node.type.name === COLUMN_TYPE,
    runner: (state, node) => { state.openNode(COLUMN_TYPE); state.next(node.content); state.closeNode() },
  },
}))
