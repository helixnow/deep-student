/**
 * Analysis Panel host: favourite and activated panels, restored from localStorage (a value that is not an array
 * starts empty, non-string entries are dropped) and saved on every change; a failed write keeps the change in memory.
 */
import React from 'react';

const FAVORITES_STORAGE_KEY = 'DSTU_DEBUG_FAVORITES';
const ACTIVATED_STORAGE_KEY = 'DSTU_DEBUG_ACTIVATED';

export function usePanelPreferences() {
  const [favoriteIds, setFavoriteIds] = React.useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((id): id is string => typeof id === 'string'));
        }
      }
    } catch {
      // localStorage 不可用或收藏数据损坏，重置为空
    }
    return new Set();
  });
  const [activatedIds, setActivatedIds] = React.useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(ACTIVATED_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((id): id is string => typeof id === 'string'));
        }
      }
    } catch {
      // localStorage 不可用或激活数据损坏，重置为空
    }
    return new Set();
  });

  const toggleFavorite = React.useCallback((pluginId: string) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(pluginId)) {
        next.delete(pluginId);
      } else {
        next.add(pluginId);
      }
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // localStorage 写入失败（如配额已满），收藏仍在内存中生效
      }
      return next;
    });
  }, []);

  const activatePlugin = React.useCallback((pluginId: string) => {
    setActivatedIds(prev => {
      if (prev.has(pluginId)) return prev;
      const next = new Set(prev);
      next.add(pluginId);
      try {
        localStorage.setItem(ACTIVATED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // localStorage 写入失败时，插件激活状态仍在内存中生效
      }
      return next;
    });
  }, []);

  return { favoriteIds, activatedIds, toggleFavorite, activatePlugin };
}
