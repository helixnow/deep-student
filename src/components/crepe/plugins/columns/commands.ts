import { Fragment, type Node, type Schema } from '@milkdown/prose/model'
import { closeHistory } from '@milkdown/prose/history'
import { NodeSelection, TextSelection, type Command, type EditorState } from '@milkdown/prose/state'
import { canWriteColumns } from './config'
import { COLUMNS_TYPE, COLUMN_TYPE, type ColumnsLayout } from './format'
import { flattenColumns } from './export'

export interface CornellLabels { cues: string; notes: string; summary: string }
export const DEFAULT_CORNELL_LABELS: CornellLabels = { cues: '线索（Cues）', notes: '笔记（Notes）', summary: '总结（Summary）' }

function heading(schema: Schema, text: string): Node {
  return schema.nodes.heading.create({ level: 2 }, schema.text(text))
}

export function createColumnsNode(schema: Schema, layout: ColumnsLayout, left: Fragment, right: Fragment): Node {
  const column = (body: Fragment) => schema.nodes[COLUMN_TYPE].createChecked(null,
    body.size ? body : schema.nodes.paragraph.create())
  return schema.nodes[COLUMNS_TYPE].createChecked({ layout }, [column(left), column(right)])
}

function enabled(state: EditorState): boolean {
  return canWriteColumns(state) && !!state.schema.nodes[COLUMNS_TYPE] && !!state.schema.nodes[COLUMN_TYPE]
}

function topLevelRange(state: EditorState): { from: number; to: number; content: Fragment } | null {
  const { selection, doc } = state
  if (selection instanceof NodeSelection) {
    if (selection.$from.depth !== 0 || selection.node.type.name === COLUMNS_TYPE) return null
    return { from: selection.from, to: selection.to, content: Fragment.from(selection.node) }
  }
  if (!(selection instanceof TextSelection) || selection.$from.depth !== 1 || selection.$to.depth !== 1) return null
  const from = selection.$from.before(1)
  // An endpoint at the next paragraph's start excludes that paragraph.
  const to = !selection.empty && selection.$to.parentOffset === 0 && selection.$to.before(1) > from
    ? selection.$to.before(1) : selection.$to.after(1)
  const content = doc.slice(from, to).content
  let hasColumns = false
  content.forEach((node) => { if (node.type.name === COLUMNS_TYPE) hasColumns = true })
  return hasColumns ? null : { from, to, content }
}

/** Collapsed root paragraph only. Nonempty blocks are preserved before the insert. */
export function insertColumns(layout: ColumnsLayout = 'equal', labels = DEFAULT_CORNELL_LABELS): Command {
  return (state, dispatch) => {
    if (!enabled(state) || !state.selection.empty || state.selection.$from.depth !== 1) return false
    const { $from } = state.selection
    const empty = $from.parent.type.name === 'paragraph' && !$from.parent.content.size
    const pos = empty ? $from.before(1) : $from.after(1)
    const p = state.schema.nodes.paragraph.create()
    const left = layout === 'cornell' ? Fragment.from([heading(state.schema, labels.cues), p]) : Fragment.from(p)
    const right = layout === 'cornell' ? Fragment.from([heading(state.schema, labels.notes), p]) : Fragment.from(p)
    const node = createColumnsNode(state.schema, layout, left, right)
    const suffix = layout === 'cornell' ? [heading(state.schema, labels.summary), p] : [p]
    if (dispatch) {
      const tr = closeHistory(state.tr).replaceWith(pos, empty ? $from.after(1) : pos, [node, ...suffix])
      const cursor = pos + 3 + (layout === 'cornell' ? left.firstChild!.nodeSize : 0)
      dispatch(tr.setSelection(TextSelection.create(tr.doc, cursor)).scrollIntoView())
    }
    return true
  }
}

/** Explicitly operates on whole selected top-level blocks (cursor = current block). */
export function convertSelectionToColumns(layout: ColumnsLayout = 'equal', labels = DEFAULT_CORNELL_LABELS): Command {
  return (state, dispatch) => {
    if (!enabled(state)) return false
    const range = topLevelRange(state)
    if (!range) return false
    const p = state.schema.nodes.paragraph.create()
    const left = layout === 'cornell' ? Fragment.from([heading(state.schema, labels.cues), p]) : range.content
    const right = layout === 'cornell' ? Fragment.from(heading(state.schema, labels.notes)).append(range.content) : Fragment.from(p)
    const node = createColumnsNode(state.schema, layout, left, right)
    if (dispatch) {
      const replacement = layout === 'cornell' ? [node, heading(state.schema, labels.summary), p] : [node]
      const tr = closeHistory(state.tr).replaceWith(range.from, range.to, replacement)
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, range.from)).scrollIntoView())
    }
    return true
  }
}

/** Converts the shipped linear Cornell template without moving its preface or summary.
 * Exactly one ordered set of the supplied h2 labels is required; ambiguity is a no-op. */
export function convertCornellTemplate(labels = DEFAULT_CORNELL_LABELS): Command {
  return (state, dispatch) => {
    if (!enabled(state)) return false
    const sections: { node: Node; pos: number; index: number }[] = []
    const names = [labels.cues, labels.notes, labels.summary]
    let hasColumns = false
    state.doc.forEach((node, pos, index) => {
      if (node.type.name === COLUMNS_TYPE) hasColumns = true
      if (node.type.name === 'heading' && node.attrs.level === 2 && names.includes(node.textContent)) sections.push({ node, pos, index })
    })
    if (hasColumns || sections.length !== 3 || sections.some((section, i) => section.node.textContent !== names[i])) return false
    const [cues, notes, summary] = sections
    const node = createColumnsNode(state.schema, 'cornell',
      state.doc.slice(cues.pos, notes.pos).content, state.doc.slice(notes.pos, summary.pos).content)
    if (dispatch) {
      const tr = closeHistory(state.tr).replaceWith(cues.pos, summary.pos, node)
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, cues.pos)).scrollIntoView())
    }
    return true
  }
}

export function selectedColumns(state: EditorState): { node: Node; pos: number } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === COLUMNS_TYPE) return { node: selection.node, pos: selection.from }
  const { $from, $to } = selection
  if ($from.depth >= 1 && $from.node(1).type.name === COLUMNS_TYPE && $to.depth >= 1 && $to.node(1) === $from.node(1)) {
    return { node: $from.node(1), pos: $from.before(1) }
  }
  return null
}

export const unwrapColumns: Command = (state, dispatch) => {
  if (!enabled(state)) return false
  const selected = selectedColumns(state)
  if (!selected) return false
  if (dispatch) {
    const tr = closeHistory(state.tr).replaceWith(selected.pos, selected.pos + selected.node.nodeSize, flattenColumns(selected.node.content))
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(selected.pos + 1))).scrollIntoView())
  }
  return true
}

/** Mod-Enter provides an exit even when both columns end in non-text blocks. */
export const exitColumns: Command = (state, dispatch) => {
  if (!enabled(state)) return false
  const selected = selectedColumns(state)
  if (!selected) return false
  if (dispatch) {
    const pos = selected.pos + selected.node.nodeSize
    const tr = state.tr
    if (!tr.doc.nodeAt(pos)?.isTextblock) tr.insert(pos, state.schema.nodes.paragraph.create())
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView())
  }
  return true
}

export const insertCornell = (labels = DEFAULT_CORNELL_LABELS) => insertColumns('cornell', labels)
export const convertSelectionToCornell = (labels = DEFAULT_CORNELL_LABELS) => convertSelectionToColumns('cornell', labels)
