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

/**
 * 从 `note://id#heading` 的 hash 段解析笔记内标题（B10 联动）。
 * 无 hash 或空 hash 返回 null；百分号编码尽力解码，失败回退原文。
 */
export function parseNoteHrefHeading(href: string | null | undefined): string | null {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith(NOTE_HREF_PROTOCOL)) return null;
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0) return null;
  const fragment = trimmed.slice(hashIndex + 1).trim();
  if (!fragment) return null;
  try {
    return decodeURIComponent(fragment).trim() || null;
  } catch {
    return fragment;
  }
}
