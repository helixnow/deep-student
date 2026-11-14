// notes_manager.rs Canvas commands: read / append / replace / set.
// Section rules live in ./markdown.ts; only wiring stays in index.ts.
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type {
  NativeRegex, NativeRegexPattern, RegexMatch,
} from '../../../platform/native/regex/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsNote } from '../api.ts';
import { noteUpdateStorage, noteManagerStorage } from '../repository/errors.ts';
import { noteRepository } from '../repository/notes.ts';
import { appendToSection, extractSectionContent } from './markdown.ts';
import { rustTrim, rustTrimEnd } from '../../../platform/util/index.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNote(conn: SqlExecutor, noteId: string): [VfsNote, string] {
  return noteManagerStorage(() => {
    const found = noteRepository.getNoteWithContent(noteId, conn);
    if (found === null) throw new CommandError(AppError.not_found('笔记不存在或已被删除'));
    return found;
  }, 'VFS 读取笔记失败');
}

export function canvasRead(conn: SqlExecutor, noteId: string, section: string | null | undefined): string {
  const [, content] = readNote(conn, noteId);
  if (section !== null && section !== undefined && rustTrim(section).length > 0) {
    const extracted = extractSectionContent(content, section);
    if (extracted === null) {
      throw new CommandError(AppError.not_found(`章节 '${section}' 未找到`));
    }
    return extracted;
  }
  return content;
}

export function canvasAppend(
  conn: SqlExecutor,
  noteId: string,
  content: string,
  section: string | null | undefined,
): null {
  const [, current] = readNote(conn, noteId);
  let next: string;
  if (section !== null && section !== undefined && rustTrim(section).length > 0) {
    const appended = appendToSection(current, section, content);
    if (appended === null) throw new CommandError(AppError.not_found(`章节 '${section}' 未找到`));
    next = appended;
  } else {
    next = rustTrim(current).length === 0 ? content : `${rustTrimEnd(current)}\n\n${content}`;
  }
  noteUpdateStorage(() => noteRepository.updateNote(noteId, { content: next }, conn));
  return null;
}

/**
 * Content replacement shared by the command path. `isRegex` goes through F7
 * `nativeRegex` (the `regex` crate wasm engine): JS `RegExp` is a different
 * dialect and a different replacement syntax, so it is never used here.
 */
export type CanvasNativeRegex = Pick<NativeRegex, 'compile' | 'findIter' | 'replaceAll'>;

export async function replaceContent(
  content: string,
  search: string,
  replace: string,
  isRegex: boolean,
  nativeRegex?: CanvasNativeRegex,
): Promise<{ next: string; count: number }> {
  if (search.length === 0) throw new CommandError(AppError.validation('搜索内容不能为空'));
  if (!isRegex) {
    const count = content.split(search).length - 1;
    return { next: content.split(search).join(replace), count };
  }
  if (nativeRegex === undefined) {
    throw new CommandError(AppError.internal('正则引擎不可用（Context.nativeRegex）'));
  }
  let pattern: NativeRegexPattern;
  try {
    pattern = await nativeRegex.compile(search);
  } catch (error) {
    // notes_manager.rs: AppError::validation(format!("无效的正则表达式: {}", e))
    // where `e` is `regex::Error` Display; the engine keeps that text verbatim.
    throw new CommandError(AppError.validation(`无效的正则表达式: ${errorMessage(error)}`));
  }
  try {
    const matches: RegexMatch[] = await nativeRegex.findIter(pattern, content);
    const next = await nativeRegex.replaceAll(pattern, content, replace);
    return { next, count: matches.length };
  } catch (error) {
    throw new CommandError(AppError.internal(`正则替换执行失败: ${errorMessage(error)}`));
  }
}

export async function canvasReplace(
  conn: SqlExecutor,
  noteId: string,
  search: string,
  replace: string,
  isRegex: boolean,
  nativeRegex?: CanvasNativeRegex,
): Promise<number> {
  if (search.length === 0) throw new CommandError(AppError.validation('搜索内容不能为空'));
  const [, content] = readNote(conn, noteId);
  const { next, count } = await replaceContent(content, search, replace, isRegex, nativeRegex);
  if (count > 0) {
    noteUpdateStorage(() => noteRepository.updateNote(noteId, { content: next }, conn));
  }
  return count;
}

export function canvasSet(conn: SqlExecutor, noteId: string, content: string): null {
  readNote(conn, noteId);
  noteUpdateStorage(() => noteRepository.updateNote(noteId, { content }, conn));
  return null;
}
