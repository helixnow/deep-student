/**
 * 笔记标题模糊匹配（对齐 NotesSearchOverlay quick-open 排序心智）
 */

import type { WikilinkNoteCandidate } from './types';

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function rankTitle(title: string, query: string): number | null {
  if (!query) return 4;
  const name = normalized(title);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return null;
}

export function fuzzyMatchNotes(
  notes: readonly WikilinkNoteCandidate[],
  query: string,
  maxResults: number,
): WikilinkNoteCandidate[] {
  const normalizedQuery = normalized(query);
  const ranked: Array<{ note: WikilinkNoteCandidate; rank: number }> = [];
  const seen = new Set<string>();

  for (const note of notes) {
    if (!note?.id || typeof note.title !== 'string') continue;
    if (seen.has(note.id)) continue;
    const rank = rankTitle(note.title, normalizedQuery);
    if (rank === null) continue;
    seen.add(note.id);
    ranked.push({ note, rank });
  }

  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank || a.note.title.localeCompare(b.note.title, undefined, { sensitivity: 'base' }),
    )
    .slice(0, Math.max(0, maxResults))
    .map(({ note }) => note);
}
