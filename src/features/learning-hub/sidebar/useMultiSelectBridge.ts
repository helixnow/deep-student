import { useEffect, useLayoutEffect } from 'react';
import type { LearningHubSidebarProps } from '../types';

/** 多选模式与外部全局顶栏的桥接（toggle 句柄写入 + 激活态通知） */
export function useMultiSelectBridge({
  multiSelectToggleRef,
  toggleMultiSelect,
  onMultiSelectModeChange,
  isMultiSelectMode,
}: {
  multiSelectToggleRef: LearningHubSidebarProps['multiSelectToggleRef'];
  toggleMultiSelect: () => void;
  onMultiSelectModeChange: LearningHubSidebarProps['onMultiSelectModeChange'];
  isMultiSelectMode: boolean;
}) {
  // 把最新 toggle 句柄写入外部 ref（全局顶栏按钮持有），供外部随时调用
  useLayoutEffect(() => {
    if (multiSelectToggleRef) {
      multiSelectToggleRef.current = toggleMultiSelect;
    }
  });

  // 多选态变化通知外部（全局顶栏按钮的激活高亮）
  useEffect(() => {
    onMultiSelectModeChange?.(isMultiSelectMode);
  }, [isMultiSelectMode, onMultiSelectModeChange]);
}
