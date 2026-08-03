/**
 * 标签自动补全共享逻辑：加载既有标签、按输入过滤、维护键盘高亮索引。
 *
 * 供 NotesEditorHeader 内联标签行与其他标签输入场景复用；
 * UI（浮层/列表）由调用方渲染，本 hook 只管数据与键盘态。
 */

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { NotesAPI } from '@/utils/notesApi';

export interface UseTagSuggestionsOptions {
  /** 已挂在笔记上的标签（大小写不敏感地从建议中排除） */
  currentTags: readonly string[];
  /** 是否激活（输入框可见/聚焦时才加载） */
  enabled: boolean;
  /** 输入过滤词 */
  query: string;
  /** 最多展示条数（默认 8） */
  limit?: number;
}

export interface UseTagSuggestionsResult {
  /** 过滤后的建议列表 */
  suggestions: string[];
  isLoading: boolean;
  /** 键盘高亮索引；-1 表示未进入列表（Enter 直接提交输入值） */
  highlightIndex: number;
  setHighlightIndex: Dispatch<SetStateAction<number>>;
  /** ArrowDown/ArrowUp 循环移动高亮；返回是否消费了按键 */
  moveHighlight: (direction: 1 | -1) => boolean;
  /** 当前高亮的建议（无则 null） */
  highlighted: string | null;
}

export function useTagSuggestions({
  currentTags,
  enabled,
  query,
  limit = 8,
}: UseTagSuggestionsOptions): UseTagSuggestionsResult {
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  useEffect(() => {
    if (!enabled) {
      setHighlightIndex(-1);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    NotesAPI.listTags()
      .then((tags) => {
        if (!cancelled) setAvailableTags(tags);
      })
      .catch((error: unknown) => {
        // 建议加载失败不阻断手动输入；静默降级
        console.warn('[useTagSuggestions] Failed to load tags:', error);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const suggestions = useMemo(() => {
    if (!enabled) return [];
    const lowerCurrent = new Set(currentTags.map((tag) => tag.toLowerCase()));
    const q = query.trim().toLowerCase();
    return availableTags
      .filter((tag) => !lowerCurrent.has(tag.toLowerCase()))
      .filter((tag) => !q || tag.toLowerCase().includes(q))
      .slice(0, limit);
  }, [availableTags, currentTags, enabled, query, limit]);

  // 建议集合收缩后收敛高亮索引
  useEffect(() => {
    setHighlightIndex((prev) => (prev >= suggestions.length ? -1 : prev));
  }, [suggestions.length]);

  const moveHighlight = useCallback((direction: 1 | -1): boolean => {
    if (suggestions.length === 0) return false;
    setHighlightIndex((prev) => {
      if (direction === 1) return (prev + 1) % suggestions.length;
      return prev <= 0 ? suggestions.length - 1 : prev - 1;
    });
    return true;
  }, [suggestions.length]);

  const highlighted =
    highlightIndex >= 0 && highlightIndex < suggestions.length
      ? suggestions[highlightIndex]
      : null;

  return {
    suggestions,
    isLoading,
    highlightIndex,
    setHighlightIndex,
    moveHighlight,
    highlighted,
  };
}
