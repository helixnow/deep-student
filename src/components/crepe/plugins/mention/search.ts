/**
 * 默认搜索实现：DSTU notesDstuAdapter.searchNotes
 *
 * 说明：NotesAPI.mentionsSearch 仅返回 irec_cards，不适合作笔记 @ 提及数据源。
 */

import type { MentionNoteCandidate } from './types';

const DEFAULT_LIMIT = 20;

/**
 * 默认 searchNotes：经 DSTU 搜索 type=note 节点，映射为 { id, title }[]。
 * 失败时返回空数组（不抛错，避免打断编辑）。
 */
export async function defaultSearchNotes(
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<MentionNoteCandidate[]> {
  try {
    const { notesDstuAdapter } = await import('@/dstu/adapters/notesDstuAdapter');
    const result = await notesDstuAdapter.searchNotes(query, limit);
    if (!result.ok) return [];
    return result.value
      .filter((node) => node.type === 'note' || !node.type)
      .map((node) => ({
        id: node.id,
        title: (node.name || node.id).trim() || node.id,
      }));
  } catch {
    return [];
  }
}

export function sliceSuggestions(
  notes: readonly MentionNoteCandidate[],
  max: number,
): MentionNoteCandidate[] {
  if (max <= 0) return [];
  return notes.slice(0, max);
}
