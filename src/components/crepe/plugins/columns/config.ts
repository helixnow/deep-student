import { PluginKey, type EditorState } from '@milkdown/prose/state'

export interface ColumnsOptions {
  /** True only after this page's format upgrade and write gate are established.
   * Queried at dispatch time so switching pages cannot retain a stale grant. */
  canWrite: () => boolean
}

export const columnsKey = new PluginKey<ColumnsOptions>('ds-columns')
export const canWriteColumns = (state: EditorState) => columnsKey.getState(state)?.canWrite() === true
