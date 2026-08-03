/**
 * 默认 wikilink 补全数据源：DSTU notesDstuAdapter.listNotes
 *
 * 与 mention 的 defaultSearchNotes 同源适配器；list 全量供本地 fuzzy。
 * 失败返回 []，不抛错。
 */

import type { WikilinkNoteCandidate } from './types';

export async function defaultWikilinkGetNotes(): Promise<WikilinkNoteCandidate[]> {
  try {
    const { notesDstuAdapter } = await import('@/dstu/adapters/notesDstuAdapter');
    const result = await notesDstuAdapter.listNotes();
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
