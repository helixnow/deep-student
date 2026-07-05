/**
 * TodoSidebar - 待办侧边栏
 *
 * 作为 Shell 导航栏的内容，由 TodoShellSidebar 包裹后替换主导航。
 * - 使用 .desktop-shell-nav-row / --active 行样式（32px 高，14px 圆角，14px 字号，扁平）
 * - 使用 .desktop-shell-nav-section-label 分组标签（12px 淡色）
 * - 行间距 space-y-0.5，行内图标 18px + 10px 间距
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Tray,
  Star,
  Calendar,
  Warning,
  Clock,
  CheckSquare,
  Plus,
  MagnifyingGlass,
  Trash,
  X,
  PencilSimple,
  SquaresFour,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMobileUnifiedDrawer } from '@/components/layout/MobileDrawerContext';
import { useTodoStore } from '../stores/useTodoStore';
import { TodoTrashDialog } from './TodoTrashDialog';
import type { TodoList, TodoViewFilter } from '../types';

interface SmartView {
  id: TodoViewFilter;
  icon: React.ElementType;
  labelKey: string;
}

const SMART_VIEWS: SmartView[] = [
  { id: 'all', icon: Tray, labelKey: 'todo:views.inbox' },
  { id: 'today', icon: Calendar, labelKey: 'todo:views.today' },
  { id: 'upcoming', icon: Clock, labelKey: 'todo:views.upcoming' },
  { id: 'matrix', icon: SquaresFour, labelKey: 'todo:views.matrix' },
  { id: 'overdue', icon: Warning, labelKey: 'todo:views.overdue' },
  { id: 'completed', icon: CheckSquare, labelKey: 'todo:views.completed' },
];

// ============================================================================
// 与 ModernSidebar 保持一致的行样式原语
// ============================================================================

function getNavRowClassName(isActive: boolean, className?: string) {
  return cn(
    'desktop-shell-sidebar-row desktop-shell-nav-row',
    '!w-full !justify-start !px-2.5 !py-1.5 text-left',
    isActive && 'desktop-shell-nav-row--active',
    className,
  );
}

interface NavRowProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive: boolean;
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}

const NavRow: React.FC<NavRowProps> = ({
  isActive,
  leftSlot,
  rightSlot,
  children,
  className,
  ...rest
}) => {
  // 统一抽屉内行高对齐 mobileDrawerNavRowClassName 的 44px 触控标准
  const unifiedDrawer = useMobileUnifiedDrawer();
  return (
  <NotionButton
    variant="nav"
    size="md"
    className={getNavRowClassName(isActive, cn(unifiedDrawer && 'min-h-[2.75rem]', className))}
    {...rest}
  >
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <span className="flex w-4 shrink-0 items-center justify-center text-[color:inherit]">
        {leftSlot}
      </span>
      <span className="desktop-shell-sidebar-row-title block min-w-0 flex-1 truncate leading-4">
        {children}
      </span>
      {rightSlot !== undefined && (
        <span className="flex min-w-[24px] shrink-0 items-center justify-end gap-0.5">
          {rightSlot}
        </span>
      )}
    </span>
  </NotionButton>
  );
};

// ============================================================================
// TodoSidebar
// ============================================================================

interface TodoSidebarProps {
  /** 移动端点击列表后回调（用于关闭滑动侧栏） */
  onItemSelect?: () => void;
}

