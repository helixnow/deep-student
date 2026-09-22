import type { Node } from '@milkdown/prose/model'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/prose/view'
import { $prose, $view } from '@milkdown/utils'
import i18next from 'i18next'

import { TOGGLE_TYPE } from './marker'
import { TOGGLE_DATA_TYPE, toggleSchema, toggleBodySchema } from './schema'
import { ensureToggleStyles } from './styles'

interface ToggleViewState {
  sync: () => void
  reveal: () => () => void
  open: () => void
}
const views = new WeakMap<EditorView, Map<HTMLElement, ToggleViewState>>()

/** Search/navigation contract: reveal every containing toggle, without a transaction.
 * Release when changing/clearing the hit. Restores the user's local expansion,
 * supports overlapping reveal owners, and also works in readOnly editors. */
export function revealToggleAtPosition(view: EditorView, pos: number): () => void {
  const releases: Array<() => void> = []
  const $pos = view.state.doc.resolve(pos)
  for (let depth = 1; depth <= $pos.depth; depth++) {
    if ($pos.node(depth).type.name !== TOGGLE_TYPE) continue
    const dom = view.nodeDOM($pos.before(depth))
    if (dom instanceof HTMLElement) {
      const release = views.get(view)?.get(dom)?.reveal()
      if (release) releases.push(release)
    }
  }
  return () => releases.forEach((release) => release())
}

/** Keyboard navigation opens the body locally, retaining the author's default. */
export function openToggleView(view: EditorView, pos: number): void {
  const dom = view.nodeDOM(pos)
  if (dom instanceof HTMLElement) views.get(view)?.get(dom)?.open()
}

// Runs after PM has rendered both children (including the first render).
export const toggleViewSync = $prose(() => new Plugin({
  view: (view) => {
    const sync = () => views.get(view)?.forEach((entry) => entry.sync())
    sync()
    return { update: sync }
  },
}))

function createToggleNodeView(initialNode: Node, view: EditorView): NodeView {
  ensureToggleStyles()
  let node = initialNode
  let localOpen: boolean | undefined
  let destroyed = false
  const reveals = new Set<object>()
  const dom = document.createElement('div')
  dom.className = 'milkdown-toggle'
  dom.dataset.type = TOGGLE_DATA_TYPE
  const arrow = document.createElement('button')
  arrow.type = 'button'
  arrow.contentEditable = 'false'
  arrow.className = 'milkdown-toggle__arrow'
  arrow.setAttribute('aria-label', i18next.t('notes:toggle.arrowLabel', { defaultValue: '展开或折叠' }))
  arrow.textContent = '▸'
  const contentDOM = document.createElement('div')
  contentDOM.className = 'milkdown-toggle__content'
  dom.append(arrow, contentDOM)

  const sync = () => {
    if (destroyed) return
    const open = reveals.size > 0 || (localOpen ?? Boolean(node.attrs.open))
    dom.dataset.open = String(node.attrs.open)
    dom.dataset.viewOpen = String(open)
    const bodyNode = node.child(1)
    dom.dataset.empty = String(bodyNode.childCount === 1 && bodyNode.firstChild!.isTextblock && !bodyNode.firstChild!.content.size)
    arrow.setAttribute('aria-expanded', String(open))
    const body = contentDOM.children[1]
    if (body) {
      body.setAttribute('aria-hidden', String(!open))
      body.toggleAttribute('inert', !open)
    }
  }
  const onClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    localOpen = !(localOpen ?? Boolean(node.attrs.open))
    sync()
  }
  arrow.addEventListener('click', onClick)
  let entries = views.get(view)
  if (!entries) views.set(view, entries = new Map())
  entries.set(dom, {
    sync,
    open: () => { localOpen = true; sync() },
    reveal: () => {
      const token = {}
      reveals.add(token)
      sync()
      return () => { reveals.delete(token); sync() }
    },
  })
  sync()
  return {
    dom, contentDOM,
    update: (updated) => {
      if (updated.type !== node.type) return false
      node = updated
      sync()
      return true
    },
    ignoreMutation: (mutation) => {
      if (arrow.contains(mutation.target)) return true
      return mutation.type === 'attributes' && (
        mutation.target === dom || mutation.target === contentDOM.children[1]
      )
    },
    stopEvent: (event) => event.target instanceof globalThis.Node && arrow.contains(event.target),
    destroy: () => {
      destroyed = true
      entries.delete(dom)
      arrow.removeEventListener('click', onClick)
    },
  }
}

export const toggleView = $view(toggleSchema.node, (): NodeViewConstructor => {
  return (node, view) => createToggleNodeView(node, view)
})

// PM observes a body's nearest NodeView, not its outer toggle's ignoreMutation.
// Own only the view attributes here; all content/selection mutations stay native.
export const toggleBodyView = $view(toggleBodySchema.node, (): NodeViewConstructor => () => {
  const dom = document.createElement('div')
  dom.className = 'milkdown-toggle__body'
  dom.dataset.toggleBody = 'true'
  const contentDOM = document.createElement('div')
  contentDOM.className = 'milkdown-toggle__body-inner'
  contentDOM.dataset.emptyPlaceholder = i18next.t('notes:toggle.emptyPlaceholder', { defaultValue: '空的折叠块，输入内容…' })
  dom.append(contentDOM)
  return {
    dom, contentDOM,
    ignoreMutation: (mutation) => mutation.type === 'attributes' && mutation.target === dom,
  }
})
