/**
 * 内容搜索 Hook - 基于 FTS5 的对话内容全文搜索
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDebounce } from '@/hooks/useDebounce';

export interface ContentSearchResult {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;
  blockId: string;
  role: string;
  snippet: string;
  updatedAt: string;
}

interface UseContentSearchReturn {
  results: ContentSearchResult[];
  loading: boolean;
  error: string | null;
  search: (query: string) => void;
  query: string;
  clear: () => void;
}

export function useContentSearch(debounceMs = 300): UseContentSearchReturn {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedQuery = useDebounce(query, debounceMs);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed || trimmed.length < 2) {
      setResults([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    invoke<ContentSearchResult[]>('chat_v2_search_content', {
      query: trimmed,
      limit: 50,
    })
      .then((data) => {
        if (!cancelled) {
          setResults(data || []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[useContentSearch] Search failed:', err);
          setError(String(err));
          setResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const search = useCallback((q: string) => {
    setQuery(q);
  }, []);

  const clear = useCallback(() => {
    setQuery('');
    setResults([]);
    setError(null);
  }, []);

  return { results, loading, error, search, query, clear };
}

export default useContentSearch;
