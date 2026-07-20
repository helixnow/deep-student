/**
 * 笔记标题模糊匹配（对齐 NotesSearchOverlay quick-open 排序心智）
 */

import type { WikilinkNoteCandidate } from './types';

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * 匹配档位（越小越靠前）：
 * 0 完整相等 → 1 前缀 → 2 连续子串 → 3 分词命中（查询按空白切词，
 * 每个词都是标题子串，如 `线代 笔记` 命中「线性代数学习笔记」）→ 4 空查询。
 */
function rankTitle(title: string, query: string, tokens: readonly string[]): number | null {
  if (!query) return 4;
  const name = normalized(title);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (tokens.length > 1 && tokens.every((token) => name.includes(token))) return 3;
  return null;
}

export function fuzzyMatchNotes(
  notes: readonly WikilinkNoteCandidate[],
  query: string,
  maxResults: number,
): WikilinkNoteCandidate[] {
  const normalizedQuery = normalized(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const ranked: Array<{ note: WikilinkNoteCandidate; rank: number }> = [];
  const seen = new Set<string>();

  for (const note of notes) {
    if (!note?.id || typeof note.title !== 'string') continue;
    if (seen.has(note.id)) continue;
    const rank = rankTitle(note.title, normalizedQuery, tokens);
    if (rank === null) continue;
    seen.add(note.id);
    ranked.push({ note, rank });
  }

  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank
        // 同档命中按最近编辑优先（对齐 Obsidian quick-open 心智；无时间戳的排后）
        || (b.note.updatedAt ?? 0) - (a.note.updatedAt ?? 0)
        || a.note.title.localeCompare(b.note.title, undefined, { sensitivity: 'base' }),
    )
    .slice(0, Math.max(0, maxResults))
    .map(({ note }) => note);
}
