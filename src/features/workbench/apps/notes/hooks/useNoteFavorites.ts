import { useCallback, useRef, useState } from 'react';
import { dstu, type DstuNode } from '@/dstu';

export type NoteFavoriteResourceType = 'note' | 'mindmap';

export interface NoteFavoriteItem {
  id: string;
  name: string;
  type: NoteFavoriteResourceType;
  path: string;
  updatedAt: number;
}

export interface UseNoteFavoritesResult {
  items: NoteFavoriteItem[];
  loading: boolean;
  error: string | null;
  /** Reload favorites from DSTU (`isFavorite: true`, then keep note/mindmap). */
  refresh: () => Promise<void>;
  /**
   * Toggle favorite for `id`/`type`.
   * Optimistically updates local list; rolls back on API failure.
   * Returns the next favorite state, or `null` when the call failed.
   */
  toggle: (id: string, type: NoteFavoriteResourceType) => Promise<boolean | null>;
  /** Explicit set (also optimistic). */
  setFavorite: (
    id: string,
    type: NoteFavoriteResourceType,
    isFavorite: boolean,
    opts?: { path?: string; name?: string },
  ) => Promise<boolean>;
}

const FAVORITE_TYPES = new Set<NoteFavoriteResourceType>(['note', 'mindmap']);

/**
 * Performance note:
 * `dstu.list('/', { isFavorite: true })` is supported by the backend, but the
 * favorite-only branch loads **all** resource kinds then filters server-side.
 * This hook further keeps only note/mindmap. For very large libraries the
 * list may be heavier than a type-scoped query; prefer this path until DSTU
 * exposes a typed favorite filter.
 */
function isFavoriteResourceType(value: unknown): value is NoteFavoriteResourceType {
  return value === 'note' || value === 'mindmap';
}

function looksLikeNoteId(value: string): boolean {
  return /^note_[A-Za-z0-9]+$/.test(value.trim());
}

function nodeToFavorite(node: DstuNode): NoteFavoriteItem | null {
  if (!isFavoriteResourceType(node.type)) return null;
  const metaTitle = typeof node.metadata?.title === 'string' ? node.metadata.title.trim() : '';
  const rawName = (node.name || '').trim();
  const name = metaTitle
    || (rawName && !looksLikeNoteId(rawName) ? rawName : '')
    || rawName
    || node.id;
  return {
    id: node.id,
    name,
    type: node.type,
    path: node.path || `/${node.id}`,
    updatedAt: node.updatedAt,
  };
}

function favoritePath(id: string, path?: string): string {
  if (path && path.trim()) return path;
  return `/${id}`;
}

function sortFavorites(items: NoteFavoriteItem[]): NoteFavoriteItem[] {
  return items.slice().sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/**
 * Favorites list + optimistic toggle for Notes workspace (note + mindmap).
 * Stateless relative to the workspace app — hosts own refresh timing.
 */
export function useNoteFavorites(): UseNoteFavoritesResult {
  const [items, setItems] = useState<NoteFavoriteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await dstu.list('/', { isFavorite: true });
    if (!result.ok) {
      setError(result.error.toUserMessage());
      setLoading(false);
      return;
    }
    const next = sortFavorites(
      result.value
        .filter((node) => FAVORITE_TYPES.has(node.type as NoteFavoriteResourceType))
        .map(nodeToFavorite)
        .filter((item): item is NoteFavoriteItem => Boolean(item)),
    );
    setItems(next);
    setLoading(false);
  }, []);

  const setFavorite = useCallback(async (
    id: string,
    type: NoteFavoriteResourceType,
    isFavorite: boolean,
    opts?: { path?: string; name?: string },
  ): Promise<boolean> => {
    const previous = itemsRef.current;
    const existing = previous.find((item) => item.id === id && item.type === type);
    const path = favoritePath(id, opts?.path ?? existing?.path);

    // Optimistic local list update
    if (isFavorite) {
      const optimistic: NoteFavoriteItem = existing
        ? { ...existing, updatedAt: Date.now() }
        : {
          id,
          name: opts?.name ?? existing?.name ?? id,
          type,
          path,
          updatedAt: Date.now(),
        };
      setItems(sortFavorites([
        ...previous.filter((item) => !(item.id === id && item.type === type)),
        optimistic,
      ]));
    } else {
      setItems(previous.filter((item) => !(item.id === id && item.type === type)));
    }
    setError(null);

    const result = await dstu.setFavorite(path, isFavorite);
    if (!result.ok) {
      setItems(previous);
      setError(result.error.toUserMessage());
      return false;
    }
    // Refresh so the quick-access row shows the DSTU display title, not the
    // optimistic id fallback used when callers omit opts.name.
    if (isFavorite) {
      void (async () => {
        const listed = await dstu.list('/', { isFavorite: true });
        if (!listed.ok) return;
        const next = sortFavorites(
          listed.value
            .filter((node) => FAVORITE_TYPES.has(node.type as NoteFavoriteResourceType))
            .map(nodeToFavorite)
            .filter((item): item is NoteFavoriteItem => Boolean(item)),
        );
        setItems(next);
      })();
    }
    return true;
  }, []);

  const toggle = useCallback(async (
    id: string,
    type: NoteFavoriteResourceType,
  ): Promise<boolean | null> => {
    const currentlyFavorite = itemsRef.current.some(
      (item) => item.id === id && item.type === type,
    );
    const next = !currentlyFavorite;
    const ok = await setFavorite(id, type, next);
    return ok ? next : null;
  }, [setFavorite]);

  return { items, loading, error, refresh, toggle, setFavorite };
}

export default useNoteFavorites;
