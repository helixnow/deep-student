import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx, editorViewOptionsCtx, parserCtx } from '@milkdown/core'
import { automd } from '@milkdown/plugin-automd'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { beforeAll, afterAll } from 'vitest'
import { calloutPlugin } from '../../callout'
import { togglePlugin } from '../index'

// jsdom has no layout; only provide the Range geometry needed by Crepe's cursor.
beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([new DOMRect()], { item: () => new DOMRect() })
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, 'getClientRects')
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
})

export async function createToggleEditor(markdown: string, readOnly = false) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const crepe = new Crepe({
    root, defaultValue: markdown,
    features: {
      [CrepeFeature.AI]: false,
      [CrepeFeature.Toolbar]: false,
      [CrepeFeature.BlockEdit]: false,
      [CrepeFeature.LinkTooltip]: false,
    },
  })
  crepe.editor.use(automd).use(calloutPlugin()).use(togglePlugin())
  crepe.editor.config((ctx) => ctx.update(editorViewOptionsCtx, (options) => ({
    ...options, handleScrollToSelection: () => true,
  })))
  await crepe.create()
  crepe.setReadonly(readOnly)
  return {
    crepe, editor: crepe.editor, root,
    view: crepe.editor.ctx.get(editorViewCtx),
    parse: crepe.editor.ctx.get(parserCtx),
    destroy: async () => { await crepe.destroy(); root.remove() },
  }
}

export function select(view: EditorView, from: number, to = from) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
}

/** Actual plugin chain with browser's default text insertion fallback. */
export function typeText(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (fn) => fn(view, from, to, char, () => view.state.tr.insertText(char, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to))
  }
}

export function key(view: EditorView, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

export function bodyStart(view: EditorView, togglePos = 0) {
  return togglePos + view.state.doc.nodeAt(togglePos)!.child(0).nodeSize + 3
}
