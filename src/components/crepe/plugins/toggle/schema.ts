import { DOMParser, Fragment, type Node, type Schema, type Attrs } from '@milkdown/prose/model'
import type { MarkdownNode } from '@milkdown/transformer'
import { $nodeSchema } from '@milkdown/utils'
import i18next from 'i18next'

import { formatToggleMarker, TOGGLE_TYPE } from './marker'

export const TOGGLE_DATA_TYPE = 'toggle'
export const TOGGLE_TITLE_TYPE = 'toggleTitle'
export const TOGGLE_BODY_TYPE = 'toggleBody'

/** The only title authority is child(0). attrs.open is the author's defaultOpen. */
export function createToggleNode(schema: Schema, title = '', body?: Fragment | Node | readonly Node[], attrs: Attrs = {}) {
  return schema.nodes[TOGGLE_TYPE].createChecked({ open: true, ...attrs }, [
    schema.nodes[TOGGLE_TITLE_TYPE].createChecked(null, title ? schema.text(title) : undefined),
    schema.nodes[TOGGLE_BODY_TYPE].createChecked(null, body ?? schema.nodes.paragraph.create()),
  ])
}

export const toggleTitleSchema = $nodeSchema(TOGGLE_TITLE_TYPE, () => ({
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,
  whitespace: 'pre',
  parseDOM: [{ tag: '[data-toggle-title]' }],
  toDOM: () => ['div', {
    'data-toggle-title': 'true', class: 'milkdown-toggle__title',
    'data-placeholder': i18next.t('notes:toggle.titlePlaceholder', { defaultValue: '无标题' }),
  }, 0],
  parseMarkdown: {
    match: ({ type }) => type === TOGGLE_TITLE_TYPE,
    runner: (state, node, type) => {
      state.openNode(type)
      if (typeof node.value === 'string' && node.value) state.addText(node.value)
      state.closeNode()
    },
  },
  // Used when a title-only selection is copied as Markdown.
  toMarkdown: {
    match: (node) => node.type.name === TOGGLE_TITLE_TYPE,
    runner: (state, node) => {
      state.openNode('paragraph').addNode('text', undefined, node.textContent).closeNode()
    },
  },
}))

export const toggleBodySchema = $nodeSchema(TOGGLE_BODY_TYPE, () => ({
  content: 'block+',
  defining: true,
  isolating: true,
  parseDOM: [{
    tag: '[data-toggle-body]',
    contentElement: (dom) => dom.querySelector('.milkdown-toggle__body-inner') ?? dom,
  }],
  toDOM: () => ['div', { 'data-toggle-body': 'true', class: 'milkdown-toggle__body' },
    ['div', { class: 'milkdown-toggle__body-inner' }, 0]],
  parseMarkdown: {
    match: ({ type }) => type === TOGGLE_BODY_TYPE,
    runner: (state, node, type) => { state.openNode(type).next(node.children).closeNode() },
  },
  toMarkdown: {
    match: (node) => node.type.name === TOGGLE_BODY_TYPE,
    runner: (state, node) => { state.next(node.content) },
  },
}))

export const toggleSchema = $nodeSchema(TOGGLE_TYPE, () => ({
  group: 'block',
  content: `${TOGGLE_TITLE_TYPE} ${TOGGLE_BODY_TYPE}`,
  defining: true,
  isolating: true,
  attrs: { open: { default: true, validate: 'boolean' } },
  parseDOM: [
    // Old copied HTML really contains data-title + a body with no title node.
    // Consume it once; new documents/HTML never retain a second title authority.
    {
      tag: `div[data-type="${TOGGLE_DATA_TYPE}"][data-title]`,
      getAttrs: (dom) => ({ open: dom.getAttribute('data-open') !== 'false' }),
      getContent: (dom, schema) => {
        const element = dom as HTMLElement
        return createToggleNode(schema, element.getAttribute('data-title') ?? '',
          DOMParser.fromSchema(schema).parse(element.querySelector('.milkdown-toggle__body-inner')
            ?? element.querySelector('[data-toggle-body]') ?? document.createElement('div')).content,
        ).content
      },
    },
    {
      tag: `div[data-type="${TOGGLE_DATA_TYPE}"]`,
      contentElement: (dom) => dom.querySelector('.milkdown-toggle__content') ?? dom,
      getAttrs: (dom) => ({ open: dom.getAttribute('data-open') !== 'false' }),
    },
  ],
  toDOM: (node) => ['div', {
    'data-type': TOGGLE_DATA_TYPE,
    'data-open': String(node.attrs.open),
    class: 'milkdown-toggle',
  }, ['div', { class: 'milkdown-toggle__content' }, 0]],
  parseMarkdown: {
    match: ({ type }) => type === TOGGLE_TYPE,
    runner: (state, node, type) => {
      const md = node as MarkdownNode & { open?: boolean; title?: string }
      state.openNode(type, { open: md.open ?? true })
      state.openNode(state.schema.nodes[TOGGLE_TITLE_TYPE])
      if (md.title) state.addText(md.title)
      state.closeNode()
      state.openNode(state.schema.nodes[TOGGLE_BODY_TYPE]).next(md.children).closeNode()
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === TOGGLE_TYPE,
    runner: (state, node) => {
      state.openNode('blockquote')
      // Raw marker keeps the published [!toggle] syntax. Escape only its plain
      // text title so Markdown punctuation cannot turn into marks/links on reload.
      state.addNode('html', undefined, formatToggleMarker(node.child(0).textContent, node.attrs.open))
      state.next(node.child(1).content)
      state.closeNode()
    },
  },
}))
