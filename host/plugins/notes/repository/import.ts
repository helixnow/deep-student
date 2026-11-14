// cmd/notes.rs::notes_import_markdown* - local Markdown files to VFS notes.
import type { DstuNode } from '../../../../contracts/ipc/generated/_shared.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { NoteFileSystemError } from './errors.ts';
import { noteRepository } from './notes.ts';
import { noteToDstuNode } from '../src/dstu-node.ts';
import {
  decodeMarkdownBytes, deriveMarkdownNoteTitle, extractFirstHeading, isGenericNoteTitle,
  splitLeadingHeading,
} from '../src/import-markdown.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { notesLocalRuntime } from '../src/local-runtime.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeFolderId(folderId: string | null | undefined): string | null {
  const trimmed = folderId == null ? '' : rustTrim(folderId);
  return trimmed.length === 0 ? null : trimmed;
}

function importTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** cmd/notes.rs:177-222 import_markdown_note_from_local_path. */
export function importMarkdownNote(
  conn: SqlExecutor,
  filePath: string,
  titleHint: string,
  folderId: string | null,
): DstuNode {
  let bytes: Uint8Array;
  try {
    bytes = notesLocalRuntime().readBytes(filePath);
  } catch (error) {
    throw new NoteFileSystemError(`读取 Markdown 文件失败: ${message(error)}`);
  }
  let content: string;
  try {
    [content] = decodeMarkdownBytes(bytes);
  } catch (error) {
    throw new NoteFileSystemError(`读取 Markdown 文件失败: ${message(error)}`);
  }

  let body = content;
  let leadingTitle: string | null = null;
  const split = splitLeadingHeading(content);
  if (split !== null) {
    leadingTitle = split[0];
    body = split[1];
  }

  const effectiveTitle = leadingTitle !== null
    ? leadingTitle
    : isGenericNoteTitle(titleHint)
      ? extractFirstHeading(body) ?? `导入笔记_${importTimestamp()}`
      : titleHint;

  const note = noteRepository.createNoteInFolder({
    title: effectiveTitle, content: body, tags: [],
  }, folderId, conn);
  return noteToDstuNode(note);
}

export function markdownTitleFromPath(filePath: string): string {
  return deriveMarkdownNoteTitle(filePath);
}
