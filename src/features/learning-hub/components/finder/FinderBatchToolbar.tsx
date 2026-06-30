import React from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Trash, 
  FolderOpen, 
  Chat, 
  X, 
  CheckSquare,
  Square,
  SquaresFour,
  List,
  SortAscending,
  SortDescending,
  Check,
  ListChecks,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import type { SortBy, SortOrder } from '../../stores/finderStore';

interface FinderBatchToolbarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBatchDelete: () => void;
  onBatchMove?: () => void;
  onBatchAddToChat?: () => void;
  isProcessing?: boolean;
  className?: string;
  /** 视图模式 */
  viewMode?: 'grid' | 'list';
  /** 视图模式切换回调 */
  onViewModeChange?: (mode: 'grid' | 'list') => void;
  /** 当前排序字段 */
  sortBy?: SortBy;
  /** 当前排序顺序 */
  sortOrder?: SortOrder;
  /** 排序变更回调 */
  onSortChange?: (sortBy: SortBy, sortOrder: SortOrder) => void;
  /** 是否有应用打开 */
  hasOpenApp?: boolean;
  /** 关闭应用回调 */
  onCloseApp?: () => void;
  /** ★ 2026-06-12（审阅问题 FE-S3）：多选模式开关（触屏设备） */
  multiSelectMode?: boolean;
  /** 多选模式切换回调（传入时显示开关按钮） */
  onToggleMultiSelectMode?: () => void;
}

const SORT_OPTIONS: { value: SortBy; labelKey: string }[] = [
  { value: 'name', labelKey: 'finder.sort.name' },
  { value: 'updatedAt', labelKey: 'finder.sort.updatedAt' },
  { value: 'createdAt', labelKey: 'finder.sort.createdAt' },
  { value: 'type', labelKey: 'finder.sort.type' },
];

/**
 * FinderBatchToolbar 批量操作工具栏
 * 使用 React.memo 优化，避免文件列表滚动等操作导致不必要的重渲染
 */