export const TodoSidebar: React.FC<TodoSidebarProps> = ({ onItemSelect }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { isSmallScreen } = useBreakpoint();
  const unifiedDrawer = useMobileUnifiedDrawer();
  const {
    lists,
    activeListId,
    filter,
    overdueCount,
    setActiveList,
    setViewFilter,
    createList,
    updateList,
    deleteList,
    toggleListFavorite,
  } = useTodoStore();

  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // 行内重命名状态
  const [renamingListId, setRenamingListId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 删除确认
  const [pendingDeleteList, setPendingDeleteList] = useState<TodoList | null>(null);
  // 回收站
  const [trashOpen, setTrashOpen] = useState(false);

  // ===== 回调 =====
  const handleCreateList = useCallback(async () => {
    const trimmed = newListTitle.trim();
    if (!trimmed) {
      setIsCreating(false);
      return;
    }
    try {
      const list = await createList(trimmed);
      setNewListTitle('');
      setIsCreating(false);
      setActiveList(list.id);
      setViewFilter('all');
      onItemSelect?.();
    } catch {
      // error handled in store
    }
  }, [newListTitle, createList, setActiveList, setViewFilter, onItemSelect]);

  const handleCreateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCreateList();
      if (e.key === 'Escape') {
        setIsCreating(false);
        setNewListTitle('');
      }
    },
    [handleCreateList],
  );

  const handleSmartViewClick = useCallback(
    (view: TodoViewFilter) => {
      if (view === 'all') {
        const defaultList = lists.find((l) => l.isDefault) || lists[0];
        if (defaultList) setActiveList(defaultList.id);
      } else {
        setActiveList(null);
      }
      setViewFilter(view);
      onItemSelect?.();
    },
    [lists, setActiveList, setViewFilter, onItemSelect],
  );

  const handleListClick = useCallback(
    (list: TodoList) => {
      if (filter.view !== 'all') {
        setActiveList(list.id);
        setViewFilter('all');
      } else {
        setActiveList(list.id);
      }
      onItemSelect?.();
    },
    [filter.view, setActiveList, setViewFilter, onItemSelect],
  );

  const startRename = useCallback((list: TodoList) => {
    setRenamingListId(list.id);
    setRenameValue(list.title);
  }, []);

  const commitRename = useCallback(async () => {
    const id = renamingListId;
    const trimmed = renameValue.trim();
    setRenamingListId(null);
    if (!id) return;
    const original = lists.find((l) => l.id === id);
    if (!trimmed || !original || trimmed === original.title) return;
    await updateList(id, trimmed);
  }, [renamingListId, renameValue, lists, updateList]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') void commitRename();
      if (e.key === 'Escape') setRenamingListId(null);
    },
    [commitRename],
  );

  const filteredLists = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter((l) => l.title.toLowerCase().includes(q));
  }, [lists, searchQuery]);

  const widthClass = isSmallScreen ? 'w-full' : 'w-full';

  return (
    <aside
      role="navigation"
      // 统一抽屉内不挂 navigation 层背景：抽屉整体是 bg-background，
      // 再叠 --shell-navigation-surface 会形成"页内工具灰底 + 应用导航白底"的割裂色带
      data-shell-layer={unifiedDrawer ? undefined : 'navigation'}
      className={cn(
        'font-sidebar-study-ui relative flex min-h-0 min-w-0 flex-shrink-0 flex-col',
        unifiedDrawer ? 'overflow-visible' : 'h-full overflow-hidden',
        'text-[color:var(--shell-navigation-foreground)]',
        'transition-colors duration-300',
        widthClass,
      )}
    >
      {/* 头部：搜索（可折叠） */}
      <div className="shrink-0 px-2 pb-2 pt-3">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--shell-navigation-muted)]" size={14} />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('todo:actions.searchLists', '搜索列表...')}
            className={cn(
              'h-8 w-full rounded-[var(--radius-shell-control)] border border-transparent',
              'bg-[color:var(--interactive-hover)]/60 pl-8 pr-8 text-[13px] text-[color:var(--shell-navigation-foreground)]',
              'outline-none placeholder:text-[color:var(--shell-navigation-muted)]',
              'focus:border-[color:var(--shell-navigation-border)] focus:bg-[color:var(--interactive-hover)]',
              'transition-colors',
            )}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[color:var(--shell-navigation-muted)] transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]"
              aria-label={t('common:actions.clear')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 智能视图 */}
      <div className="shrink-0 px-2 pb-1">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="desktop-shell-nav-section-label min-w-0 truncate">
            {t('todo:sections.smartViews')}
          </span>
        </div>
        <div className="space-y-0.5">
          {SMART_VIEWS.map(({ id, icon: Icon, labelKey }) => {
            const isActive =
              filter.view === id && (id !== 'all' || activeListId === null);
            const showOverdueBadge = id === 'overdue' && overdueCount > 0;
            return (
              <NavRow
                key={id}
                isActive={isActive}
                onClick={() => handleSmartViewClick(id)}
                leftSlot={<Icon size={18} weight="bold" />}
                rightSlot={
                  showOverdueBadge ? (
                    <span
                      aria-label={t('todo:overdue.badgeAria', { count: overdueCount })}
                      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color:hsl(var(--destructive))] px-1 text-[10px] font-semibold leading-none text-white"
                    >
                      {overdueCount > 99 ? '99+' : overdueCount}
                    </span>
                  ) : undefined
                }
              >
                {t(labelKey)}
              </NavRow>
            );
          })}
        </div>
      </div>

      {/* 列表 */}
      <div className={cn('flex min-h-0 flex-col px-2 pb-2', unifiedDrawer ? '' : 'flex-1 overflow-hidden')}>
        <div className="group/list-header flex items-center justify-between px-2 py-1">
          <span className="desktop-shell-nav-section-label min-w-0 truncate">
            {t('todo:sections.lists')}
          </span>
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            aria-label={t('todo:actions.newList', '新建列表')}
            title={t('todo:actions.newList', '新建列表')}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-md',
              'text-[color:var(--shell-navigation-muted)] opacity-0 transition-opacity',
              'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
              'group-hover/list-header:opacity-100 focus-visible:opacity-100',
            )}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className={cn(unifiedDrawer ? '' : 'min-h-0 flex-1 overflow-y-auto')}>
          {/* 新建列表输入 */}
          {isCreating && (
            <div className="px-0.5 pb-1">
              <Input
                autoFocus
                value={newListTitle}
                onChange={(e) => setNewListTitle(e.target.value)}
                onKeyDown={handleCreateKeyDown}
                onBlur={() => {
                  if (!newListTitle.trim()) setIsCreating(false);
                }}
                placeholder={t('todo:actions.newListPlaceholder')}
                className={cn(
                  'h-8 w-full rounded-[var(--radius-shell-control)] border',
                  'border-[color:var(--shell-navigation-border)]',
                  'bg-[color:var(--interactive-hover)] px-2.5 text-[13px]',
                  'text-[color:var(--shell-navigation-foreground)]',
                  'outline-none placeholder:text-[color:var(--shell-navigation-muted)]',
                )}
              />
            </div>
          )}

          <div className="space-y-0.5">
            {filteredLists.map((list) => {
              const isActive = activeListId === list.id && filter.view === 'all';

              // 行内重命名态
              if (renamingListId === list.id) {
                return (
                  <div key={list.id} className="px-0.5 py-0.5">
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={() => void commitRename()}
                      aria-label={t('todo:actions.renameList')}
                      className={cn(
                        'h-8 w-full rounded-[var(--radius-shell-control)] border',
                        'border-[color:var(--shell-navigation-border)]',
                        'bg-[color:var(--interactive-hover)] px-2.5 text-[13px]',
                        'text-[color:var(--shell-navigation-foreground)]',
                        'outline-none',
                      )}
                    />
                  </div>
                );
              }

              return (
                <div key={list.id} className="group/list-item relative">
                  <NavRow
                    isActive={isActive}
                    onClick={() => handleListClick(list)}
                    onDoubleClick={() => {
                      if (!list.isDefault) startRename(list);
                    }}
                    leftSlot={
                      list.isDefault ? (
                        <Tray size={18} weight="bold" />
                      ) : list.color ? (
                        <span
                          className="size-[10px] rounded-full"
                          style={{ backgroundColor: list.color }}
                        />
                      ) : (
                        <CheckSquare size={18} weight="bold" />
                      )
                    }
                    rightSlot={
                      list.isFavorite ? (
                        <Star
                          size={14}
                          className="fill-[color:hsl(var(--warning))] text-[color:hsl(var(--warning))]"
                          aria-hidden
                        />
                      ) : undefined
                    }
                  >
                    {list.title}
                  </NavRow>
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-y-0 right-1.5 z-[1] flex items-center gap-0.5 opacity-0 transition-opacity',
                      'group-hover/list-item:pointer-events-auto group-hover/list-item:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleListFavorite(list.id);
                      }}
                      aria-label={
                        list.isFavorite
                          ? t('todo:actions.unfavorite')
                          : t('todo:actions.favorite')
                      }
                      title={
                        list.isFavorite
                          ? t('todo:actions.unfavorite')
                          : t('todo:actions.favorite')
                      }
                      className="flex h-5 w-5 items-center justify-center rounded-md text-[color:var(--shell-navigation-muted)] transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]"
                    >
                      <Star
                        size={12}
                        className={cn(
                          list.isFavorite &&
                            'fill-[color:hsl(var(--warning))] text-[color:hsl(var(--warning))]',
                        )}
                      />
                    </button>
                    {!list.isDefault && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(list);
                          }}
                          aria-label={t('todo:actions.renameList')}
                          title={t('todo:actions.renameList')}
                          className="flex h-5 w-5 items-center justify-center rounded-md text-[color:var(--shell-navigation-muted)] transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]"
                        >
                          <PencilSimple size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteList(list);
                          }}
                          aria-label={t('common:actions.delete')}
                          title={t('common:actions.delete')}
                          className="flex h-5 w-5 items-center justify-center rounded-md text-[color:var(--shell-navigation-muted)] transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:hsl(var(--destructive))]"
                        >
                          <Trash size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredLists.length === 0 && !isCreating && (
              <div className="px-2 py-6 text-center text-[12px] text-[color:var(--shell-navigation-muted)]">
                {searchQuery
                  ? t('todo:empty.noMatchingLists', '没有匹配的列表')
                  : t('todo:empty.noLists', '暂无列表')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部：回收站入口（统一抽屉内不加分割线，与其他页抽屉保持一致的纯分区节奏） */}
      <div className={cn('shrink-0 px-2 py-1.5', !unifiedDrawer && 'border-t border-[color:var(--shell-navigation-border)]')}>
        <NavRow
          isActive={false}
          onClick={() => setTrashOpen(true)}
          leftSlot={<Trash size={18} weight="bold" />}
        >
          {t('todo:trash.title')}
        </NavRow>
      </div>

      {/* 回收站对话框 */}
      <TodoTrashDialog open={trashOpen} onOpenChange={setTrashOpen} />

      {/* 删除清单确认 */}
      <NotionAlertDialog
        open={pendingDeleteList !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteList(null);
        }}
        title={t('todo:dialogs.deleteList.title')}
        description={t('todo:dialogs.deleteList.description', {
          title: pendingDeleteList?.title ?? '',
        })}
        confirmText={t('common:actions.delete')}
        cancelText={t('common:actions.cancel')}
        onConfirm={() => {
          if (pendingDeleteList) void deleteList(pendingDeleteList.id);
          setPendingDeleteList(null);
        }}
      />
    </aside>
  );
};
