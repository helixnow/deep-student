import { useCallback, useEffect, useRef, useState } from 'react';
import { dstu } from '@/dstu';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { NotesAPI } from '@/utils/notesApi';

export const NOTE_TAGS_CHANGED_EVENT = 'notes:tags-changed';

export function notifyNoteTagsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTE_TAGS_CHANGED_EVENT));
}

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

  const onTagsChanged = useCallback(() => {
    if (!autoLoad) return;
    void refresh();
  }, [autoLoad, refresh]);

  useEventRegistry(
    autoLoad
      ? [{ target: 'window', type: NOTE_TAGS_CHANGED_EVENT, listener: onTagsChanged }]
      : [],
    [autoLoad, onTagsChanged],
  );

  // 任何入口（页头标签栏 / 属性页 / NotesContext / Agent）写回笔记元数据都会经 dstu.watch
  // 广播 note updated/created/deleted 事件；在此订阅即可实时刷新侧栏标签筛选列表。
  useEffect(() => {
    if (!autoLoad) return undefined;
    return dstu.watch('*', (event) => {
      if (event.type !== 'updated' && event.type !== 'created' && event.type !== 'deleted') return;
      if (event.node && event.node.type !== 'note') return;
      void refresh();
    });
  }, [autoLoad, refresh]);

  return { tags, loading, error, refresh };
}
