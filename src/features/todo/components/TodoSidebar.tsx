/**
 * TodoSidebar - 待办侧边栏
 *
 * 作为 Shell 导航栏的内容，由 TodoShellSidebar 包裹后替换主导航。
 * - 使用 .desktop-shell-nav-row / --active 行样式（32px 高，14px 圆角，14px 字号，扁平）
 * - 使用 .desktop-shell-nav-section-label 分组标签（12px 淡色）
 * - 行间距 space-y-0.5，行内图标 18px + 10px 间距
 * - 计数徽标：智能视图（今天/计划/收件箱）与每个清单显示 pending 计数（中性灰），
 *   逾期视图沿用红色徽标；数据来自 useTodoStore.counts（F1 契约，null 容错）
 * - 分区折叠：智能视图 / 收藏 / 列表 标题可折叠（chevron 旋转 + grid 0fr↔1fr 动画），
 *   折叠态持久化到 localStorage（todo-sidebar-collapsed-sections）
 * - 收藏清单置顶分组；清单行支持拖拽排序（组内），精细指针经显式拖拽把手，
 *   触屏保留整行长按；跨组拖拽 = 切换收藏状态（toggleListFavorite）
 * - 清单行更多操作整合进 AppMenu（重命名/颜色/图标/收藏/删除）
 * - 删除清单与回收站均为行内二次确认，不再使用 AlertDialog
 * - 桌面端回收站为主内容区内联视图（useTodoTrashView 协调）
 * - 键盘导航：侧栏内 ↑/↓/Home/End 在可见导航行间移动焦点（roving focus），
 *   ⌘/Ctrl+1..8 跳转视图（todoShellNav 统一注册，多宿主去重）
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
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
  DotsSixVertical,
  CaretRight,
  Eraser,
  ListChecks,
  BookOpen,
  GraduationCap,
  Briefcase,
  Flag,
  Heart,
  Lightbulb,
  ShoppingCart,
  AirplaneTilt,
  MusicNotes,
  Barbell,
  Coffee,
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
import { useTodoTrashView } from './TodoTrashDialog';
import { useTodoViewHotkeys, todoHotkeyHint, TODO_SMART_VIEW_ORDER } from './todoShellNav';
import type { TodoList, TodoViewFilter } from '../types';

interface SmartView {
  id: TodoViewFilter;
  icon: React.ElementType;
  labelKey: string;
}

/** 各智能视图的图标与文案（顺序的单一来源是 todoShellNav 的 TODO_SMART_VIEW_ORDER） */
const SMART_VIEW_CONFIG: Record<TodoViewFilter, Omit<SmartView, 'id'>> = {
  all: { icon: Tray, labelKey: 'todo:views.inbox' },
  today: { icon: Calendar, labelKey: 'todo:views.today' },
  upcoming: { icon: Clock, labelKey: 'todo:views.upcoming' },
  matrix: { icon: SquaresFour, labelKey: 'todo:views.matrix' },
  overdue: { icon: Warning, labelKey: 'todo:views.overdue' },
  completed: { icon: CheckSquare, labelKey: 'todo:views.completed' },
};

/** 渲染顺序直接派生自热键顺序，1..6 的键帽提示与行顺序永不分叉 */
export const SMART_VIEWS: SmartView[] = TODO_SMART_VIEW_ORDER.map((id) => ({
  id,
  ...SMART_VIEW_CONFIG[id],
}));

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

/**
 * 清单图标可选值。id 持久化到 list.color 同级的 list.icon 字段
 * （后端 update_list 三态语义：Some("") 清空回 NULL）。
 * 'inbox' 为后端 ensure_inbox 种下的默认清单图标，一并纳入渲染映射。
 */
const LIST_ICON_OPTIONS: Array<{ id: string; icon: React.ElementType }> = [
  { id: 'list-checks', icon: ListChecks },
  { id: 'book', icon: BookOpen },
  { id: 'graduation-cap', icon: GraduationCap },
  { id: 'briefcase', icon: Briefcase },
  { id: 'flag', icon: Flag },
  { id: 'heart', icon: Heart },
  { id: 'lightbulb', icon: Lightbulb },
  { id: 'shopping-cart', icon: ShoppingCart },
  { id: 'airplane', icon: AirplaneTilt },
  { id: 'music', icon: MusicNotes },
  { id: 'barbell', icon: Barbell },
  { id: 'coffee', icon: Coffee },
];

