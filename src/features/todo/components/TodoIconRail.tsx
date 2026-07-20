/**
 * TodoIconRail — 窄窗图标导航栏（抽屉替代品）
 *
 * TodoAppWindow 在 compact 档（<640px）不再收纳为玻璃抽屉，而是把侧栏
 * 降级为一条 48px 常驻图标栏：智能视图 / 定时任务 / 清单（内联 popover
 * 列表，AppMenu 承载）/ 回收站。active 态、计数徽标（仅逾期红点）与
 * TodoSidebar 同一套 store 判定逻辑；导航动作复用 todoShellNav，
 * 保证与完整侧栏切视图的副作用一致。
 *
 * ⌘/Ctrl+1..8 热键在此同样注册（compact 下 TodoSidebar 未挂载）。
 */

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Robot, Trash, ListBullets } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuLabel,
} from '@/components/ui/app-menu/AppMenu';
import { useTodoStore } from '../stores/useTodoStore';
import { useTodoTrashView } from './TodoTrashDialog';
import { SMART_VIEWS, TodoListGlyph } from './TodoSidebar';
import {
  activateTodoSmartView,
  activateTodoList,
  activateTodoAutomations,
  openTodoTrashView,
  useTodoViewHotkeys,
  todoHotkeyHint,
} from './todoShellNav';

interface RailButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  label: string;
  /** 右上角红色数字徽标（>0 才显示，由调用方保证） */
  badgeCount?: number;
}

const RailButton = React.forwardRef<HTMLButtonElement, RailButtonProps>(
  ({ active, label, badgeCount, className, children, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-9 w-9 shrink-0 items-center justify-center',
        'rounded-[var(--radius-shell-control,0.5rem)] transition-colors duration-150',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-[color:var(--interactive-selected)] text-[color:var(--shell-navigation-foreground)]'
          : 'text-[color:var(--shell-navigation-muted)] hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--shell-navigation-foreground)]',
        className,
      )}
      {...rest}
    >
      {children}
      {typeof badgeCount === 'number' && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[color:hsl(var(--destructive))] px-0.5 text-[9px] font-semibold leading-none tabular-nums text-white"
        >
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </button>
  ),
);
RailButton.displayName = 'RailButton';

export const TodoIconRail: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['todo', 'common']);
  const lists = useTodoStore((s) => s.lists);
  const activeListId = useTodoStore((s) => s.activeListId);
  const filter = useTodoStore((s) => s.filter);
  const workspaceView = useTodoStore((s) => s.workspaceView);
  const overdueCount = useTodoStore((s) => s.overdueCount);
  const trashOpen = useTodoTrashView((s) => s.isOpen);

  const rootRef = useRef<HTMLDivElement | null>(null);
  useTodoViewHotkeys(rootRef);

  const [listsMenuOpen, setListsMenuOpen] = useState(false);

  const defaultList = lists.find((l) => l.isDefault) ?? null;
  const menuLists = lists.filter((l) => !l.isDefault);
  // 收藏置顶，其余保持 sortOrder（lists 已按后端顺序）
  const orderedMenuLists = [
    ...menuLists.filter((l) => l.isFavorite),
    ...menuLists.filter((l) => !l.isFavorite),
  ];
  // 非默认清单被选中（all 视图）时，清单入口高亮
  const listEntryActive =
    workspaceView === 'todos' &&
    !trashOpen &&
    filter.view === 'all' &&
    activeListId !== null &&
    defaultList?.id !== activeListId;

  return (
    <div
      ref={rootRef}
      role="navigation"
      aria-label={t('todo:sidebar.title')}
      data-todo-icon-rail
      className={cn(
        'flex h-full w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto py-2',
        className,
      )}
    >
      {SMART_VIEWS.map(({ id, icon: Icon, labelKey }, viewIndex) => {
        const isActive =
          workspaceView === 'todos' &&
          !trashOpen &&
          filter.view === id &&
          (id !== 'all' || (defaultList !== null && activeListId === defaultList.id));
        const showOverdueBadge = id === 'overdue' && overdueCount > 0;
        return (
          <RailButton
            key={id}
            active={isActive}
            label={`${t(labelKey)} ${todoHotkeyHint(viewIndex + 1)}`}
            badgeCount={showOverdueBadge ? overdueCount : undefined}
            onClick={() => activateTodoSmartView(id)}
          >
            <Icon size={18} weight="bold" />
          </RailButton>
        );
      })}

      <RailButton
        active={workspaceView === 'automations' && !trashOpen}
        label={`${t('todo:automation.title', '定时任务')} ${todoHotkeyHint(7)}`}
        onClick={() => activateTodoAutomations()}
      >
        <Robot size={18} weight="duotone" />
      </RailButton>

      {/* 清单：内联 popover 列表（AppMenu），非抽屉 */}
      <AppMenu open={listsMenuOpen} onOpenChange={setListsMenuOpen}>
        <AppMenuTrigger asChild>
          <RailButton active={listEntryActive} label={t('todo:sections.lists')}>
            <ListBullets size={18} weight="bold" />
          </RailButton>
        </AppMenuTrigger>
        <AppMenuContent align="start" width={220} maxHeight={320}>
          <AppMenuLabel>{t('todo:sections.lists')}</AppMenuLabel>
          {orderedMenuLists.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t('todo:empty.noLists', '暂无列表')}
            </div>
          ) : (
            orderedMenuLists.map((list) => (
              <AppMenuItem
                key={list.id}
                icon={<TodoListGlyph list={list} size={15} />}
                checked={workspaceView === 'todos' && !trashOpen && filter.view === 'all' && activeListId === list.id}
                onClick={() => activateTodoList(list.id)}
              >
                {list.title}
              </AppMenuItem>
            ))
          )}
        </AppMenuContent>
      </AppMenu>

      <div className="mt-auto" />

      <RailButton
        active={trashOpen}
        label={`${t('todo:trash.title')} ${todoHotkeyHint(8)}`}
        onClick={() => openTodoTrashView()}
      >
        <Trash size={18} weight="bold" />
      </RailButton>
    </div>
  );
};
