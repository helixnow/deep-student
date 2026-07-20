/**
 * TodoSidebar - 待办侧边栏
 *
 * 作为 Shell 导航栏的内容，由 TodoShellSidebar 包裹后替换主导航。
 * - 使用 .desktop-shell-nav-row / --active 行样式（32px 高，14px 圆角，14px 字号，扁平）
 * - 使用 .desktop-shell-nav-section-label 分组标签（12px 淡色）
 * - 行间距 space-y-0.5，行内图标 18px + 10px 间距
 * - 收藏清单置顶分组；清单行支持拖拽排序（组内）
 * - 清单行更多操作整合进 AppMenu（重命名/颜色/收藏/删除）
 * - 删除清单与回收站均为行内二次确认，不再使用 AlertDialog
 * - 桌面端回收站为主内容区内联视图（useTodoTrashView 协调）
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
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
  Robot,
  DotsThree,
} from '@phosphor-icons/react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import { cn } from '@/lib/utils';
import { WorkbenchSidebarRow, WorkbenchSidebarRowLabel } from '@/features/workbench/components/sidebar';
import { Input } from '@/components/ui/shad/Input';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuLabel,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { useMobileUnifiedDrawer } from '@/components/layout/MobileDrawerContext';
import { useTodoStore } from '../stores/useTodoStore';
import { updateTodoList as updateTodoListApi } from '../api';
import { useTodoTrashView } from './TodoTrashDialog';
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

/**
 * 清单颜色可选值。注意：这些是持久化到 list.color 字段的数据值
 * （与既有 `style={{ backgroundColor: list.color }}` 渲染契约一致），
 * 不是主题样式 token。
 */
const LIST_COLOR_OPTIONS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#0ea5e9',
  '#6366f1',
  '#a855f7',
  '#ec4899',
];

// ============================================================================
// 与 ModernSidebar 保持一致的行样式原语
// ============================================================================

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
  <WorkbenchSidebarRow
    rowType="nav"
    isActive={isActive}
    className={cn(unifiedDrawer && 'min-h-[2.75rem]', className)}
    leftSlot={leftSlot}
    rightSlot={rightSlot}
    {...rest}
  >
    <WorkbenchSidebarRowLabel>{children}</WorkbenchSidebarRowLabel>
  </WorkbenchSidebarRow>
  );
};

/** 侧栏行内小图标按钮（hover 显隐的次要操作） */
const rowIconButtonClass = cn(
  'flex h-5 w-5 items-center justify-center rounded-md',
  'text-[color:var(--shell-navigation-muted)] transition-colors duration-150',
  'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
);

// ============================================================================
// SortableListRow — 清单行拖拽包装（组内排序）
// ============================================================================

const SortableListRow: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ id, disabled, children }) => {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'relative z-10 opacity-70')}
      {...listeners}
    >
      {children}
    </div>
  );
};

// ============================================================================
// TodoSidebar
// ============================================================================

interface TodoSidebarProps {
  /** 移动端点击列表后回调（用于关闭滑动侧栏） */
  onItemSelect?: () => void;
  /**
   * 外部承载回收站时传入（移动端 inline 子屏）。
   * 提供后点击回收站交给宿主页面全屏展示；
   * 未提供时（桌面 Shell）切换主内容区的内联回收站视图。
   */
  onOpenTrash?: () => void;
}

