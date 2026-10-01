import { parserCtx, serializerCtx } from '@milkdown/core'
import { Fragment, Slice, type Node } from '@milkdown/prose/model'
import { Plugin, TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { $prose } from '@milkdown/utils'
import { columnsKey, type ColumnsOptions } from './config'
import { exitColumns } from './commands'
import { columnsClipboardMarkdown, containsColumns, flattenColumns } from './export'
import { COLUMNS_TYPE, COLUMN_TYPE } from './format'

/** PM content expressions cannot prohibit one member of `block` recursively.
 * Cache immutable subtrees so ordinary typing only revalidates its changed path. */
export function createColumnsValidator() {
  const cache = new WeakMap<Node, boolean>()
  const ordinary = (node: Node): boolean => {
    if (node.type.name === COLUMNS_TYPE || node.type.name === COLUMN_TYPE) return false
    const known = cache.get(node)
    if (known !== undefined) return known
    let valid = true
    node.forEach((child) => { if (valid && !ordinary(child)) valid = false })
    cache.set(node, valid)
    return valid
  }
  return (doc: Node): boolean => {
    let valid = true
    doc.forEach((node) => {
      if (!valid) return
      if (node.type.name !== COLUMNS_TYPE) { valid = ordinary(node); return }
      const known = cache.get(node)
      if (known !== undefined) { valid = known; return }
      let layoutValid = node.childCount === 2 && (node.attrs.layout === 'equal' || node.attrs.layout === 'cornell')
      node.forEach((column) => {
        if (column.type.name !== COLUMN_TYPE || column.childCount < 1) layoutValid = false
        column.forEach((child) => { if (!ordinary(child)) layoutValid = false })
      })
      cache.set(node, layoutValid)
      valid = layoutValid
    })
    return valid
  }
}

function hasColumns(doc: Node): boolean {
  let found = false
  doc.forEach((node) => { if (node.type.name === COLUMNS_TYPE) found = true })
  return found
}

export function columnsBehavior(options: ColumnsOptions) {
  return $prose((ctx) => {
    const valid = createColumnsValidator()
    const copy = (view: EditorView, event: ClipboardEvent, cut: boolean) => {
      if (!event.clipboardData || view.state.selection.empty) return false
      const selected = view.state.selection.content()
      if (!containsColumns(selected.content)) return false
      const { dom, slice } = view.serializeForClipboard(selected)
      event.clipboardData.clearData()
      event.clipboardData.setData('text/html', dom.innerHTML)
      event.clipboardData.setData('text/plain', columnsClipboardMarkdown(slice, view.state.doc, ctx.get(serializerCtx)))
      event.preventDefault()
      if (cut && view.editable && options.canWrite()) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'))
      return true
    }
    return new Plugin<ColumnsOptions>({
      key: columnsKey,
      state: { init: (_config, state) => {
        if (!valid(state.doc)) throw new Error('Columns must be top-level, contain exactly two columns, and cannot nest.')
        return options
      }, apply: (_tr, value) => value },
      filterTransaction: (tr, state) => !tr.docChanged || (valid(tr.doc)
        && (options.canWrite() || (!hasColumns(state.doc) && !hasColumns(tr.doc)))),
      props: {
        // Milkdown's existing clipboardTextSerializer precedes extension plugins.
        // DOM copy/cut owns just structural selections and retains PM's HTML slice.
        handleDOMEvents: {
          copy: (view, event) => copy(view, event, false),
          cut: (view, event) => copy(view, event, true),
          paste: (view, event) => {
            const data = event.clipboardData
            if (!view.editable || !data || data.files.length || data.getData('text/html') || data.getData('vscode-editor-data')) return false
            if (view.state.selection.$from.parent.type.spec.code) return false
            const text = data.getData('text/plain')
            if (!text.includes(':::ds-columns')) return false
            const parsed = ctx.get(parserCtx)(text)
            if (!parsed || !containsColumns(parsed.content)) return false
            const nested = view.state.selection.$from.depth > 1 || !options.canWrite()
            const content = nested ? flattenColumns(parsed.content) : parsed.content
            view.dispatch(view.state.tr.replaceSelection(new Slice(content, 0, 0)).scrollIntoView().setMeta('uiEvent', 'paste'))
            event.preventDefault()
            return true
          },
        },
        transformPasted: (slice, view) => {
          // At a nested destination, pasted layouts degrade to their block content.
          // HTML clipboard retains structure for root-to-root copies.
          const { $from } = view.state.selection
          if ($from.depth > 1 || !options.canWrite()) {
            return Slice.maxOpen(flattenColumns(slice.content))
          }
          // A copied individual column has no legal standalone schema position.
          const nodes: Node[] = []
          slice.content.forEach((node) => {
            if (node.type.name === COLUMN_TYPE) node.content.forEach((child) => nodes.push(child))
            else {
              const candidate = view.state.schema.topNodeType.create(null, node)
              if (valid(candidate)) nodes.push(node)
              else flattenColumns(Fragment.from(node)).forEach((child) => nodes.push(child))
            }
          })
          return Slice.maxOpen(Fragment.from(nodes))
        },
        handleKeyDown: (view, event) => {
          if (!view.editable || event.isComposing || event.keyCode === 229) return false
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
            return exitColumns(view.state, view.dispatch)
          }
          if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false
          const { selection } = view.state
          if (!(selection instanceof TextSelection) || !selection.empty) return false
          const { $from } = selection
          if ($from.depth !== 3 || $from.node(1).type.name !== COLUMNS_TYPE) return false
          const column = $from.node(2)
          // Native deletion must not join two columns or lift their last block.
          if (event.key === 'Backspace' && $from.index(2) === 0 && $from.parentOffset === 0) return true
          if (event.key === 'Delete' && $from.index(2) === column.childCount - 1 && $from.parentOffset === $from.parent.content.size) return true
          if (event.key !== 'Enter' || $from.parent.type.name !== 'paragraph' || $from.parent.content.size || $from.index(2) !== column.childCount - 1) return false
          if (!options.canWrite()) return true
          const tr = view.state.tr
          const right = $from.index(1) === 1
          const destination = right ? $from.after(1) : $from.after(2) + 1
          // Keep at least one block per column.
          if (column.childCount > 1) tr.delete($from.before(3), $from.after(3))
          const pos = tr.mapping.map(destination)
          if (right && !tr.doc.nodeAt(pos)?.isTextblock) tr.insert(pos, view.state.schema.nodes.paragraph.create())
          view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + (right ? 1 : 0)))).scrollIntoView())
          return true
        },
      },
    })
  })
}
