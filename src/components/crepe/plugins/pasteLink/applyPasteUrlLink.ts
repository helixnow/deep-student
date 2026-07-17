/**
 * 将单个 URL 以 Notion 风格应用到当前选区（单事务，undo 友好）。
 */

import type { EditorState, Transaction } from '@milkdown/prose/state';

import { normalizePasteHref } from './isSinglePasteUrl';

const TABLE_CELL_NAMES = new Set(['table_cell', 'table_header']);

/** 代码块 / 表格单元格内不接管，交还默认粘贴。 */
export function shouldSkipPasteLinkContext(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.spec.code) return true;
    if (TABLE_CELL_NAMES.has(node.type.name)) return true;
  }
  return false;
}

/**
 * 有文字选区：给选区加 link mark（不替换文字）。
 * 无选区：插入以 URL 自身为文本的链接节点。
 * 返回 null 表示无法应用（缺 link mark 等）。
 */
export function applyPasteUrlLink(state: EditorState, rawUrl: string): Transaction | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;

  const href = normalizePasteHref(rawUrl);
  const { from, to, empty } = state.selection;
  const mark = linkType.create({ href });

  if (!empty) {
    return state.tr.addMark(from, to, mark).scrollIntoView();
  }

  const textNode = state.schema.text(rawUrl, [mark]);
  return state.tr.replaceSelectionWith(textNode, false).scrollIntoView();
}
