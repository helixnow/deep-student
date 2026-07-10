/**
 * 内容搜索 Hook - 基于 FTS5 的对话内容全文搜索
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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

  // 请求代数：递增即可让所有 in-flight 回调作废（effect cleanup 与 clear() 共用）
  const generationRef = useRef(0);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed || trimmed.length < 2) {
      generationRef.current++;
      setResults([]);
      setError(null);
      // 查询被清空/缩短时，之前 in-flight 请求的 finally 不会再执行 setLoading(false)
      setLoading(false);
      return;
    }

    const gen = ++generationRef.current;
    setLoading(true);
    setError(null);

    invoke<ContentSearchResult[]>('chat_v2_search_content', {
      query: trimmed,
      limit: 50,
    })
      .then((data) => {
        if (generationRef.current === gen) {
          setResults(data || []);
        }
      })
      .catch((err) => {
        if (generationRef.current === gen) {
          console.error('[useContentSearch] Search failed:', err);
          setError(String(err));
          setResults([]);
        }
      })
      .finally(() => {
        if (generationRef.current === gen) {
          setLoading(false);
        }
      });

    // 无需 cleanup：每次 effect 重跑（或 clear()）都会先递增 generation，
    // 旧请求的回调经 gen 比对自动作废，天然防乱序覆盖
  }, [debouncedQuery]);

  const search = useCallback((q: string) => {
    setQuery(q);
  }, []);

  const clear = useCallback(() => {
    // 立即作废 in-flight 请求，避免 debounce 窗口期内旧结果回填
    generationRef.current++;
    setQuery('');
    setResults([]);
    setError(null);
    setLoading(false);
  }, []);

  return { results, loading, error, search, query, clear };
}

export default useContentSearch;
