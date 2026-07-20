/**
 * Crepe Mod-K 链接快捷键插件
 *
 * 对当前选区打开 LinkTooltip 编辑流程（addLink / editLink）。
 * 无选区时：光标在链接内编辑整段链接，否则扩选当前词再 addLink；
 * 光标处无词可扩时 no-op。
 *
 * 注册：已在 plugins/index.ts 中接线（linkKeymap 开关，默认开启）；
 * `crepe.editor.use(linkKeymapPlugin())` 须在 crepe.create() 之前调用，
 * 且 LinkTooltip feature 须已启用。
 */

import type { Ctx } from '@milkdown/ctx';
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip';
import { keymap } from '@milkdown/prose/keymap';
import type { Command } from '@milkdown/prose/state';
import { TextSelection } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';

import { resolveLinkKeymapAction } from './resolveLinkAction';

export { findWordRangeAtCaret, resolveLinkKeymapAction } from './resolveLinkAction';
export type { LinkKeymapAction } from './resolveLinkAction';

/** 供单测：构造 Mod-k Command（不经 $prose） */
export function createModKLinkCommand(ctx: Ctx): Command {
  return (state, dispatch) => {
    const action = resolveLinkKeymapAction(state);
    if (!action) return false;

    try {
      const api = ctx.get(linkTooltipAPI.key);

      // 扩选后的范围与当前选区不同：先选中，LinkTooltip 锚定更自然
      const { from, to } = state.selection;
      if (dispatch && (action.from !== from || action.to !== to)) {
        dispatch(
          state.tr.setSelection(TextSelection.create(state.doc, action.from, action.to)),
        );
      }

      if (action.type === 'edit') {
        api.editLink(action.mark, action.from, action.to);
      } else {
        api.addLink(action.from, action.to);
      }
      return true;
    } catch {
      // LinkTooltip 未注册时静默失败，避免打断其它快捷键
      return false;
    }
  };
}

/** 供单测：裸 keymap 绑定表 */
export function createLinkKeymapBindings(ctx: Ctx) {
  return {
    'Mod-k': createModKLinkCommand(ctx),
  } as const;
}

/**
 * Milkdown 统一入口。不自行挂到 Crepe；由接线方 `editor.use(linkKeymapPlugin())`。
 */
export function linkKeymapPlugin() {
  return $prose((ctx) => keymap(createLinkKeymapBindings(ctx)));
}
