/**
 * 点击 note:// 链接 → DSTU_OPEN_NOTE
 */

import type { EditorView } from '@milkdown/prose/view';

import { parseNoteHref, parseNoteHrefHeading } from './protocol';
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

  const href = anchor.getAttribute('href');
  const noteId = parseNoteHref(href);
  if (!noteId) return false;

  event.preventDefault();
  event.stopPropagation();
  // note://id#heading 的 hash 段透传为 heading，供 heading 跳转桥消费
  dispatchOpenMentionNote(noteId, parseNoteHrefHeading(href) ?? undefined);
  return true;
}
