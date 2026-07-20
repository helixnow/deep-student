/**
 * 将单个 URL 以 Notion 风格应用到当前选区（单事务，undo 友好）。
 */

import type { ResolvedPos } from '@milkdown/prose/model';
import type { EditorState, Transaction } from '@milkdown/prose/state';

import { normalizePasteHref } from './isSinglePasteUrl';

const TABLE_CELL_NAMES = new Set(['table_cell', 'table_header']);
const CODE_MARK_NAMES = new Set(['code', 'inlineCode', 'code_inline']);

function isInsideCodeOrTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.spec.code) return true;
    if (TABLE_CELL_NAMES.has(node.type.name)) return true;
  }
  return false;
}

function hasCodeMarkInSelection(state: EditorState): boolean {
  const { empty, from, to, $from } = state.selection;
  const isCode = (marks: readonly { type: { name: string } }[]) =>
    marks.some((mark) => CODE_MARK_NAMES.has(mark.type.name));

  if (empty) {
    return isCode(state.storedMarks ?? $from.marks());
  }

  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isText && isCode(node.marks)) found = true;
  });
  return found;
}

/** 代码块 / 行内代码 / 表格单元格内不接管，交还默认粘贴。 */
export function shouldSkipPasteLinkContext(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  if (isInsideCodeOrTable($from)) return true;
  if (!state.selection.empty && isInsideCodeOrTable($to)) return true;
  return hasCodeMarkInSelection(state);
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
