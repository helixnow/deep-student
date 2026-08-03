import { useCallback, useState } from 'react';

const STORAGE_KEY = 'chat-v2-group-collapsed';

function readStoredCollapsedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, boolean>;
      }
    }
  } catch {
    // ignore storage errors
  }
  return {};
}

export function useGroupCollapse() {
  // 惰性初始化：直接从 localStorage 读取，避免挂载后异步覆盖（首帧闪烁 +
  // 覆盖掉挂载早期 expandGroup 写入的状态）
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(readStoredCollapsedMap);

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const expandGroup = useCallback((groupId: string) => {
    setCollapsedMap((prev) => {
      if (!prev[groupId]) return prev; // 已经展开
      const next = { ...prev, [groupId]: false };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  // P2-4 fix: Clean up collapsed state for groups that no longer exist
  const pruneDeletedGroups = useCallback((activeGroupIds: string[]) => {
    setCollapsedMap((prev) => {
      const activeSet = new Set(activeGroupIds);
      // Always keep 'ungrouped' key
      activeSet.add('ungrouped');
      const pruned: Record<string, boolean> = {};
      let changed = false;
      for (const [key, value] of Object.entries(prev)) {
        if (activeSet.has(key)) {
          pruned[key] = value;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
      } catch {
        // ignore storage errors
      }
      return pruned;
    });
  }, []);

  return { collapsedMap, toggleGroupCollapse, expandGroup, pruneDeletedGroups };
}