export const FinderBatchToolbar = React.memo(function FinderBatchToolbar({
  selectedCount,
  totalCount,
  onSelectAll,
  onClearSelection,
  onBatchDelete,
  onBatchMove,
  onBatchAddToChat,
  isProcessing = false,
  className,
  viewMode = 'grid',
  onViewModeChange,
  sortBy = 'updatedAt',
  sortOrder = 'desc',
  onSortChange,
  hasOpenApp = false,
  onCloseApp,
  multiSelectMode = false,
  onToggleMultiSelectMode,
}: FinderBatchToolbarProps) {
  const { t } = useTranslation('learningHub');

  const hasSelection = selectedCount > 0;

  const allSelected = selectedCount === totalCount && totalCount > 0;

  return (
    <div 
      className={cn(
        "relative -mr-px flex items-center gap-1.5 px-2 border-t text-sm h-11 shrink-0 overflow-hidden",
        hasSelection ? "bg-accent/80 backdrop-blur-sm" : "bg-background/95 backdrop-blur-lg",
        className
      )}
    >
      {/* 左侧：项目计数 + 视图切换 - 允许在窄屏下收缩 */}
      <div className="flex items-center gap-2 min-w-0 shrink">
        {/* 项目计数 */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t('finder.statusBar.itemCount', { count: totalCount })}
        </span>

        {/* 视图切换按钮组 - 在有选中项时可能被隐藏 */}
        {onViewModeChange && !hasSelection && (
          <div className="flex items-center bg-muted/50 rounded p-0.5 gap-0.5 shrink-0">
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onViewModeChange('grid')} className={cn('!h-6 !w-6 !p-1', viewMode === 'grid' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')} title={t('finder.viewMode.grid')} aria-label="grid">
              <SquaresFour size={14} />
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onViewModeChange('list')} className={cn('!h-6 !w-6 !p-1', viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')} title={t('finder.viewMode.list')} aria-label="list">
              <List size={14} />
            </NotionButton>
          </div>
        )}

        {/* ★ 多选模式开关（触屏设备，由父组件决定是否传入） */}
        {onToggleMultiSelectMode && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onToggleMultiSelectMode}
            className={cn(
              '!h-6 !w-6 !p-1 shrink-0',
              multiSelectMode
                ? 'bg-primary/10 text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title={multiSelectMode ? t('finder.canvas.exitMultiSelect', '退出多选') : t('finder.canvas.multiSelect', '多选')}
            aria-label="multi-select"
          >
            <ListChecks size={14} />
          </NotionButton>
        )}

        {/* 排序菜单 - 在有选中项时隐藏 */}
        {onSortChange && !hasSelection && (
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                className="!h-6 !w-6 !p-1 text-muted-foreground hover:text-foreground shrink-0"
                title={t('finder.sort.title', '排序方式')}
                aria-label="sort"
              >
                {sortOrder === 'asc' ? <SortAscending size={14} /> : <SortDescending size={14} />}
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={170}>
              {SORT_OPTIONS.map((opt) => (
                <AppMenuItem
                  key={opt.value}
                  onClick={() => onSortChange(opt.value, sortOrder)}
                  icon={sortBy === opt.value ? <Check size={14} /> : <span className="w-3.5" />}
                >
                  {t(opt.labelKey)}
                </AppMenuItem>
              ))}
              <AppMenuSeparator />
              <AppMenuItem
                onClick={() => onSortChange(sortBy, 'asc')}
                icon={sortOrder === 'asc' ? <Check size={14} /> : <span className="w-3.5" />}
              >
                {t('finder.sort.asc', '升序')}
              </AppMenuItem>
              <AppMenuItem
                onClick={() => onSortChange(sortBy, 'desc')}
                icon={sortOrder === 'desc' ? <Check size={14} /> : <span className="w-3.5" />}
              >
                {t('finder.sort.desc', '降序')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        )}
      </div>

      {/* 选择信息（有选中项时显示）- 允许文本被截断 */}
      {hasSelection && (
        <div className="flex items-center gap-1 text-accent-foreground min-w-0 ml-2 overflow-hidden">
          <span className="text-muted-foreground/60 shrink-0">|</span>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={allSelected ? onClearSelection : onSelectAll} className="!h-6 !w-6 !p-1 shrink-0" title={allSelected ? t('finder.batch.deselectAll') : t('finder.batch.selectAll')} aria-label="toggle select">
            {allSelected ? (
              <CheckSquare size={16} />
            ) : (
              <Square size={16} />
            )}
          </NotionButton>
          <span className="font-medium whitespace-nowrap text-xs truncate">
            {t('finder.multiSelect.selected', { count: selectedCount })}
          </span>
        </div>
      )}

      {/* 右侧操作区域 - 使用 shrink-0 防止被压缩 */}
      <div className="flex items-center gap-0.5 ml-auto shrink-0">
        {/* 批量操作按钮 - 仅在有选中项时显示 */}
        {hasSelection && (
          <>
            {onBatchAddToChat && (
              <NotionButton
                variant="ghost"
                size="icon"
                onClick={onBatchAddToChat}
                disabled={isProcessing}
                className="h-7 w-7 text-accent-foreground hover:bg-[var(--interactive-hover)]-foreground/10"
                title={t('finder.multiSelect.addToChat')}
              >
                <Chat size={16} />
              </NotionButton>
            )}

            {onBatchMove && (
            <NotionButton
              variant="ghost"
              size="icon"
              onClick={onBatchMove}
              disabled={isProcessing}
              className="h-7 w-7 text-accent-foreground hover:bg-[var(--interactive-hover)]-foreground/10"
              title={t('finder.multiSelect.move')}
            >
              <FolderOpen size={16} />
            </NotionButton>
            )}

            <NotionButton
              variant="ghost"
              size="icon"
              onClick={onBatchDelete}
              disabled={isProcessing}
              className="h-7 w-7 text-destructive hover:bg-destructive/10"
              title={t('finder.multiSelect.delete')}
            >
              <Trash size={16} />
            </NotionButton>

            {/* 清除选择/关闭按钮 - 放在删除按钮后面，使用明显的样式 */}
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => { onClearSelection(); if (hasOpenApp && onCloseApp) { onCloseApp(); } }} className="!h-7 !w-7 !p-1.5 hover:bg-[var(--interactive-hover)]-foreground/10 ml-0.5" title={hasOpenApp ? t('finder.appPanel.close') : t('common:close')} aria-label="close">
              <X size={16} className="text-accent-foreground" />
            </NotionButton>
          </>
        )}

        {/* 关闭应用按钮 - 无选中项但有应用打开时显示 */}
        {!hasSelection && hasOpenApp && onCloseApp && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onCloseApp}
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
            {t('finder.appPanel.close')}
          </NotionButton>
        )}
      </div>
    </div>
  );
});
