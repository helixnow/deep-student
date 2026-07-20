import { normalizeWikiLinkHeading, wikiLinkHeadingsEqual } from './wikilinks';

export interface NotesHeadingTarget {
  noteId: string;
  heading: string;
}

/**
 * 编辑器侧滚动定位时用它比较文档标题与 pending 锚点，
 * 与 `[[Note#Heading]]` 补全 / 解析共用同一套规范化（大小写、全半角、
 * 中文标点、空白折叠），避免「补全能选到、点击跳不过去」的锚点漂移。
 */
export function notesHeadingTargetMatches(documentHeading: string, target: string): boolean {
  return wikiLinkHeadingsEqual(documentHeading, target);
}

export { normalizeWikiLinkHeading };

export const NOTES_HEADING_TARGET_EVENT = 'notes:heading-target';

const pendingByNoteId = new Map<string, string>();

/** Retain heading navigation across opening a note whose editor is not mounted yet. */
export function publishNotesHeadingTarget(request: NotesHeadingTarget): void {
  const heading = request.heading.trim();
  if (!request.noteId || !heading) return;
  pendingByNoteId.set(request.noteId, heading);
  window.dispatchEvent(new CustomEvent<NotesHeadingTarget>(NOTES_HEADING_TARGET_EVENT, {
    detail: { noteId: request.noteId, heading },
  }));
}

export function consumeNotesHeadingTarget(noteId: string | null | undefined): string | null {
  if (!noteId) return null;
  const heading = pendingByNoteId.get(noteId) ?? null;
  if (heading !== null) pendingByNoteId.delete(noteId);
  return heading;
}

export function clearPendingNotesHeadingTargetsForTests(): void {
  pendingByNoteId.clear();
}
