/**
 * 将选中的笔记插入为 link mark（标题文本 + note://id）
 */

import type { EditorState, Transaction } from '@milkdown/prose/state';

import { buildNoteHref } from './protocol';
import type { MentionNoteCandidate } from './types';

/**
 * 用笔记标题 + note:// 链接替换 `[from, to)`（通常为 `@query` 区间）。
 * 返回 null 表示 schema 无 link mark。
 */
export function applyMentionInsert(
  state: EditorState,
  from: number,
  to: number,
  note: MentionNoteCandidate,
): Transaction | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;

  const title = note.title.trim() || note.id;
  const href = buildNoteHref(note.id);
  const mark = linkType.create({ href });
  const textNode = state.schema.text(title, [mark]);
  return state.tr.replaceWith(from, to, textNode).scrollIntoView();
}
