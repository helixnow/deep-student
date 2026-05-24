/**
 * 多选管理 Hook
 *
 * 提供文件列表多选功能，支持：
 * - 点击选择/取消选择
 * - Shift+点击范围选择
 * - Ctrl/Cmd+A 全选
 * - 选中项计数
 */

import { useState, useCallback, useMemo } from 'react';

export interface UseMultiSelectOptions {
  /** 所有可选项的 ID 列表 */
  itemIds: string[];
  /** 初始选中的 ID */
  initialSelection?: Set<string>;
  /** 选择变化回调 */
  onSelectionChange?: (selectedIds: Set<string>) => void;
}

export interface UseMultiSelectReturn {
  /** 当前选中的 ID 集合 */
  selectedIds: Set<string>;
  /** 选中数量 */
  selectedCount: number;
  /** 是否全选 */
  isAllSelected: boolean;
  /** 是否有选中 */
  hasSelection: boolean;
  /** 最后选中的 ID（用于 Shift 范围选择） */
  lastSelectedId: string | null;
  /** 切换单个项的选择状态 */
  toggleSelect: (id: string, shiftKey?: boolean) => void;
  /** 选择单个项（取消其他） */
  selectOnly: (id: string) => void;
  /** 全选 */
  selectAll: () => void;
  /** 清空选择 */
  clearSelection: () => void;
  /** 选择多个 */
  selectMany: (ids: string[]) => void;
  /** 取消选择多个 */
  deselectMany: (ids: string[]) => void;
  /** 检查是否选中 */
  isSelected: (id: string) => boolean;
}

/**
 * 多选管理 Hook
 */
export function useMultiSelect(options: UseMultiSelectOptions): UseMultiSelectReturn {
  const { itemIds, initialSelection, onSelectionChange } = options;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => initialSelection ?? new Set()
  );
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  // 更新选择并触发回调
  const updateSelection = useCallback(
    (newSelection: Set<string>) => {
      setSelectedIds(newSelection);
      onSelectionChange?.(newSelection);
    },
    [onSelectionChange]
  );

  // 切换选择（支持 Shift 范围选择）
  const toggleSelect = useCallback(
    (id: string, shiftKey = false) => {
      if (shiftKey && lastSelectedId && lastSelectedId !== id) {
        // Shift 范围选择
        const startIndex = itemIds.indexOf(lastSelectedId);
        const endIndex = itemIds.indexOf(id);
        if (startIndex !== -1 && endIndex !== -1) {
          const [from, to] = startIndex < endIndex 
            ? [startIndex, endIndex] 
            : [endIndex, startIndex];
          const rangeIds = itemIds.slice(from, to + 1);
          const newSelection = new Set(selectedIds);
          rangeIds.forEach((rangeId) => newSelection.add(rangeId));
          updateSelection(newSelection);
          setLastSelectedId(id);
          return;
        }
      }

      // 普通切换
      const newSelection = new Set(selectedIds);
      if (newSelection.has(id)) {
        newSelection.delete(id);
      } else {
        newSelection.add(id);
      }
      updateSelection(newSelection);
      setLastSelectedId(id);
    },
    [itemIds, lastSelectedId, selectedIds, updateSelection]
  );

  // 只选择单个（取消其他）
  const selectOnly = useCallback(
    (id: string) => {
      updateSelection(new Set([id]));
      setLastSelectedId(id);
    },
    [updateSelection]
  );

  // 全选
  const selectAll = useCallback(() => {
    updateSelection(new Set(itemIds));
  }, [itemIds, updateSelection]);

  // 清空选择
  const clearSelection = useCallback(() => {
    updateSelection(new Set());
    setLastSelectedId(null);
  }, [updateSelection]);

  // 选择多个
  const selectMany = useCallback(
    (ids: string[]) => {
      const newSelection = new Set(selectedIds);
      ids.forEach((id) => newSelection.add(id));
      updateSelection(newSelection);
    },
    [selectedIds, updateSelection]
  );

  // 取消选择多个
  const deselectMany = useCallback(
    (ids: string[]) => {
      const newSelection = new Set(selectedIds);
      ids.forEach((id) => newSelection.delete(id));
      updateSelection(newSelection);
    },
    [selectedIds, updateSelection]
  );

  // 检查是否选中
  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds]
  );

  // 计算属性
  const selectedCount = selectedIds.size;
  const isAllSelected = itemIds.length > 0 && selectedIds.size === itemIds.length;
  const hasSelection = selectedIds.size > 0;

  return {
    selectedIds,
    selectedCount,
    isAllSelected,
    hasSelection,
    lastSelectedId,
    toggleSelect,
    selectOnly,
    selectAll,
    clearSelection,
    selectMany,
    deselectMany,
    isSelected,
  };
}
