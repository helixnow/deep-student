/**
 * Toggle 键盘行为：
 * - 内容区末尾空段落再按 Enter → 跳出 toggle（在其后插入新段落）
 *
 * 标题行 Enter 进入内容区：由 NodeView 处理。
 */

import type { ResolvedPos } from '@milkdown/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { $prose } from '@milkdown/utils'

import { TOGGLE_TYPE } from './marker'

export const toggleKeymapKey = new PluginKey('milkdown-toggle-keymap')

function findToggleDepth($from: ResolvedPos): number {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === TOGGLE_TYPE) return depth
  }
  return -1
}

/**
 * 内容区末尾空块上的第二次 Enter：删除空块并在 toggle 后新建段落。
 */
export function tryExitToggleOnEnter(view: EditorView): boolean {
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  const toggleDepth = findToggleDepth($from)
  if (toggleDepth < 0) return false

  // 必须是 toggle 的直接子 block（不在嵌套列表/引用深处）
  if ($from.depth !== toggleDepth + 1) return false

  const toggle = $from.node(toggleDepth)
  const indexInToggle = $from.index(toggleDepth)
  const isLastChild = indexInToggle === toggle.childCount - 1
  if (!isLastChild) return false

  const parent = $from.parent
  if (parent.content.size > 0) return false

  // 至少保留一个内容块：若 toggle 只剩这一个空块，不退出（避免空 toggle）
  if (toggle.childCount <= 1) return false

  const emptyFrom = $from.before()
  const emptyTo = $from.after()
  const afterToggle = $from.after(toggleDepth)
  const paragraphType = state.schema.nodes.paragraph
  if (!paragraphType) return false

  let tr = state.tr.delete(emptyFrom, emptyTo)
  const insertPos = tr.mapping.map(afterToggle)
  const paragraph = paragraphType.create()
  tr = tr.insert(insertPos, paragraph)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)))
  view.dispatch(tr.scrollIntoView())
  return true
}

export const toggleKeymap = $prose(() => {
  return new Plugin({
    key: toggleKeymapKey,
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
          return false
        }
        return tryExitToggleOnEnter(view)
      },
    },
  })
})
