/**
 * 宿主侧 wikilink 同步笔记索引（供 CrepeEditor plugins.wikilink 注入）。
 * resolve 必须同步，故维护内存缓存；create / 显式 refresh 时更新。
 */

import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import {
  createWikiLinkIndex,
  type WikiLinkIndex,
  type WikiLinkNoteReference,
} from '@/features/notes/wikilinks';

let cache: WikiLinkNoteReference[] = [];
let refreshPromise: Promise<void> | null = null;

/**
 * 已构建的解析索引；随 cache 变更失效。
 * resolve 在 NodeView 渲染时对每个 wikilink 同步调用，
 * 惰性缓存索引避免每次都重建整表（listNotes 上限 2000）。
 */
let index: WikiLinkIndex | null = null;

function invalidateIndex(): void {
  index = null;
}

function getIndex(): WikiLinkIndex {
  if (!index) {
    index = createWikiLinkIndex(cache);
  }
  return index;
}

export function getWikilinkNotesCache(): readonly WikiLinkNoteReference[] {
  return cache;
}

export function upsertWikilinkNoteCache(note: WikiLinkNoteReference): void {
  const id = note.id;
  const title = note.title;
  if (!id) return;
  const idx = cache.findIndex((n) => n.id === id);
  if (idx >= 0) {
    cache = [...cache.slice(0, idx), { id, title }, ...cache.slice(idx + 1)];
  } else {
    cache = [...cache, { id, title }];
  }
  invalidateIndex();
}

export async function refreshWikilinkNotesCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const result = await notesDstuAdapter.listNotes({ limit: 2000 });
      if (!result.ok) return;
      cache = result.value.map((node) => ({
        id: node.id,
        title: node.name || node.id,
      }));
      invalidateIndex();
    } catch (error: unknown) {
      console.warn('[wikilinkNotesCache] refresh failed:', error);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function resolveWikilinkTarget(target: string): {
  resolved: boolean;
  noteId: string | null;
} {
  const r = getIndex().resolve(target);
  return { resolved: Boolean(r.noteId), noteId: r.noteId };
}

/** Crepe plugins.wikilink 最小配置 */
export function buildWikilinkPluginHostConfig() {
  return {
    getNotes: () => getWikilinkNotesCache(),
    resolve: (target: string) => resolveWikilinkTarget(target),
  };
}
