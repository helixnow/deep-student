import type { EditorView } from '@milkdown/prose/view'
import type { Command } from '@milkdown/prose/state'
import {
  insertColumns, insertCornell, convertSelectionToColumns, convertSelectionToCornell,
  convertCornellTemplate, unwrapColumns, type CornellLabels, DEFAULT_CORNELL_LABELS,
} from '@/components/crepe/plugins/columns'

export type NoteLayoutAction = 'insert-columns' | 'insert-cornell' | 'convert-columns'
  | 'convert-cornell' | 'convert-cornell-template' | 'unwrap-columns'

export function noteLayoutCommand(action: NoteLayoutAction, labels: CornellLabels = DEFAULT_CORNELL_LABELS): Command {
  switch (action) {
    case 'insert-columns': return insertColumns()
    case 'insert-cornell': return insertCornell(labels)
    case 'convert-columns': return convertSelectionToColumns()
    case 'convert-cornell': return convertSelectionToCornell(labels)
    case 'convert-cornell-template': return convertCornellTemplate(labels)
    case 'unwrap-columns': return unwrapColumns
  }
}

/** Hosts render only available actions. Dry runs never dispatch or change selection. */
export function availableNoteLayoutActions(view: EditorView, labels?: CornellLabels): NoteLayoutAction[] {
  if (!view.editable) return []
  const actions: NoteLayoutAction[] = ['insert-columns', 'insert-cornell', 'convert-columns',
    'convert-cornell', 'convert-cornell-template', 'unwrap-columns']
  return actions.filter((action) => noteLayoutCommand(action, labels)(view.state))
}

export function runNoteLayoutAction(view: EditorView, action: NoteLayoutAction, labels?: CornellLabels): boolean {
  if (!view.editable) return false
  const applied = noteLayoutCommand(action, labels)(view.state, view.dispatch, view)
  if (applied) view.focus()
  return applied
}