const LIST_ICON_BY_ID = new Map<string, React.ElementType>([
  ...LIST_ICON_OPTIONS.map(({ id, icon }): [string, React.ElementType] => [id, icon]),
  ['inbox', Tray] as [string, React.ElementType],
]);

/** 清单行左侧图形：图标（可染清单色）> 颜色圆点 > 默认 CheckSquare */
export const TodoListGlyph: React.FC<{ list: TodoList; size?: number }> = ({ list, size = 18 }) => {
  const IconComp = list.icon ? LIST_ICON_BY_ID.get(list.icon) : undefined;
  if (IconComp) {
    return (
      <IconComp
        size={size}
        weight="regular"
        style={list.color ? { color: list.color } : undefined}
      />
    );
  }
  if (list.color) {
    return (
      <span
        className="rounded-full"
        style={{ width: size * 0.55, height: size * 0.55, backgroundColor: list.color }}
      />
    );
  }
  return <CheckSquare size={size} weight="regular" />;
};

// ============================================================================
// 分区折叠（localStorage 持久化）
// ============================================================================

const COLLAPSED_SECTIONS_KEY = 'todo-sidebar-collapsed-sections';

type SidebarSectionId = 'smartViews' | 'favorites' | 'lists';

function readCollapsedSections(): Partial<Record<SidebarSectionId, boolean>> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Partial<Record<SidebarSectionId, boolean>>;
  } catch {
    return {};
  }
}

/** 分区标题：label 点击折叠，chevron hover 显现并旋转（coarse 常显） */
const SectionHeader: React.FC<{
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  controlsId: string;
  action?: React.ReactNode;
  className?: string;
}> = ({ label, collapsed, onToggle, controlsId, action, className }) => (
  <div className={cn('group/todo-section flex items-center justify-between px-2 py-1', className)}>
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1 rounded-md text-left outline-none',
        'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
        '[@media(pointer:coarse)]:min-h-[2.75rem]',
      )}
    >
      <span className="desktop-shell-nav-section-label min-w-0 truncate">{label}</span>
      <CaretRight
        size={12}
        weight="bold"
        aria-hidden
        className={cn(
          'shrink-0 text-[color:var(--shell-navigation-muted)] opacity-0',
          'transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          'group-hover/todo-section:opacity-100 group-focus-within/todo-section:opacity-100',
          '[@media(pointer:coarse)]:opacity-100',
          !collapsed && 'rotate-90',
        )}
      />
    </button>
    {action}
  </div>
);

/** 分区内容：grid-template-rows 0fr↔1fr 折叠动画（motion-reduce 直切） */
const CollapsibleBody: React.FC<React.PropsWithChildren<{
  id: string;
  collapsed: boolean;
  className?: string;
  innerClassName?: string;
}>> = ({ id, collapsed, className, innerClassName, children }) => (
  <div
    id={id}
    aria-hidden={collapsed || undefined}
    className={cn(
      'grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
      collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
      className,
    )}
  >
    <div className={cn('min-h-0 overflow-hidden', collapsed && 'pointer-events-none', innerClassName)}>
      {children}
    </div>
  </div>
);

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
    aria-current={isActive ? 'page' : undefined}
    data-todo-nav-row=""
    className={cn(unifiedDrawer && 'min-h-[2.75rem]', className)}
    leftSlot={leftSlot}
    rightSlot={rightSlot}
    {...rest}
  >
    <WorkbenchSidebarRowLabel>{children}</WorkbenchSidebarRowLabel>
  </WorkbenchSidebarRow>
  );
};

/** 侧栏行内小图标按钮（hover 显隐的次要操作；触屏常显并放大命中区） */
const rowIconButtonClass = cn(
  'flex h-5 w-5 items-center justify-center rounded-md',
  'text-[color:var(--shell-navigation-muted)] transition-colors duration-150',
  'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
  '[@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10',
);

