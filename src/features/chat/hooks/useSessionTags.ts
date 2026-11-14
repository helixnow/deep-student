/**
 * 会话标签管理 Hook
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface TagInfo {
  tag: string;
  count: number;
}

interface UseSessionTagsReturn {
  /** 所有标签（去重 + 使用次数） */
  allTags: TagInfo[];
  /** 按 sessionId 索引的标签 map */
  tagsBySession: Map<string, string[]>;
  /** 正在加载 */
  loading: boolean;
  /** 加载所有标签 */
  loadAllTags: () => Promise<void>;
  /** 批量加载会话标签 */
  loadTagsForSessions: (sessionIds: string[]) => Promise<void>;
  /** 添加手动标签 */
  addTag: (sessionId: string, tag: string) => Promise<void>;
  /** 删除标签 */
  removeTag: (sessionId: string, tag: string) => Promise<void>;
  /** 当前选中的过滤标签 */
  selectedFilterTags: Set<string>;
  /** 切换过滤标签 */
  toggleFilterTag: (tag: string) => void;
  /** 清除所有过滤 */
  clearFilter: () => void;
}

export function useSessionTags(): UseSessionTagsReturn {
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [tagsBySession, setTagsBySession] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [selectedFilterTags, setSelectedFilterTags] = useState<Set<string>>(new Set());
  // 同步镜像：会话列表每次变化（新建/删除/改序）都会重跑 loadTagsForSessions，
  // 已取过的会话不应再走一次 IPC——公网 RTT 150–250ms 下这是纯等待。
  // 标签只经本 hook 的 addTag/removeTag 改动，镜像同时在这些函数里更新。
  const tagsBySessionRef = useRef<Map<string, string[]>>(tagsBySession);
  const applyTagsBySession = useCallback((updater: (prev: Map<string, string[]>) => Map<string, string[]>) => {
    setTagsBySession((prev) => {
      const next = updater(prev);
      tagsBySessionRef.current = next;
      return next;
    });
  }, []);

  const loadAllTags = useCallback(async () => {
    try {
      const data = await invoke<[string, number][]>('chat_v2_list_all_tags');
      setAllTags((data || []).map(([tag, count]) => ({ tag, count })));
    } catch (err) {
      console.error('[useSessionTags] Failed to load all tags:', err);
    }
  }, []);

  const loadTagsForSessions = useCallback(async (sessionIds: string[]) => {
    const known = tagsBySessionRef.current;
    const missing = sessionIds.filter((id) => !known.has(id));
    if (missing.length === 0) return;
    try {
      setLoading(true);
      const data = await invoke<Record<string, string[]>>('chat_v2_get_tags_batch', {
        sessionIds: missing,
      });
      applyTagsBySession((prev) => {
        const next = new Map(prev);
        for (const [sid, tags] of Object.entries(data || {})) {
          next.set(sid, tags);
        }
        // 后端未返回的会话按「无标签」落位，避免每次列表变化都重问一遍
        for (const sid of missing) {
          if (!next.has(sid)) next.set(sid, []);
        }
        return next;
      });
    } catch (err) {
      console.error('[useSessionTags] Failed to load tags batch:', err);
    } finally {
      setLoading(false);
    }
  }, [applyTagsBySession]);

  const addTag = useCallback(async (sessionId: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    try {
      await invoke('chat_v2_add_tag', { sessionId, tag: trimmed });
      applyTagsBySession((prev) => {
        const next = new Map(prev);
        const existing = next.get(sessionId) || [];
        if (!existing.includes(trimmed)) {
          next.set(sessionId, [...existing, trimmed]);
        }
        return next;
      });
      void loadAllTags();
    } catch (err) {
      console.error('[useSessionTags] Failed to add tag:', err);
    }
  }, [applyTagsBySession, loadAllTags]);

  const removeTag = useCallback(async (sessionId: string, tag: string) => {
    try {
      await invoke('chat_v2_remove_tag', { sessionId, tag });
      applyTagsBySession((prev) => {
        const next = new Map(prev);
        const existing = next.get(sessionId) || [];
        next.set(sessionId, existing.filter((t) => t !== tag));
        return next;
      });
      void loadAllTags();
    } catch (err) {
      console.error('[useSessionTags] Failed to remove tag:', err);
    }
  }, [applyTagsBySession, loadAllTags]);

  const toggleFilterTag = useCallback((tag: string) => {
    setSelectedFilterTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  const clearFilter = useCallback(() => {
    setSelectedFilterTags(new Set());
  }, []);

  useEffect(() => {
    void loadAllTags();
  }, [loadAllTags]);

  return {
    allTags,
    tagsBySession,
    loading,
    loadAllTags,
    loadTagsForSessions,
    addTag,
    removeTag,
    selectedFilterTags,
    toggleFilterTag,
    clearFilter,
  };
}

export default useSessionTags;
