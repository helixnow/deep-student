/**
 * VFS 统一索引状态管理
 */

import { create } from 'zustand';
import type {
  IndexStatusSummary,
  UnitIndexStatus,
  IndexMode,
  StateStats,
} from '../types/vfs-unified-index';
import { vfsUnifiedIndexApi } from '../api/vfsUnifiedIndexApi';

interface UnifiedIndexFilters {
  resourceType: string | null;
  textState: string | null;
  mmState: string | null;
  modality: 'text' | 'mm' | 'both' | null;
}

interface UnifiedIndexState {
  // 状态数据
  summary: IndexStatusSummary | null;
  selectedResourceUnits: UnitIndexStatus[];
  selectedResourceId: string | null;
  
  // UI 状态
  isLoading: boolean;
  error: string | null;
  filters: UnifiedIndexFilters;
  
  // Actions
  refresh: () => Promise<void>;
  setFilters: (filters: Partial<UnifiedIndexFilters>) => void;
  selectResource: (resourceId: string) => Promise<void>;
  clearSelectedResource: () => void;
  reindexUnit: (unitId: string, mode?: IndexMode) => Promise<boolean>;
  batchIndex: (mode?: IndexMode, batchSize?: number) => Promise<{ success: number; fail: number }>;
}

const defaultFilters: UnifiedIndexFilters = {
  resourceType: null,
  textState: null,
  mmState: null,
  modality: null,
};

const defaultStats: StateStats = {
  pending: 0,
  indexing: 0,
  indexed: 0,
  failed: 0,
  disabled: 0,
};

export const useUnifiedIndexStore = create<UnifiedIndexState>((set, get) => ({
  // 初始状态
  summary: null,
  selectedResourceUnits: [],
  selectedResourceId: null,
  isLoading: false,
  error: null,
  filters: { ...defaultFilters },

  // 刷新索引状态总览
  refresh: async () => {
    set({ isLoading: true, error: null });
    try {
      const summary = await vfsUnifiedIndexApi.getUnifiedIndexStatus();
      set({ summary, isLoading: false });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set({ error: errorMsg, isLoading: false });
      console.error('[UnifiedIndexStore] refresh failed:', err);
    }
  },

  // 设置筛选条件
  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    }));
  },

  // 选择资源并加载其 Units
  selectResource: async (resourceId) => {
    set({ isLoading: true, error: null, selectedResourceId: resourceId });
    try {
      const units = await vfsUnifiedIndexApi.getResourceUnits(resourceId);
      set({ selectedResourceUnits: units, isLoading: false });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set({ error: errorMsg, isLoading: false, selectedResourceUnits: [] });
      console.error('[UnifiedIndexStore] selectResource failed:', err);
    }
  },

  // 清除选中的资源
  clearSelectedResource: () => {
    set({ selectedResourceId: null, selectedResourceUnits: [] });
  },

  // 重新索引单个 Unit
  reindexUnit: async (unitId, mode = 'both') => {
    try {
      const result = await vfsUnifiedIndexApi.reindexUnit(unitId, mode);
      // 刷新数据
      const { selectedResourceId } = get();
      if (selectedResourceId) {
        const units = await vfsUnifiedIndexApi.getResourceUnits(selectedResourceId);
        set({ selectedResourceUnits: units });
      }
      await get().refresh();
      return result;
    } catch (err: unknown) {
      console.error('[UnifiedIndexStore] reindexUnit failed:', err);
      return false;
    }
  },

  // 批量索引
  batchIndex: async (mode = 'both', batchSize) => {
    set({ isLoading: true });
    try {
      const result = await vfsUnifiedIndexApi.batchIndexPending(mode, batchSize);
      await get().refresh();
      set({ isLoading: false });
      return { success: result.successCount, fail: result.failCount };
    } catch (err: unknown) {
      console.error('[UnifiedIndexStore] batchIndex failed:', err);
      set({ isLoading: false });
      return { success: 0, fail: 0 };
    }
  },
}));

// 选择器
export const selectTextProgress = (state: UnifiedIndexState): number => {
  if (!state.summary) return 0;
  const { textStats } = state.summary;
  const total = textStats.pending + textStats.indexing + textStats.indexed + textStats.failed;
  if (total === 0) return 100;
  return Math.round((textStats.indexed / total) * 100);
};

export const selectMmProgress = (state: UnifiedIndexState): number => {
  if (!state.summary) return 0;
  const { mmStats } = state.summary;
  const total = mmStats.pending + mmStats.indexing + mmStats.indexed + mmStats.failed;
  if (total === 0) return 100;
  return Math.round((mmStats.indexed / total) * 100);
};

export const selectHasPendingWork = (state: UnifiedIndexState): boolean => {
  if (!state.summary) return false;
  const { textStats, mmStats } = state.summary;
  return textStats.pending > 0 || mmStats.pending > 0;
};
