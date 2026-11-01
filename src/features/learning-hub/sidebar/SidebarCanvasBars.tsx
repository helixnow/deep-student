import React from 'react';
import { X, CheckSquare, ListChecks, CaretLeft, CaretRight, House } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import type { DstuNode } from '@/dstu';
import type { FinderPath } from '../stores/finderStore';
import type { SidebarT } from './sidebarConstants';
import type { useMemoryFolderDisplay } from './useMemoryFolderDisplay';

export interface SidebarCanvasNavBarProps {
  t: SidebarT;
  isSmallScreen: boolean;
  goBack: () => void;
  goForward: () => void;
  historyIndex: number;
  history: FinderPath[];
  jumpToBreadcrumb: (index: number) => void;
  displayBreadcrumbs: ReturnType<typeof useMemoryFolderDisplay>['displayBreadcrumbs'];
}

/** ★ Canvas 模式导航栏：返回/前进 + 面包屑 */
export function SidebarCanvasNavBar({
  t,
  isSmallScreen,
  goBack,
  goForward,
  historyIndex,
  history,
  jumpToBreadcrumb,
  displayBreadcrumbs,
}: SidebarCanvasNavBarProps) {
  return (
    <div className="study-shell-toolbar flex items-center gap-1 px-1.5 py-1 border-b shrink-0 min-w-0">
      {/* 返回/前进按钮（N-5: 小屏放大触控目标） */}
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        className={cn('p-0 shrink-0', !isSmallScreen && 'h-6 w-6')}
        onClick={goBack}
        disabled={historyIndex <= 0}
        title={t('finder.toolbar.back')}
      >
        <CaretLeft className={isSmallScreen ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
      </DsButton>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        className={cn('p-0 shrink-0', !isSmallScreen && 'h-6 w-6')}
        onClick={goForward}
        disabled={historyIndex >= history.length - 1}
        title={t('finder.toolbar.forward')}
      >
        <CaretRight className={isSmallScreen ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
      </DsButton>
      {/* 面包屑路径 */}
      <div className="flex items-center gap-0.5 min-w-0 overflow-hidden text-xs">
        <DsButton variant="ghost" size="icon" iconOnly onClick={() => jumpToBreadcrumb(-1)} className={cn('shrink-0 !p-0', !isSmallScreen && '!h-4 !w-4')} title={t('learningHub:title')} aria-label={t('breadcrumb.home')}>
          <House className={isSmallScreen ? 'w-4 h-4' : 'w-3 h-3'} />
        </DsButton>
        {displayBreadcrumbs.map((crumb, index) => (
          <React.Fragment key={crumb.id}>
            <span className="text-muted-foreground/50 shrink-0">/</span>
            {index === displayBreadcrumbs.length - 1 ? (
              <span className="truncate text-foreground font-medium">{crumb.name}</span>
            ) : (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => jumpToBreadcrumb(index)}
                className={cn(
                  '!h-auto !p-0 truncate text-muted-foreground hover:text-foreground',
                  isSmallScreen
                    ? '!px-2'
                    : '[@media(pointer:coarse)]:!px-2',
                )}
              >
                {crumb.name}
              </DsButton>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export interface SidebarCanvasToolbarProps {
  t: SidebarT;
  isSmallScreen: boolean;
  isMultiSelectMode: boolean;
  selectedIds: Set<string>;
  items: DstuNode[];
  handleClearSelection: () => void;
  handleSelectAll: () => void;
  canAddToChatInCurrentView: boolean;
  handleBatchAddToChat: () => Promise<void>;
  isBatchProcessing: boolean;
  isInjecting: boolean;
  toggleMultiSelect: () => void;
  onClose?: () => void;
}

/** ★ Canvas 模式顶部工具栏：多选模式 + 关闭按钮 */
export function SidebarCanvasToolbar({
  t,
  isSmallScreen,
  isMultiSelectMode,
  selectedIds,
  items,
  handleClearSelection,
  handleSelectAll,
  canAddToChatInCurrentView,
  handleBatchAddToChat,
  isBatchProcessing,
  isInjecting,
  toggleMultiSelect,
  onClose,
}: SidebarCanvasToolbarProps) {
  return (
    <div data-wb-blur-surface className="study-shell-toolbar study-shell-toolbar--floating flex items-center justify-between px-2 py-1.5 border-b backdrop-blur-lg shrink-0">
      <div className="flex items-center gap-1.5 min-w-0">
        {isMultiSelectMode ? (
          // 多选模式下显示选中信息和操作
          <>
            <span className="text-xs font-medium whitespace-nowrap">
              {selectedIds.size > 0
                ? t('finder.canvas.selected', { count: selectedIds.size })
                : t('finder.canvas.selectHint')}
            </span>
            {selectedIds.size > 0 && (
              <>
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-1.5"
                  onClick={selectedIds.size === items.length ? handleClearSelection : handleSelectAll}
                  title={selectedIds.size === items.length ? t('finder.batch.deselectAll') : t('finder.batch.selectAll')}
                >
                  {selectedIds.size === items.length
                    ? <CheckSquare className="w-3.5 h-3.5" />
                    : t('finder.batch.selectAll')}
                </DsButton>
                {canAddToChatInCurrentView && (
                <DsButton
                  variant="primary"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={handleBatchAddToChat}
                  disabled={isBatchProcessing || isInjecting}
                >
                  {isInjecting
                    ? t('finder.canvas.adding')
                    : t('finder.canvas.addToChat')}
                </DsButton>
                )}
              </>
            )}
          </>
        ) : (
          // 普通模式显示项目数
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t('finder.statusBar.itemCount', { count: items.length })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {/* 多选模式切换按钮 */}
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className={cn(
            'p-0',
            !isSmallScreen && 'h-7 w-7',
            isMultiSelectMode && "bg-primary/10 text-primary hover:bg-primary/15"
          )}
          onClick={toggleMultiSelect}
          title={isMultiSelectMode ? t('finder.canvas.exitMultiSelect') : t('finder.canvas.multiSelect')}
        >
          <ListChecks className={isSmallScreen ? 'w-5 h-5' : 'w-4 h-4'} />
        </DsButton>
        {/* 关闭资源库按钮 */}
        {onClose && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className={cn('p-0', !isSmallScreen && 'h-7 w-7')}
            onClick={onClose}
            title={t('common:close')}
          >
            <X className={isSmallScreen ? 'w-5 h-5' : 'w-4 h-4'} />
          </DsButton>
        )}
      </div>
    </div>
  );
}
