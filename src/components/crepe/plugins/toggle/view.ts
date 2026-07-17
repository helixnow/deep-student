/**
 * Toggle NodeView：箭头切换 open + 标题 contenteditable + 可折叠内容区。
 */

import type { Node } from '@milkdown/prose/model'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view'
import { $view } from '@milkdown/utils'
import i18next from 'i18next'

import { TOGGLE_DATA_TYPE, toggleSchema } from './schema'
import { ensureToggleStyles } from './styles'

function t(key: string, defaultValue: string): string {
  return i18next.t(key, { defaultValue })
}

function syncOpenDom(root: HTMLElement, open: boolean): void {
  root.dataset.open = open ? 'true' : 'false'
  root.setAttribute('data-open', open ? 'true' : 'false')
}

function createToggleNodeView(
  initialNode: Node,
  view: EditorView,
  getPos: () => number | undefined,
) {
  ensureToggleStyles()

  let node = initialNode

  const dom = document.createElement('div')
  dom.className = 'milkdown-toggle'
  dom.dataset.type = TOGGLE_DATA_TYPE
  syncOpenDom(dom, Boolean(node.attrs.open))
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
  body.appendChild(bodyInner)

  dom.append(header, body)

  const setAttrs = (attrs: Record<string, unknown>) => {
    if (!view.editable) return
    const pos = getPos()
    if (pos == null) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }))
  }

  const onArrowPointerDown = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!view.editable) return
    setAttrs({ open: !node.attrs.open })
  }

  arrow.addEventListener('mousedown', onArrowPointerDown)
  arrow.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  const commitTitle = () => {
    const next = titleEl.textContent ?? ''
    if (next === String(node.attrs.title ?? '')) return
    setAttrs({ title: next })
    dom.setAttribute('data-title', next)
  }

  titleEl.addEventListener('blur', commitTitle)
  titleEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitTitle()
      const pos = getPos()
      if (pos == null) return
      // 进入内容区首块
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
  })

  return {
    dom,
    contentDOM: bodyInner,
    update: (updated: Node) => {
      if (updated.type !== node.type) return false
      node = updated
      syncOpenDom(dom, Boolean(updated.attrs.open))
      dom.setAttribute('data-title', String(updated.attrs.title ?? ''))
      titleEl.contentEditable = view.editable ? 'true' : 'false'
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
      arrow.removeEventListener('mousedown', onArrowPointerDown)
      dom.remove()
    },
  }
}

export const toggleView = $view(toggleSchema.node, (): NodeViewConstructor => {
  return (node, view, getPos) => createToggleNodeView(node, view, getPos)
})