export const TodoSidebar: React.FC<TodoSidebarProps> = ({ onItemSelect, onOpenTrash }) => {
  const { t } = useTranslation(['todo', 'common']);
  const unifiedDrawer = useMobileUnifiedDrawer();
  const {
    lists,
    activeListId,
    filter,
    overdueCount,
    workspaceView,
    setWorkspaceView,
    setActiveList,
    setViewFilter,
    createList,
    updateList,
    deleteList,
    toggleListFavorite,
    reorderLists,
  } = useTodoStore();

  // 桌面端内联回收站视图（Shell 侧栏与内容区分属不同挂载点，经共享 store 协调）
  const trashViewOpen = useTodoTrashView((s) => s.isOpen);
  const openTrashView = useTodoTrashView((s) => s.open);
  const closeTrashView = useTodoTrashView((s) => s.close);
  const trashActive = !onOpenTrash && trashViewOpen;

  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // 行内重命名状态
  const [renamingListId, setRenamingListId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 行内删除二次确认
  const [pendingDeleteListId, setPendingDeleteListId] = useState<string | null>(null);
  // 行内更多操作菜单（同一时刻仅一个打开）
  const [menuListId, setMenuListId] = useState<string | null>(null);

  const sensors = useTouchFriendlyDndSensors();

  // ===== 回调 =====
  // Enter 提交后输入框失焦仍会触发 blur 提交，用 in-flight 守卫防止重复创建
  const creatingListRef = useRef(false);
  const handleCreateList = useCallback(async () => {
    if (creatingListRef.current) return;
    const trimmed = newListTitle.trim();
    if (!trimmed) {
      setIsCreating(false);
      setNewListTitle('');
      return;
    }
    creatingListRef.current = true;
    try {
      const list = await createList(trimmed);
      setNewListTitle('');
      setIsCreating(false);
      closeTrashView();
      setActiveList(list.id);
      setViewFilter('all');
      onItemSelect?.();
    } catch {
      // error handled in store
    } finally {
      creatingListRef.current = false;
    }
  }, [newListTitle, createList, closeTrashView, setActiveList, setViewFilter, onItemSelect]);

  const handleCreateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') void handleCreateList();
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
      closeTrashView();
      setPendingDeleteListId(null);
      setWorkspaceView('todos');
      setViewFilter(view);
      onItemSelect?.();
    },
    [lists, closeTrashView, setActiveList, setViewFilter, setWorkspaceView, onItemSelect],
  );

  const handleListClick = useCallback(
    (list: TodoList) => {
      closeTrashView();
      setPendingDeleteListId(null);
      setWorkspaceView('todos');
      if (filter.view !== 'all') {
        setActiveList(list.id);
        setViewFilter('all');
      } else {
        setActiveList(list.id);
      }
      onItemSelect?.();
    },
    [filter.view, closeTrashView, setActiveList, setViewFilter, setWorkspaceView, onItemSelect],
  );

  const startRename = useCallback((list: TodoList) => {
    setPendingDeleteListId(null);
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

  // 改色：store 的 updateList 尚未暴露 color 参数，走 API 后经 loadLists 回写
  // （与 TodoMainPanel 批量改期直接调 API 的既有模式一致）
  const setListColor = useCallback(async (listId: string, color: string) => {
    try {
      await updateTodoListApi({ id: listId, color });
      await useTodoStore.getState().loadLists();
    } catch {
      // 失败静默：颜色属增强信息，下次 loadLists 会回到后端真实状态
    }
  }, []);

  // ===== 清单分组：收件箱由智能视图承载，收藏置顶，其余按 sortOrder =====
  const defaultList = useMemo(() => lists.find((l) => l.isDefault) ?? null, [lists]);

  const filteredLists = useMemo(() => {
    const nonDefault = lists.filter((l) => !l.isDefault);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return nonDefault;
    return nonDefault.filter((l) => l.title.toLowerCase().includes(q));
  }, [lists, searchQuery]);

  const favoriteLists = useMemo(
    () => filteredLists.filter((l) => l.isFavorite),
    [filteredLists],
  );
  const regularLists = useMemo(
    () => filteredLists.filter((l) => !l.isFavorite),
    [filteredLists],
  );

  // 搜索中列表是子集，禁用拖拽避免生成残缺的顺序
  const dragEnabled = !searchQuery.trim();

  const handleListDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const favoriteIds = favoriteLists.map((l) => l.id);
      const regularIds = regularLists.map((l) => l.id);
      const inFavorites = favoriteIds.includes(activeId);
      const groupIds = inFavorites ? favoriteIds : regularIds;
      // 仅支持组内排序（收藏组与普通组各自独立）
      if (!groupIds.includes(overId)) return;
      const from = groupIds.indexOf(activeId);
      const to = groupIds.indexOf(overId);
      if (from < 0 || to < 0) return;
      const reordered = [...groupIds];
      reordered.splice(to, 0, ...reordered.splice(from, 1));
      const orderedIds = [
        ...(defaultList ? [defaultList.id] : []),
        ...(inFavorites ? reordered : favoriteIds),
        ...(inFavorites ? regularIds : reordered),
      ];
      void reorderLists(orderedIds);
    },
    [favoriteLists, regularLists, defaultList, reorderLists],
  );

  // ===== 单条清单行 =====
  const renderListRow = (list: TodoList) => {
    const isActive =
      workspaceView === 'todos' && !trashActive && activeListId === list.id && filter.view === 'all';

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

    // 行内删除二次确认条（250ms 展开，替代 AlertDialog；删除后 store 弹撤销 toast）
    if (pendingDeleteListId === list.id) {
      return (
        <div key={list.id} className="px-0.5 py-0.5">
          <div
            className={cn(
              'ui-zoom-fade-in flex min-h-8 items-center gap-1.5',
              'rounded-[var(--radius-shell-control)] bg-[color:var(--interactive-hover)] px-2 py-1',
            )}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPendingDeleteListId(null);
            }}
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--shell-navigation-foreground)]">
              {t('todo:dialogs.deleteList.inlineConfirm', { title: list.title })}
            </span>
            <button
              type="button"
              autoFocus
              onClick={() => {
                setPendingDeleteListId(null);
                void deleteList(list.id);
              }}
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium',
                'text-[color:hsl(var(--destructive))] transition-colors duration-150',
                'hover:bg-[color:var(--button-danger-surface,var(--interactive-hover))]',
              )}
            >
              {t('common:actions.delete')}
            </button>
            <button
              type="button"
              onClick={() => setPendingDeleteListId(null)}
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-[12px]',
                'text-[color:var(--shell-navigation-muted)] transition-colors duration-150',
                'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
              )}
            >
              {t('common:actions.cancel')}
            </button>
          </div>
        </div>
      );
    }

    const menuOpen = menuListId === list.id;

    return (
      <SortableListRow key={list.id} id={list.id} disabled={!dragEnabled}>
        <div className="group/list-item relative">
          <NavRow
            isActive={isActive}
            onClick={() => handleListClick(list)}
            onDoubleClick={() => startRename(list)}
            leftSlot={
              list.color ? (
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
              'pointer-events-none absolute inset-y-0 right-1.5 z-[1] flex items-center gap-0.5 opacity-0 transition-opacity duration-150',
              'group-hover/list-item:pointer-events-auto group-hover/list-item:opacity-100',
              'focus-within:pointer-events-auto focus-within:opacity-100',
              menuOpen && 'pointer-events-auto opacity-100',
            )}
          >
            <AppMenu
              open={menuOpen}
              onOpenChange={(open) => setMenuListId(open ? list.id : null)}
            >
              <AppMenuTrigger
                aria-label={t('todo:sidebar.moreActions')}
                title={t('todo:sidebar.moreActions')}
                onClick={(e) => e.stopPropagation()}
                className={rowIconButtonClass}
              >
                <DotsThree size={16} weight="bold" />
              </AppMenuTrigger>
              <AppMenuContent align="end" width={208}>
                <AppMenuItem
                  icon={<PencilSimple size={15} />}
                  onClick={() => startRename(list)}
                >
                  {t('todo:actions.renameList')}
                </AppMenuItem>
                <AppMenuItem
                  icon={
                    <Star
                      size={15}
                      weight={list.isFavorite ? 'fill' : 'regular'}
                      className={cn(list.isFavorite && 'text-[color:hsl(var(--warning))]')}
                    />
                  }
                  onClick={() => void toggleListFavorite(list.id)}
                >
                  {list.isFavorite ? t('todo:actions.unfavorite') : t('todo:actions.favorite')}
                </AppMenuItem>
                <AppMenuSeparator />
                <AppMenuLabel>{t('todo:sidebar.listColor')}</AppMenuLabel>
                <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-0.5" role="group">
                  {LIST_COLOR_OPTIONS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`${t('todo:sidebar.listColor')} ${color}`}
                      title={color}
                      onClick={() => {
                        setMenuListId(null);
                        void setListColor(list.id, color);
                      }}
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors duration-150',
                        list.color === color
                          ? 'border-[color:var(--shell-navigation-foreground)]'
                          : 'border-transparent hover:border-[color:var(--shell-navigation-border)]',
                      )}
                    >
                      <span
                        className="size-[12px] rounded-full"
                        style={{ backgroundColor: color }}
                      />
                    </button>
                  ))}
                </div>
                <AppMenuSeparator />
                <AppMenuItem
                  destructive
                  icon={<Trash size={15} />}
                  onClick={() => setPendingDeleteListId(list.id)}
                >
                  {t('common:actions.delete')}
                </AppMenuItem>
              </AppMenuContent>
            </AppMenu>
          </div>
        </div>
      </SortableListRow>
    );
  };

  return (
    <aside
      role="navigation"
      data-todo-shell-sidebar
      // 统一抽屉内不挂 navigation 层背景：抽屉整体是 bg-background，
      // 再叠 --shell-navigation-surface 会形成"页内工具灰底 + 应用导航白底"的割裂色带
      data-shell-layer={unifiedDrawer ? undefined : 'navigation'}
      className={cn(
        'font-sidebar-study-ui relative flex min-h-0 w-full min-w-0 flex-shrink-0 flex-col',
        unifiedDrawer ? 'overflow-visible' : 'h-full overflow-hidden',
        'text-[color:var(--shell-navigation-foreground)]',
        'transition-colors duration-300',
      )}
    >
      {/* 头部：搜索（可折叠） */}
      <div className="shrink-0 px-2 pb-2 pt-3">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--shell-navigation-muted)]" size={14} />
          <Input
            type="search"
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
            // 收件箱语义 = 默认清单的 all 视图（默认清单不再重复出现在列表区）
            const isActive =
              workspaceView === 'todos' &&
              !trashActive &&
              filter.view === id &&
              (id !== 'all' || activeListId === null || activeListId === defaultList?.id);
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
                      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color:hsl(var(--destructive))] px-1 text-[10px] font-semibold leading-none tabular-nums text-white"
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
          <NavRow
            isActive={workspaceView === 'automations' && !trashActive}
            onClick={() => {
              closeTrashView();
              setWorkspaceView('automations');
              onItemSelect?.();
            }}
            leftSlot={<Robot size={18} weight="duotone" />}
          >
            {t('todo:automation.title', '定时任务')}
          </NavRow>
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
              'text-[color:var(--shell-navigation-muted)] opacity-0 transition-opacity duration-150',
              'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
              'group-hover/list-header:opacity-100 focus-visible:opacity-100',
              // 触屏无 hover：常显，否则新建入口不可发现
              '[@media(pointer:coarse)]:opacity-100',
            )}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className={cn(unifiedDrawer ? '' : 'min-h-0 flex-1 overflow-y-auto')}>
          {/* 新建列表输入（有内容时失焦即提交，避免丢输入） */}
          {isCreating && (
            <div className="px-0.5 pb-1">
              <Input
                autoFocus
                value={newListTitle}
                onChange={(e) => setNewListTitle(e.target.value)}
                onKeyDown={handleCreateKeyDown}
                onBlur={() => void handleCreateList()}
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

          <DndContext
            sensors={sensors}
            autoScroll={SHELL_SAFE_AUTO_SCROLL}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleListDragEnd}
          >
            {/* 收藏清单置顶分组 */}
            {favoriteLists.length > 0 && (
              <>
                <div className="flex items-center px-2 pb-1 pt-0.5">
                  <span className="desktop-shell-nav-section-label min-w-0 truncate">
                    {t('todo:sections.favorites')}
                  </span>
                </div>
                <SortableContext
                  items={favoriteLists.map((l) => l.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-0.5 pb-1.5">
                    {favoriteLists.map(renderListRow)}
                  </div>
                </SortableContext>
              </>
            )}

            <SortableContext
              items={regularLists.map((l) => l.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-0.5">
                {regularLists.map(renderListRow)}
              </div>
            </SortableContext>
          </DndContext>

          {filteredLists.length === 0 && !isCreating && (
            <div className="px-2 py-6 text-center text-[12px] text-[color:var(--shell-navigation-muted)]">
              {searchQuery
                ? t('todo:empty.noMatchingLists', '没有匹配的列表')
                : t('todo:empty.noLists', '暂无列表')}
            </div>
          )}
        </div>
      </div>

      {/* 底部：回收站入口（统一抽屉内不加分割线，与其他页抽屉保持一致的纯分区节奏） */}
      <div className={cn('shrink-0 px-2 py-1.5', !unifiedDrawer && 'border-t border-[color:var(--shell-navigation-border)]')}>
        <NavRow
          isActive={trashActive}
          onClick={() => {
            if (onOpenTrash) {
              onOpenTrash();
            } else {
              openTrashView();
            }
          }}
          leftSlot={<Trash size={18} weight="bold" />}
        >
          {t('todo:trash.title')}
        </NavRow>
      </div>
    </aside>
  );
};