/** 中性灰 pending 计数（Things 式纯数字，>0 才显示，由调用方保证） */
const PendingCountBadge: React.FC<{ count: number; ariaLabel: string }> = ({ count, ariaLabel }) => (
  <span
    aria-label={ariaLabel}
    className="text-xs font-medium leading-none tabular-nums text-[color:var(--shell-navigation-muted)]"
  >
    {count > 999 ? '999+' : count}
  </span>
);

// ============================================================================
// TodoListRow — 清单行（排序拖拽 + hover 操作簇 + 计数/收藏徽标）
// ============================================================================

interface TodoListRowProps {
  list: TodoList;
  isActive: boolean;
  dragEnabled: boolean;
  /**
   * coarse 指针（触屏）没有 hover，把手不可发现——沿用整行长按拖拽；
   * 精细指针把 listeners 收敛到显式把手，避免与点击/双击/菜单冲突。
   */
  rowDragListeners: boolean;
  pendingCount: number | null;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onSelect: () => void;
  onStartRename: () => void;
  onToggleFavorite: () => void;
  onSetColor: (color: string | null) => void;
  onSetIcon: (icon: string | null) => void;
  onRequestDelete: () => void;
}

const TodoListRow: React.FC<TodoListRowProps> = ({
  list,
  isActive,
  dragEnabled,
  rowDragListeners,
  pendingCount,
  menuOpen,
  onMenuOpenChange,
  onSelect,
  onStartRename,
  onToggleFavorite,
  onSetColor,
  onSetIcon,
  onRequestDelete,
}) => {
  const { t } = useTranslation(['todo', 'common']);
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: list.id, disabled: !dragEnabled });

  const countValue = typeof pendingCount === 'number' && pendingCount > 0 ? pendingCount : null;
  const showStar = list.isFavorite;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group/list-item relative', isDragging && 'z-10 opacity-70')}
      {...(rowDragListeners && dragEnabled ? listeners : undefined)}
    >
      <NavRow
        isActive={isActive}
        onClick={onSelect}
        onDoubleClick={onStartRename}
        leftSlot={<TodoListGlyph list={list} />}
        rightSlot={
          countValue !== null || showStar ? (
            // hover / 菜单打开时淡出，把占位让给操作簇（修复星标与 ⋯ 按钮重叠）；
            // 触屏操作簇常显：徽标左移让出 ⋯ 按钮的位置，两者并存不重叠
            <span
              aria-hidden={menuOpen || undefined}
              className={cn(
                'flex items-center gap-1 transition-opacity duration-150',
                'group-hover/list-item:opacity-0 group-focus-within/list-item:opacity-0',
                '[@media(pointer:coarse)]:mr-10',
                menuOpen && 'opacity-0',
              )}
            >
              {countValue !== null && (
                <PendingCountBadge
                  count={countValue}
                  ariaLabel={t('todo:sidebar.pendingBadgeAria', { count: countValue })}
                />
              )}
              {showStar && (
                <Star
                  size={13}
                  weight="fill"
                  className="text-[color:hsl(var(--warning))]"
                  aria-hidden
                />
              )}
            </span>
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
          // 触屏无 hover：⋯ 菜单常显，否则重命名/收藏/删除等操作不可达
          '[@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100',
          menuOpen && 'pointer-events-auto opacity-100',
        )}
      >
        {dragEnabled && !rowDragListeners && (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...listeners}
            aria-label={t('todo:sidebar.dragHandle')}
            title={t('todo:sidebar.dragHandle')}
            className={cn(rowIconButtonClass, 'cursor-grab touch-none active:cursor-grabbing')}
          >
            <DotsSixVertical size={14} weight="bold" />
          </button>
        )}
        <AppMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
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
              onClick={onStartRename}
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
              onClick={onToggleFavorite}
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
                    onMenuOpenChange(false);
                    onSetColor(color);
                  }}
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors duration-150 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
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
            {list.color ? (
              <AppMenuItem
                icon={<Eraser size={15} />}
                onClick={() => onSetColor(null)}
              >
                {t('todo:sidebar.clearColor')}
              </AppMenuItem>
            ) : null}
            <AppMenuSeparator />
            <AppMenuLabel>{t('todo:sidebar.listIcon')}</AppMenuLabel>
            <div className="grid grid-cols-4 gap-1 px-3 pb-2 pt-0.5 sm:grid-cols-6" role="group">
              {LIST_ICON_OPTIONS.map(({ id, icon: IconOption }) => (
                <button
                  key={id}
                  type="button"
                  aria-label={`${t('todo:sidebar.listIcon')} ${id}`}
                  aria-pressed={list.icon === id}
                  title={id}
                  onClick={() => {
                    onMenuOpenChange(false);
                    onSetIcon(id);
                  }}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
                    list.icon === id
                      ? 'bg-[color:var(--interactive-selected)] text-foreground'
                      : 'text-muted-foreground hover:bg-[color:var(--interactive-hover)] hover:text-foreground',
                  )}
                >
                  <IconOption size={14} weight="bold" />
                </button>
              ))}
            </div>
            {list.icon ? (
              <AppMenuItem
                icon={<Eraser size={15} />}
                onClick={() => onSetIcon(null)}
              >
                {t('todo:sidebar.clearIcon')}
              </AppMenuItem>
            ) : null}
            <AppMenuSeparator />
            <AppMenuItem
              destructive
              icon={<Trash size={15} />}
              onClick={onRequestDelete}
            >
              {t('common:actions.delete')}
            </AppMenuItem>
          </AppMenuContent>
        </AppMenu>
      </div>
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

  // 计数快照（后端未落地/查询失败时保持 null，全部徽标静默隐藏）
  const counts = useTodoStore((s) => s.counts);
  const trashCounts = useTodoStore((s) => s.trashCounts);
  useEffect(() => {
    // 挂载时 best-effort 刷新一次计数（两者失败均静默，保留旧值/null）
    const store = useTodoStore.getState();
    void store.refreshCounts();
    void store.refreshTrashCounts();
  }, []);

  const perListCounts = useMemo(() => {
    if (!counts || !Array.isArray(counts.perList)) return null;
    const map = new Map<string, number>();
    for (const entry of counts.perList) {
      if (entry && typeof entry.listId === 'string' && typeof entry.pendingCount === 'number') {
        map.set(entry.listId, entry.pendingCount);
      }
    }
    return map;
  }, [counts]);

  // 桌面端内联回收站视图（Shell 侧栏与内容区分属不同挂载点，经共享 store 协调）
  const trashViewOpen = useTodoTrashView((s) => s.isOpen);
  const openTrashView = useTodoTrashView((s) => s.open);
  const closeTrashView = useTodoTrashView((s) => s.close);
  const trashActive = !onOpenTrash && trashViewOpen;
  // 回收站计数徽标（清单 + 条目合计；trashCounts 为 null 时不渲染）
  const trashTotalCount = trashCounts
    ? trashCounts.deletedItems + trashCounts.deletedLists
    : 0;

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
  // 拖拽进行中：临时放开分区 overflow 裁剪，避免跨组拖拽时行被收藏分区剪裁
  const [dragActive, setDragActive] = useState(false);

  // 分区折叠（持久化）；搜索中强制展开列表相关分区，保证结果可见
  const [collapsedSections, setCollapsedSections] =
    useState<Partial<Record<SidebarSectionId, boolean>>>(readCollapsedSections);
  const toggleSection = useCallback((id: SidebarSectionId) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(next));
      } catch {
        // 持久化属增强能力，配额/隐私模式失败时仅保留会话内状态
      }
      return next;
    });
  }, []);
  const expandSection = useCallback((id: SidebarSectionId) => {
    setCollapsedSections((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev, [id]: false };
      try {
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(next));
      } catch {
        // 同上，静默
      }
      return next;
    });
  }, []);

  const searching = searchQuery.trim().length > 0;
  const smartViewsCollapsed = Boolean(collapsedSections.smartViews);
  const favoritesCollapsed = !searching && Boolean(collapsedSections.favorites);
  const listsCollapsed = !searching && Boolean(collapsedSections.lists);

  const sectionIdBase = useId();
  const smartViewsBodyId = `${sectionIdBase}-smart-views`;
  const favoritesBodyId = `${sectionIdBase}-favorites`;
  const listsBodyId = `${sectionIdBase}-lists`;

  // coarse 指针（触屏）判定一次即可：影响拖拽 listeners 的挂载策略
  const [coarsePointer] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches,
  );

  const sensors = useTouchFriendlyDndSensors();

  // ===== 键盘导航 =====
  // ⌘/Ctrl+1..8 视图跳转（模块级单监听，仅本侧栏可见时消费）
  const asideRef = useRef<HTMLElement | null>(null);
  useTodoViewHotkeys(asideRef);

  // ↑/↓/Home/End 在可见导航行间移动焦点（跳过折叠分区与输入态）
  const handleNavKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    // 键盘拖拽会话（dnd-kit KeyboardSensor）与已被消费的事件不劫持
    if (e.defaultPrevented || dragActive) return;
    const root = asideRef.current;
    if (!root) return;
    const target = e.target as HTMLElement;
    // 输入框内（搜索/重命名/新建）保留光标移动语义
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const rows = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-todo-nav-row]'),
    ).filter((el) => !el.disabled && !el.closest('[aria-hidden="true"]'));
    if (rows.length === 0) return;
    const currentIndex = rows.indexOf(
      (target.closest('[data-todo-nav-row]') as HTMLButtonElement | null) ?? target as HTMLButtonElement,
    );
    let nextIndex: number;
    if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = rows.length - 1;
    } else if (currentIndex === -1) {
      nextIndex = e.key === 'ArrowDown' ? 0 : rows.length - 1;
    } else {
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      nextIndex = (currentIndex + delta + rows.length) % rows.length;
    }
    e.preventDefault();
    rows[nextIndex]?.focus();
  }, [dragActive]);

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

  // 改色/改图标：经 store.updateList 第 4 参提交（null → ''，即后端
  // 「Some("") 清空回 NULL」三态语义）。store 内用返回实体原位回写 lists
  // 并统一弹错，不再绕过 store 直调 API + loadLists 整表刷新。
  const setListColor = useCallback(
    (listId: string, color: string | null) =>
      updateList(listId, undefined, undefined, { color: color ?? '' }),
    [updateList],
  );

  const setListIcon = useCallback(
    (listId: string, icon: string | null) =>
      updateList(listId, undefined, undefined, { icon: icon ?? '' }),
    [updateList],
  );

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
      setDragActive(false);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const favoriteIds = favoriteLists.map((l) => l.id);
      const regularIds = regularLists.map((l) => l.id);
      const inFavorites = favoriteIds.includes(activeId);
      const groupIds = inFavorites ? favoriteIds : regularIds;
      if (!groupIds.includes(overId)) {
        // 跨组拖拽 = 切换收藏状态：拖进收藏组即收藏，拖出即取消收藏
        // （落点组内的精确位置交由 sortOrder 既有规则，不再静默忽略）
        const otherGroupIds = inFavorites ? regularIds : favoriteIds;
        if (otherGroupIds.includes(overId)) void toggleListFavorite(activeId);
        return;
      }
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
    [favoriteLists, regularLists, defaultList, reorderLists, toggleListFavorite],
  );

  /** 智能视图中性计数（overdue 用红色徽标另行渲染；matrix/completed 不显） */
  const smartViewCount = useCallback(
    (id: TodoViewFilter): number | null => {
      if (!counts) return null;
      switch (id) {
        case 'all':
          return typeof counts.inboxCount === 'number' ? counts.inboxCount : null;
        case 'today':
          return typeof counts.todayCount === 'number' ? counts.todayCount : null;
        case 'upcoming':
          return typeof counts.upcomingCount === 'number' ? counts.upcomingCount : null;
        default:
          return null;
      }
    },
    [counts],
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
              'bg-[color:var(--interactive-hover)] px-2.5 text-ui',
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
            <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--shell-navigation-foreground)]">
              {t('todo:dialogs.deleteList.inlineConfirm', { title: list.title })}
            </span>
            <button
              type="button"
              autoFocus
              onClick={() => {
                setPendingDeleteListId(null);
                // 软删除后刷新回收站徽标（store 的 deleteList 不触达 trashCounts）
                void deleteList(list.id).then(() =>
                  useTodoStore.getState().refreshTrashCounts(),
                );
              }}
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-sm font-medium',
                'text-[color:hsl(var(--destructive))] transition-colors duration-150',
                'hover:bg-[color:var(--button-danger-surface,var(--interactive-hover))]',
                '[@media(pointer:coarse)]:min-h-[2.5rem] [@media(pointer:coarse)]:px-2.5',
              )}
            >
              {t('common:actions.delete')}
            </button>
            <button
              type="button"
              onClick={() => setPendingDeleteListId(null)}
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-sm',
                'text-[color:var(--shell-navigation-muted)] transition-colors duration-150',
                'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
                '[@media(pointer:coarse)]:min-h-[2.5rem] [@media(pointer:coarse)]:px-2.5',
              )}
            >
              {t('common:actions.cancel')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <TodoListRow
        key={list.id}
        list={list}
        isActive={isActive}
        dragEnabled={dragEnabled}
        rowDragListeners={coarsePointer}
        pendingCount={perListCounts?.get(list.id) ?? null}
        menuOpen={menuListId === list.id}
        onMenuOpenChange={(open) => setMenuListId(open ? list.id : null)}
        onSelect={() => handleListClick(list)}
        onStartRename={() => startRename(list)}
        onToggleFavorite={() => void toggleListFavorite(list.id)}
        onSetColor={(color) => void setListColor(list.id, color)}
        onSetIcon={(icon) => void setListIcon(list.id, icon)}
        onRequestDelete={() => setPendingDeleteListId(list.id)}
      />
    );
  };

  const listSectionContent = (
    <>
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
              'bg-[color:var(--interactive-hover)] px-2.5 text-ui',
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
        onDragStart={() => setDragActive(true)}
        onDragCancel={() => setDragActive(false)}
        onDragEnd={handleListDragEnd}
      >
        {favoriteLists.length > 0 && (
          <>
            <SectionHeader
              label={t('todo:sections.favorites')}
              collapsed={favoritesCollapsed}
              onToggle={() => toggleSection('favorites')}
              controlsId={favoritesBodyId}
              className="pb-1 pt-0.5"
            />
            <CollapsibleBody
              id={favoritesBodyId}
              collapsed={favoritesCollapsed}
              innerClassName={dragActive && !favoritesCollapsed ? 'overflow-visible' : undefined}
            >
              <SortableContext
                items={favoriteLists.map((l) => l.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-0.5 pb-1.5">
                  {favoriteLists.map(renderListRow)}
                </div>
              </SortableContext>
            </CollapsibleBody>
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
        <div className="px-2 py-6 text-center text-sm text-[color:var(--shell-navigation-muted)]">
          {searchQuery
            ? t('todo:empty.noMatchingLists', '没有匹配的列表')
            : t('todo:empty.noLists', '暂无列表')}
        </div>
      )}
    </>
  );

  return (
    <aside
      ref={asideRef}
      role="navigation"
      onKeyDown={handleNavKeyDown}
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
              'bg-[color:var(--interactive-hover)]/60 pl-8 pr-8 text-ui text-[color:var(--shell-navigation-foreground)]',
              'outline-none placeholder:text-[color:var(--shell-navigation-muted)]',
              'focus:border-[color:var(--shell-navigation-border)] focus:bg-[color:var(--interactive-hover)]',
              'transition-colors',
            )}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[color:var(--shell-navigation-muted)] transition-colors hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)] [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:right-0"
              aria-label={t('common:actions.clear')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 智能视图 */}
      <div className="shrink-0 px-2 pb-1">
        <SectionHeader
          label={t('todo:sections.smartViews')}
          collapsed={smartViewsCollapsed}
          onToggle={() => toggleSection('smartViews')}
          controlsId={smartViewsBodyId}
        />
        <CollapsibleBody id={smartViewsBodyId} collapsed={smartViewsCollapsed}>
          <div className="space-y-0.5">
            {SMART_VIEWS.map(({ id, icon: Icon, labelKey }, viewIndex) => {
              // 收件箱语义 = 默认清单的 all 视图（默认清单不再重复出现在列表区）；
              // active 判定收紧为 activeListId === defaultList，避免与清单行双高亮
              const isActive =
                workspaceView === 'todos' &&
                !trashActive &&
                filter.view === id &&
                (id !== 'all' || (defaultList !== null && activeListId === defaultList.id));
              const showOverdueBadge = id === 'overdue' && overdueCount > 0;
              const neutralCount = smartViewCount(id);
              return (
                <NavRow
                  key={id}
                  isActive={isActive}
                  onClick={() => handleSmartViewClick(id)}
                  title={`${t(labelKey)} ${todoHotkeyHint(viewIndex + 1)}`}
                  leftSlot={<Icon size={18} weight="regular" />}
                  rightSlot={
                    showOverdueBadge ? (
                      <span
                        aria-label={t('todo:overdue.badgeAria', { count: overdueCount })}
                        className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color:hsl(var(--destructive))] px-1 text-2xs font-semibold leading-none tabular-nums text-white"
                      >
                        {overdueCount > 99 ? '99+' : overdueCount}
                      </span>
                    ) : neutralCount !== null && neutralCount > 0 ? (
                      <PendingCountBadge
                        count={neutralCount}
                        ariaLabel={t('todo:sidebar.pendingBadgeAria', { count: neutralCount })}
                      />
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
              title={`${t('todo:automation.title', '定时任务')} ${todoHotkeyHint(7)}`}
              leftSlot={<Robot size={18} weight="duotone" />}
            >
              {t('todo:automation.title', '定时任务')}
            </NavRow>
          </div>
        </CollapsibleBody>
      </div>

      {/* 列表 */}
      <div className={cn('flex min-h-0 flex-col px-2 pb-2', unifiedDrawer ? '' : 'flex-1 overflow-hidden')}>
        <SectionHeader
          label={t('todo:sections.lists')}
          collapsed={listsCollapsed}
          onToggle={() => toggleSection('lists')}
          controlsId={listsBodyId}
          action={
            <button
              type="button"
              onClick={() => {
                expandSection('lists');
                setIsCreating(true);
              }}
              aria-label={t('todo:actions.newList', '新建列表')}
              title={t('todo:actions.newList', '新建列表')}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-md',
                'text-[color:var(--shell-navigation-muted)] opacity-0 transition-opacity duration-150',
                'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
                'group-hover/todo-section:opacity-100 focus-visible:opacity-100',
                // 触屏无 hover：常显 + ≥44px 命中区，否则新建入口不可发现/难点中
                '[@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
              )}
            >
              <Plus size={14} />
            </button>
          }
        />

        <CollapsibleBody
          id={listsBodyId}
          collapsed={listsCollapsed}
          className={cn(!unifiedDrawer && 'min-h-0 flex-1')}
        >
          {unifiedDrawer ? (
            <div>{listSectionContent}</div>
          ) : (
            <CustomScrollArea className="h-full min-h-0" trackOffsetRight={1}>
              {listSectionContent}
            </CustomScrollArea>
          )}
        </CollapsibleBody>
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
          title={`${t('todo:trash.title')} ${todoHotkeyHint(8)}`}
          leftSlot={<Trash size={18} weight="regular" />}
          rightSlot={
            trashTotalCount > 0 ? (
              <PendingCountBadge
                count={trashTotalCount}
                ariaLabel={t('todo:sidebar.trashBadgeAria', {
                  count: trashTotalCount,
                  defaultValue: '回收站内 {{count}} 条记录',
                })}
              />
            ) : undefined
          }
        >
          {t('todo:trash.title')}
        </NavRow>
      </div>
    </aside>
  );
};
