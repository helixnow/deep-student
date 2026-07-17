/**
 * note:// 内部协议（与 NotesHeader 复制链接一致）
 */

import { NOTE_HREF_PROTOCOL } from './types';

/** 构造提及链接 href */
export function buildNoteHref(noteId: string): string {
  return `${NOTE_HREF_PROTOCOL}${noteId}`;
}

/**
 * 从 href 解析 noteId。
 * 支持 `note://id`、`note://id?x=1`、`note://id#hash`。
 */
export function parseNoteHref(href: string | null | undefined): string | null {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith(NOTE_HREF_PROTOCOL)) return null;
  const rest = trimmed.slice(NOTE_HREF_PROTOCOL.length);
  const id = rest.split(/[?#]/)[0]?.trim() ?? '';
  return id || null;
}
