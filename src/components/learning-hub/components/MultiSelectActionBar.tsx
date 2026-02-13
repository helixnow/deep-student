/**
 * 多选操作栏组件
 *
 * 在多选模式下显示选中数量和批量操作按钮
 *
 * 功能：
 * - 显示选中数量
 * - 全选/取消全选
 * - 批量删除
 * - 批量移动
 * - 退出多选模式
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Trash2,
  FolderInput,
  CheckSquare,
  Square,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';

// ============================================================================
// 类型定义
// ============================================================================

export interface MultiSelectActionBarProps {
  /** 选中的数量 */
  selectionCount: number;
  /** 总项目数 */
  totalCount: number;
  /** 是否显示恢复按钮（回收站模式） */
  showRestore?: boolean;
  /** 全选回调 */
  onSelectAll: () => void;
  /** 取消全选回调 */
  onDeselectAll: () => void;
  /** 批量删除回调 */
  onDelete: () => Promise<void>;
  /** 批量恢复回调（回收站模式） */
  onRestore?: () => Promise<void>;
  /** 批量移动回调 */
  onMove?: () => void;
  /** 退出多选模式回调 */
  onExit: () => void;
  /** 自定义样式 */
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * MultiSelectActionBar 多选操作栏
 * 使用 React.memo 优化，避免列表滚动等操作导致不必要的重渲染
 */
export const MultiSelectActionBar = React.memo(function MultiSelectActionBar({
  selectionCount,
  totalCount,
  showRestore = false,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onRestore,
  onMove,
  onExit,
  className,
}: MultiSelectActionBarProps) {
  const { t } = useTranslation(['learningHub']);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const isAllSelected = selectionCount > 0 && selectionCount === totalCount;
  const hasSelection = selectionCount > 0;

  // 处理删除
  const handleDelete = useCallback(async () => {
    if (isDeleting || selectionCount === 0) return;
    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, selectionCount, onDelete]);

  // 处理恢复
  const handleRestore = useCallback(async () => {
    if (isRestoring || selectionCount === 0 || !onRestore) return;
    setIsRestoring(true);
    try {
      await onRestore();
    } finally {
      setIsRestoring(false);
    }
  }, [isRestoring, selectionCount, onRestore]);

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-3 py-2',
        'bg-primary/10 dark:bg-primary/20 border-b border-primary/20',
        'transition-all duration-200',
        className
      )}
    >
      {/* 左侧：选中数量和全选按钮 */}
      <div className="flex items-center gap-2">
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={isAllSelected ? onDeselectAll : onSelectAll}
          className="h-7 px-2"
        >
          {isAllSelected ? (
            <CheckSquare className="w-4 h-4 mr-1" />
          ) : (
            <Square className="w-4 h-4 mr-1" />
          )}
          <span className="text-xs">
            {isAllSelected
              ? t('learningHub:multiSelect.deselectAll')
              : t('learningHub:multiSelect.selectAll')}
          </span>
        </NotionButton>

        <span className="text-sm text-muted-foreground">
          {t('learningHub:multiSelect.selectedCount', { count: selectionCount })}
        </span>
      </div>

      {/* 右侧：操作按钮 */}
      <div className="flex items-center gap-1">
        {/* 恢复按钮（仅回收站模式） */}
        {showRestore && onRestore && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRestore}
            disabled={!hasSelection || isRestoring}
            className="h-7 px-2 text-green-600 hover:text-green-700 hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/30"
          >
            {isRestoring ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4 mr-1" />
            )}
            <span className="text-xs">{t('learningHub:multiSelect.restore')}</span>
          </NotionButton>
        )}

        {/* 移动按钮 */}
        {onMove && !showRestore && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onMove}
            disabled={!hasSelection}
            className="h-7 px-2"
          >
            <FolderInput className="w-4 h-4 mr-1" />
            <span className="text-xs">{t('learningHub:multiSelect.move')}</span>
          </NotionButton>
        )}

        {/* 删除按钮 */}
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          disabled={!hasSelection || isDeleting}
          className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          {isDeleting ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4 mr-1" />
          )}
          <span className="text-xs">
            {showRestore
              ? t('learningHub:multiSelect.permanentDelete')
              : t('learningHub:multiSelect.delete')}
          </span>
        </NotionButton>

        {/* 分隔线 */}
        <div className="w-px h-4 bg-border mx-1" />

        {/* 退出按钮 */}
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={onExit}
          className="h-7 px-2"
        >
          <X className="w-4 h-4 mr-1" />
          <span className="text-xs">{t('learningHub:multiSelect.exit')}</span>
        </NotionButton>
      </div>
    </div>
  );
});
