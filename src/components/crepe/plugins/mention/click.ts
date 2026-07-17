/**
 * 点击 note:// 链接 → DSTU_OPEN_NOTE
 */

import type { EditorView } from '@milkdown/prose/view';

import { parseNoteHref } from './protocol';
import { dispatchOpenMentionNote } from './types';

/**
 * 从 click 目标解析 note:// 链接。可单测。
 * 若命中则 preventDefault 并派发打开事件，返回 true。
 */
export function handleMentionLinkClick(
  view: EditorView,
  event: MouseEvent,
): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (!view.dom.contains(anchor)) return false;

  const noteId = parseNoteHref(anchor.getAttribute('href'));
  if (!noteId) return false;

  event.preventDefault();
  event.stopPropagation();
  dispatchOpenMentionNote(noteId);
  return true;
}
