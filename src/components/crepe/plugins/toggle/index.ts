/**
 * Notion 式 Toggle（折叠）块 — Milkdown/Crepe 插件入口。
 *
 * 语法：Obsidian 折叠 callout
 *   > [!toggle]- 标题   （默认折叠，open=false）
 *   > [!toggle] 标题    （默认展开，open=true）
 *
 * 不自行注册到编辑器；由接线代理 `crepe.editor.use(togglePlugin())`。
 */

import type { MilkdownPlugin } from '@milkdown/ctx'

import { toggleInputRule } from './input-rule'
import { toggleKeymap } from './keymap'
import { remarkTogglePlugin } from './remark'
import { toggleSchema } from './schema'
import { toggleView } from './view'

export { applyToggleInputRule, createEmptyToggleNode, toggleInputRule } from './input-rule'
export { tryExitToggleOnEnter, toggleKeymap, toggleKeymapKey } from './keymap'
export {
  formatToggleMarker,
  isToggleMarkerText,
  parseToggleMarker,
  TOGGLE_TYPE,
  type ToggleMarker,
} from './marker'
export { remarkTogglePlugin } from './remark'
export { TOGGLE_DATA_TYPE, toggleSchema } from './schema'
export { ensureToggleStyles, TOGGLE_STYLE } from './styles'
export { toggleView } from './view'

/** 统一入口：返回可 `editor.use(...)` 的插件列表（不自行注册）。 */
export function togglePlugin(): MilkdownPlugin[] {
  return [
    remarkTogglePlugin,
    toggleSchema,
    toggleView,
    toggleInputRule,
    toggleKeymap,
  ].flat()
}
