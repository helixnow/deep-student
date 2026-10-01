import { SchemaReady, prosePluginsCtx } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { Fragment, type ResolvedPos } from '@milkdown/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { TOGGLE_TYPE } from './marker'
import { TOGGLE_TITLE_TYPE, TOGGLE_BODY_TYPE } from './schema'
import { openToggleView } from './view'

export const toggleKeymapKey = new PluginKey('milkdown-toggle-keymap')

function findToggleDepth($from: ResolvedPos): number {
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === TOGGLE_TYPE) return depth
  }
  return -1
}

function selectBody(view: EditorView, depth: number): boolean {
  const { $from } = view.state.selection
  const pos = $from.before(depth)
  const bodyPos = pos + 1 + $from.node(depth).child(0).nodeSize
  openToggleView(view, pos)
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(bodyPos + 1))).scrollIntoView())
  return true
}

/** Lossless conversion: title becomes a paragraph, all body blocks stay intact. */
export function unwrapToggle(view: EditorView, pos: number): boolean {
  if (!view.editable) return false
  const node = view.state.doc.nodeAt(pos)
  if (node?.type.name !== TOGGLE_TYPE) return false
  const title = view.state.schema.nodes.paragraph.create(null, node.child(0).content)
  const body = node.child(1)
  const emptyBody = body.childCount === 1 && body.firstChild!.type === title.type && !body.firstChild!.content.size
  const content = Fragment.from(title).append(emptyBody ? Fragment.empty : body.content)
  const $pos = view.state.doc.resolve(pos)
  if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, content)) return false
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, content)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView())
  return true
}

/** Only the final empty direct body paragraph exits; nested lists remain native. */
export function tryExitToggleOnEnter(view: EditorView): boolean {
  if (!view.editable) return false
  const { selection } = view.state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const { $from } = selection
  const depth = findToggleDepth($from)
  if (depth < 0 || $from.depth !== depth + 2 || $from.node(depth + 1).type.name !== TOGGLE_BODY_TYPE) return false
  const body = $from.node(depth + 1)
  if ($from.index(depth + 1) !== body.childCount - 1 || body.childCount <= 1 || $from.parent.content.size) return false
  const tr = view.state.tr.delete($from.before(), $from.after())
  const insertPos = tr.mapping.map($from.after(depth))
  tr.insert(insertPos, view.state.schema.nodes.paragraph.create())
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1))).scrollIntoView())
  return true
}

export function tryUnwrapEmptyToggleOnBackspace(view: EditorView): boolean {
  if (!view.editable) return false
  const { selection } = view.state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const { $from } = selection
  const depth = findToggleDepth($from)
  if (depth < 0 || $from.parentOffset || $from.depth !== depth + 2) return false
  const body = $from.node(depth + 1)
  if (body.type.name !== TOGGLE_BODY_TYPE || body.childCount !== 1 || $from.parent.content.size) return false
  return unwrapToggle(view, $from.before(depth))
}

function inTitle(view: EditorView): boolean {
  const { $from, $to } = view.state.selection
  return $from.parent.type.name === TOGGLE_TITLE_TYPE && $from.sameParent($to)
}

/** Prepend ahead of Crepe/commonmark input, clipboard and keymaps. The title is
 * ordinary PM text, but Markdown shortcuts and rich paste must stay literal. */
export const toggleKeymap: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady)
  const plugin = new Plugin({
    key: toggleKeymapKey,
    props: {
      handleTextInput(view, from, to, text) {
        if (!view.editable || !inTitle(view)) return false
        view.dispatch(view.state.tr.insertText(text.replace(/[\r\n]+/g, ' '), from, to).setStoredMarks([]))
        return true
      },
      handlePaste(view, event, slice) {
        if (!view.editable || !inTitle(view)) return false
        const text = event.clipboardData?.getData('text/plain') || slice.content.textBetween(0, slice.content.size, ' ', (node) => node.attrs.alt ?? '')
        view.dispatch(view.state.tr.insertText(text.replace(/[\r\n]+/g, ' ')).setStoredMarks([]).scrollIntoView())
        return true
      },
      handleKeyDown(view, event) {
        if (!view.editable || view.composing || event.isComposing || event.keyCode === 229) return false
        const { selection } = view.state
        if (!(selection instanceof TextSelection)) return false
        const { $from } = selection
        const depth = findToggleDepth($from)
        if (depth < 0) return false
        if (inTitle(view)) {
          if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) return selectBody(view, depth)
          if (event.key === 'Tab') return true // no indent/outdent of structural title
          if (event.altKey || event.metaKey || event.ctrlKey) return false
          if (selection.empty && event.key === 'Backspace' && !$from.parentOffset) return unwrapToggle(view, $from.before(depth))
          if (selection.empty && event.key === 'Delete' && $from.parentOffset === $from.parent.content.size) return selectBody(view, depth)
          return false
        }
        if (event.altKey || event.metaKey || event.ctrlKey) return false
        if (event.key === 'Enter' && !event.shiftKey) return tryExitToggleOnEnter(view)
        if (!selection.empty || $from.parentOffset || $from.depth !== depth + 2 || $from.index(depth + 1) !== 0) return false
        if (event.key === 'Backspace' || (event.key === 'Tab' && event.shiftKey)) {
          if (event.key === 'Backspace' && tryUnwrapEmptyToggleOnBackspace(view)) return true
          const titleEnd = $from.before(depth) + $from.node(depth).child(0).nodeSize
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, titleEnd)).scrollIntoView())
          return true
        }
        return false
      },
    },
  })
  ctx.update(prosePluginsCtx, (plugins) => [plugin, ...plugins])
  return () => { ctx.update(prosePluginsCtx, (plugins) => plugins.filter((p) => p !== plugin)) }
}
