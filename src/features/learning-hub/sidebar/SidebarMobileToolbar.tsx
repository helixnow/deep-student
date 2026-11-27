import type React from 'react';
import type { DstuNode } from '@/dstu';
import { X, Trash } from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import type { SidebarT } from './sidebarConstants';

export interface SidebarMobileToolbarProps {
  t: SidebarT;
  mobileSearchExpanded: boolean;
  setMobileSearchExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  searchPlaceholder: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  canSearchInCurrentView: boolean;
  isTrashView: boolean;
  handleEmptyTrash: () => void;
  items: DstuNode[];
}

/** 移动端按需展开条：仅在搜索展开态或回收站非空时渲染；搜索与新建入口已统一收敛至全局顶栏 UnifiedMobileHeader */
export function SidebarMobileToolbar({
  t,
  mobileSearchExpanded,
  setMobileSearchExpanded,
  searchPlaceholder,
  searchQuery,
  setSearchQuery,
  canSearchInCurrentView,
  isTrashView,
  handleEmptyTrash,
  items,
}: SidebarMobileToolbarProps) {
  const showTrashAction = isTrashView && items.length > 0;
  if (!mobileSearchExpanded && !showTrashAction) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-[color:var(--shell-chrome-border)] bg-[color:var(--shell-titlebar-surface)] px-2 py-1.5"
    >
      {mobileSearchExpanded ? (
        // 搜索框展开态
        <div className="flex-1 flex items-center gap-1">
          <Input
            type="search"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            // iOS 保留 16px 地板，同时继续响应界面字号缩放。
            className="h-[var(--touch-target-size)] text-[max(16px,var(--font-size-lg))] flex-1"
            autoFocus
            disabled={!canSearchInCurrentView}
          />
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => {
              setMobileSearchExpanded(false);
              setSearchQuery('');
            }}
            aria-label={t('common:close')}
          >
            <X className="w-5 h-5" />
          </DsButton>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-end">
          <DsButton
            variant="danger"
            size="sm"
            onClick={handleEmptyTrash}
            title={t('finder.actions.emptyTrash')}
            aria-label={t('finder.actions.emptyTrash')}
          >
            <Trash className="w-4 h-4 mr-1" />
            {t('finder.actions.emptyTrash')}
          </DsButton>
        </div>
      )}
    </div>
  );
}
