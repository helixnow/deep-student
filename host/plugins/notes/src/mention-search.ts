// cmd/notes.rs::notes_mentions_search. Each Rust step carries its own database
// error prefix; notes hits dedupe title hits before body hits.
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { noteRepository } from '../repository/notes.ts';
import { mistakeMentions } from '../repository/mentions.ts';
import { errorMessage } from './command-utils.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export function mentionSearch(
  vfs: SqlExecutor,
  mistakes: SqlExecutor,
  keyword: string,
  subject: string | null,
  limit: number | null | undefined,
): Commands['notes_mentions_search']['result'] {
  let notes;
  try {
    notes = noteRepository.searchNoteTitles(rustTrim(keyword), Math.min(Math.max(limit ?? 8, 1), 40), vfs);
  } catch (error) {
    throw new CommandError(AppError.database(`笔记标题检索失败: ${errorMessage(error)}`));
  }
  const seen = new Set(notes.map((note) => note.id));
  const response: Commands['notes_mentions_search']['result'] = {
    notes: notes.map((note) => ({ id: note.id, title: note.title, snippet: null, tags: note.tags })),
    mistakes: [],
    irec_cards: [],
  };
  const bounded = Math.min(Math.max(limit ?? 8, 1), 40);
  if (response.notes.length < bounded) {
    const remaining = bounded - response.notes.length;
    let bodyHits;
    try {
      bodyHits = noteRepository.searchNotesWithSnippets(rustTrim(keyword), Math.min(remaining * 2, 80), vfs);
    } catch (error) {
      throw new CommandError(AppError.database(`笔记全文检索失败: ${errorMessage(error)}`));
    }
    for (const [note, snippet] of bodyHits) {
      if (response.notes.length >= bounded) break;
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      response.notes.push({ id: note.id, title: note.title, snippet, tags: note.tags });
    }
  }
  try {
    response.mistakes = mistakeMentions(mistakes, keyword, subject, limit);
  } catch (error) {
    throw new CommandError(AppError.database(`执行错题检索失败: ${errorMessage(error)}`));
  }
  return response;
}
