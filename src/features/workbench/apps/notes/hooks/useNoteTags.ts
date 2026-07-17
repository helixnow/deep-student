import { useCallback, useEffect, useRef, useState } from 'react';
import { NotesAPI } from '@/utils/notesApi';

export interface NoteTagItem {
  name: string;
  /** Present only when the tags API (or a future enricher) supplies frequency. */
  count?: number;
}

export interface UseNoteTagsResult {
  tags: NoteTagItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function isUserVisibleNoteTag(name: string): boolean {
  const normalized = name.trim();
  return normalized.length > 0
    && !normalized.startsWith('_')
    && normalized.toLocaleLowerCase() !== 'daily_log';
}

/**
 * Load the workspace-wide note tag list via `notes_list_tags`.
 * The current backend returns sorted names only (no counts); `count` stays undefined.
 */
export function useNoteTags(autoLoad = true): UseNoteTagsResult {
  const [tags, setTags] = useState<NoteTagItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await NotesAPI.listTags();
      if (sequence !== sequenceRef.current) return;
      setTags(
        (Array.isArray(list) ? list : [])
          .filter((name): name is string => typeof name === 'string' && isUserVisibleNoteTag(name))
          .map((name) => ({ name: name.trim() })),
      );
    } catch (err) {
      if (sequence !== sequenceRef.current) return;
      const message = err instanceof Error && err.message.trim()
        ? err.message
        : 'Failed to load tags';
      setError(message);
      setTags([]);
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return undefined;
    void refresh();
    return () => {
      sequenceRef.current += 1;
    };
  }, [autoLoad, refresh]);

  return { tags, loading, error, refresh };
}
