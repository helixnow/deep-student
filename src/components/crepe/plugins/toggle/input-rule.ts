/**
 * Toggle input rule。
 *
 * 行首 `> ` 已被 blockquote 占用，故用 `>>> `（三个大于号 + 空格）插入折叠块。
 * 也可仅靠 slash 菜单插入（接线时注册，见交付文档）。
 */

import type { Ctx } from '@milkdown/ctx'
import { InputRule } from '@milkdown/prose/inputrules'
import type { EditorState, Transaction } from '@milkdown/prose/state'
import type { NodeType } from '@milkdown/prose/model'
import { TextSelection } from '@milkdown/prose/state'
import { $inputRule } from '@milkdown/utils'

import { toggleSchema } from './schema'

/** 在当前位置插入一个展开态空 toggle（slash 菜单可复用）。 */
export function createEmptyToggleNode(ctx: Ctx) {
  const type = toggleSchema.type(ctx)
  const paragraph = type.schema.nodes.paragraph
  if (!paragraph) {
    throw new Error('paragraph node missing in schema')
  }
  return type.create({ title: '', open: true }, paragraph.create())
}

/**
 * 将当前 textblock（内容为 `>>> `）替换为展开态空 toggle。
 * 供 InputRule 与单测共用。
 */
export function applyToggleInputRule(
  state: EditorState,
  _match: RegExpMatchArray,
  start: number,
  _end: number,
  toggleNodeType: NodeType = state.schema.nodes.toggle!,
): Transaction | null {
  if (!toggleNodeType) return null

  const $start = state.doc.resolve(start)
  if (!$start.parent.type.isTextblock) return null

  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return null

  const from = $start.before()
  const to = $start.after()
  const toggleNode = toggleNodeType.create({ title: '', open: true }, paragraph.create())
  const tr = state.tr.replaceWith(from, to, toggleNode)
  const sel = TextSelection.near(tr.doc.resolve(from + 1), 1)
  return tr.setSelection(sel)
}

export const toggleInputRule = $inputRule((ctx) => {
  return new InputRule(/^>>>\s$/, (state, match, start, end) =>
    applyToggleInputRule(state, match, start, end, toggleSchema.type(ctx)),
  )
})
