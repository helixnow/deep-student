/**
 * 代码上下文判定（B9 编辑器侧）：
 * 代码块（node.spec.code）与行内 code mark 中不触发 wikilink / mention 的
 * 补全与 InputRule，与 notes/wikilinks.ts 解析层的 fence + inline-code 跳过对齐。
 */

import type { EditorState } from '@milkdown/prose/state';

/** commonmark 预设的行内代码 mark 名（Milkdown 为 inlineCode；兼容 code 命名） */
const INLINE_CODE_MARK_NAMES = new Set(['inlineCode', 'code']);

/** 位置 pos 处（光标语义）是否落在代码块或行内 code 内。 */
export function isInCodeContext(state: EditorState, pos: number): boolean {
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  const $pos = state.doc.resolve(clamped);

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.code) return true;
  }

  const marks = $pos.marks();
  for (const mark of marks) {
    if (INLINE_CODE_MARK_NAMES.has(mark.type.name)) return true;
  }
  return false;
}

/** 当前选区（光标）是否处于代码上下文。 */
export function shouldSkipWikilinkContext(state: EditorState): boolean {
  return isInCodeContext(state, state.selection.from);
}
