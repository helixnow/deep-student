/**
 * Toggle NodeView：本实例展开状态 + 标题 contenteditable + 可折叠内容区。
 */

import type { Node } from '@milkdown/prose/model'
import { Plugin, TextSelection } from '@milkdown/prose/state'
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/prose/view'
import { $prose, $view } from '@milkdown/utils'
import i18next from 'i18next'

import { TOGGLE_DATA_TYPE, toggleSchema } from './schema'
import { ensureToggleStyles } from './styles'

function t(key: string, defaultValue: string): string {
  return i18next.t(key, { defaultValue })
}

// setProps({ editable }) does not necessarily update unchanged NodeViews.
const editableSyncs = new WeakMap<EditorView, Set<() => void>>()

export const toggleEditableSync = $prose(() => new Plugin({
  view: () => ({
    update: (view) => editableSyncs.get(view)?.forEach((sync) => sync()),
  }),
}))

function isToggleContentEmpty(node: Node): boolean {
  if (node.childCount !== 1) return false
  const first = node.firstChild
  return Boolean(first && first.isTextblock && first.content.size === 0)
}

function syncEmptyDom(root: HTMLElement, node: Node): void {
  root.dataset.empty = isToggleContentEmpty(node) ? 'true' : 'false'
}

function createToggleNodeView(
  initialNode: Node,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  ensureToggleStyles()

  let node = initialNode
  // Undefined follows the author's default; interaction lasts for this NodeView.
  let localOpen: boolean | undefined
  let destroyed = false
  let composing = false
  let editable = view.editable

  const dom = document.createElement('div')
  dom.className = 'milkdown-toggle'
  dom.dataset.type = TOGGLE_DATA_TYPE
  dom.dataset.open = String(Boolean(node.attrs.open))
  syncEmptyDom(dom, node)
  dom.setAttribute('data-title', String(node.attrs.title ?? ''))

  const header = document.createElement('div')
  header.className = 'milkdown-toggle__header'
  header.contentEditable = 'false'

  const arrow = document.createElement('button')
  arrow.type = 'button'
  arrow.className = 'milkdown-toggle__arrow'
  arrow.setAttribute(
    'aria-label',
    t('notes:toggle.arrowLabel', '展开或折叠'),
  )
  arrow.textContent = '▸'

  const titleEl = document.createElement('div')
  titleEl.className = 'milkdown-toggle__title'
  titleEl.contentEditable = view.editable ? 'true' : 'false'
  titleEl.dataset.placeholder = t('notes:toggle.titlePlaceholder', '无标题')
  titleEl.textContent = String(node.attrs.title ?? '')

  header.append(arrow, titleEl)

  const body = document.createElement('div')
  body.className = 'milkdown-toggle__body'
  body.setAttribute('data-toggle-body', 'true')

  const bodyInner = document.createElement('div')
  bodyInner.className = 'milkdown-toggle__body-inner'
  bodyInner.dataset.emptyPlaceholder = t(
    'notes:toggle.emptyPlaceholder',
    '空的折叠块，输入内容…',
  )
  body.appendChild(bodyInner)

  dom.append(header, body)

  const syncOpenDom = () => {
    const open = localOpen ?? Boolean(node.attrs.open)
    // data-open remains the persisted default for DOM parsing/copying.
    dom.dataset.viewOpen = String(open)
    arrow.setAttribute('aria-expanded', String(open))
    body.setAttribute('aria-hidden', String(!open))
    body.toggleAttribute('inert', !open)
  }
  syncOpenDom()

  const livePos = () => {
    if (destroyed || view.isDestroyed) return undefined
    const pos = getPos()
    if (pos == null || view.state.doc.nodeAt(pos) !== node) return undefined
    return pos
  }

  // Native button activation covers pointer, Enter and Space (including AT clicks).
  const onArrowClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (destroyed) return
    localOpen = !(localOpen ?? Boolean(node.attrs.open))
    syncOpenDom()
  }

  arrow.addEventListener('click', onArrowClick)

  const commitTitle = () => {
    if (!view.editable || !editable) return
    const pos = livePos()
    if (pos == null) return
    const next = titleEl.textContent ?? ''
    if (next === String(node.attrs.title ?? '')) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: next }))
  }

  const syncEditable = () => {
    if (editable === view.editable) return
    editable = view.editable
    composing = false
    // Discard an uncommitted draft before disabling editing can trigger blur.
    titleEl.textContent = String(node.attrs.title ?? '')
    titleEl.contentEditable = editable ? 'true' : 'false'
  }
  let syncs = editableSyncs.get(view)
  if (!syncs) editableSyncs.set(view, syncs = new Set())
  syncs.add(syncEditable)

  const onTitleKeydown = (event: KeyboardEvent) => {
    if (!view.editable || !editable || livePos() == null) return
    if (composing || event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      commitTitle()
      const pos = livePos()
      if (pos == null) return
      // 进入内容区首块（折叠态先展开再进入）
      localOpen = true
      syncOpenDom()
      const $pos = view.state.doc.resolve(pos + 1)
      const selection = TextSelection.near($pos, 1)
      view.dispatch(view.state.tr.setSelection(selection))
      view.focus()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      titleEl.textContent = String(node.attrs.title ?? '')
      view.focus()
    }
  }

  const onCompositionStart = () => { composing = true }
  const onCompositionEnd = () => { composing = false }
  titleEl.addEventListener('blur', commitTitle)
  titleEl.addEventListener('keydown', onTitleKeydown)
  titleEl.addEventListener('compositionstart', onCompositionStart)
  titleEl.addEventListener('compositionend', onCompositionEnd)

  return {
    dom,
    contentDOM: bodyInner,
    update: (updated: Node) => {
      if (updated.type !== node.type) return false
      node = updated
      dom.dataset.open = String(Boolean(updated.attrs.open))
      syncOpenDom()
      syncEmptyDom(dom, updated)
      dom.setAttribute('data-title', String(updated.attrs.title ?? ''))
      syncEditable()
      // 避免覆盖用户正在编辑的标题
      if (document.activeElement !== titleEl) {
        const nextTitle = String(updated.attrs.title ?? '')
        if (titleEl.textContent !== nextTitle) {
          titleEl.textContent = nextTitle
        }
      }
      return true
    },
    ignoreMutation: (mutation) => {
      const target = mutation.target
      // View-only attributes must not enter PM's DOM reparsing / save pipeline.
      if (mutation.type === 'attributes' && (target === dom || target === body)) return true
      if (!(target instanceof HTMLElement) && !(target instanceof Text)) return false
      if (header.contains(target) || target === header) return true
      return false
    },
    stopEvent: (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) && !(target instanceof Text)) return false
      if (arrow === target || arrow.contains(target)) return true
      if (titleEl === target || titleEl.contains(target)) return true
      return false
    },
    destroy: () => {
      destroyed = true
      syncs.delete(syncEditable)
      arrow.removeEventListener('click', onArrowClick)
      titleEl.removeEventListener('blur', commitTitle)
      titleEl.removeEventListener('keydown', onTitleKeydown)
      titleEl.removeEventListener('compositionstart', onCompositionStart)
      titleEl.removeEventListener('compositionend', onCompositionEnd)
      dom.remove()
    },
  }
}

export const toggleView = $view(toggleSchema.node, (): NodeViewConstructor => {
  return (node, view, getPos) => createToggleNodeView(node, view, getPos)
})
