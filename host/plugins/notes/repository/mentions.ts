// cmd/notes.rs::notes_mentions_search legacy mistake lookup. The notes half is
// orchestrated by src/mention-search.ts so each Rust step keeps its own error
// prefix; this repository only owns the `mistakes` query.
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { MentionMistakeHit } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { escapeLikePattern } from './notes.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { decodeJson } from './json.ts';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 40;

export function mistakeMentions(
  mistakes: SqlExecutor,
  keyword: string,
  subject: string | null,
  limit: number | null | undefined,
): MentionMistakeHit[] {
  const trimmed = rustTrim(keyword);
  if (trimmed.length === 0) return [];
  const bounded = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const pattern = `%${escapeLikePattern(trimmed)}%`;
  const rows = subject === null
    ? mistakes.all<MistakeRow>(
      `SELECT id, subject, user_question, mistake_summary, tags FROM mistakes
        WHERE (user_question LIKE ?1 ESCAPE '\\' OR COALESCE(mistake_summary,'') LIKE ?2 ESCAPE '\\')
        ORDER BY datetime(updated_at) DESC LIMIT ?3`, [pattern, pattern, bounded])
    : mistakes.all<MistakeRow>(
      `SELECT id, subject, user_question, mistake_summary, tags FROM mistakes
        WHERE subject = ?1
          AND (user_question LIKE ?2 ESCAPE '\\' OR COALESCE(mistake_summary,'') LIKE ?3 ESCAPE '\\')
        ORDER BY datetime(updated_at) DESC LIMIT ?4`, [subject, pattern, pattern, bounded]);
  const hits: MentionMistakeHit[] = [];
  for (const row of rows) {
    if (hits.length >= bounded) break;
    let tags: string[] = [];
    try {
      const parsed = decodeJson(row.tags);
      // Rust `serde_json::from_str::<Vec<String>>` yields [] for any non-array
      // or non-string element.
      if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) {
        tags = parsed;
      }
    } catch {
      tags = [];
    }
    hits.push({
      id: row.id, subject: row.subject, title: row.user_question,
      summary: row.mistake_summary, tags,
    });
  }
  return hits;
}

interface MistakeRow {
  id: string;
  subject: string;
  user_question: string;
  mistake_summary: string | null;
  tags: string;
}
