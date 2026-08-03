/**
 * 会话元信息搜索 Hook —— 接线 chat_v2_search_sessions
 *
 * 命中会话标题/描述/标签（DB 侧 LIKE），用于补充 SessionBrowser
 * 标题模式下纯前端的标题子串过滤（例如命中简介或标签的会话）。
 * 防抖 + 请求代数作废模式与 useContentSearch 保持一致。
 */

import { useState, useEffect, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { searchChatSessions } from '../../api/sessionBrowserApi';
import type { ChatSession } from '../../types/session';

interface UseSessionSearchReturn {
  results: ChatSession[];
  loading: boolean;
}

export function useSessionSearch(
  query: string,
  enabled: boolean,
  debounceMs = 300
): UseSessionSearchReturn {
  const [results, setResults] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(false);

  // 请求代数：递增即可让所有 in-flight 回调作废
  const generationRef = useRef(0);

  const debouncedQuery = useDebounce(enabled ? query : '', debounceMs);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      generationRef.current++;
      setResults([]);
      setLoading(false);
      return;
    }

    const gen = ++generationRef.current;
    setLoading(true);

    searchChatSessions({ query: trimmed, limit: 100 })
      .then((data) => {
        if (generationRef.current === gen) {
          setResults(data || []);
        }
      })
      .catch((err) => {
        if (generationRef.current === gen) {
          console.error('[useSessionSearch] Search failed:', err);
          setResults([]);
        }
      })
      .finally(() => {
        if (generationRef.current === gen) {
          setLoading(false);
        }
      });
  }, [debouncedQuery]);

  return { results, loading };
}

export default useSessionSearch;
