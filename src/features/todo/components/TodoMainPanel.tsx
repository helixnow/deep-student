/**
 * TodoMainPanel - 待办项主面板
 *
 * 设计原则：扁平工作区，避免"盒中盒"嵌套。
 * - 顶部 study-shell-toolbar 承载标题/搜索/筛选
 * - 中部直接平铺快速添加栏 + 列表项（或空状态）
 * - 右侧详情抽屉（桌面端）或全屏覆盖（移动端）
 * - 底部嵌入番茄钟面板
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  MagnifyingGlass,
  CheckCircle,
  CircleNotch,
  Calendar,
  Warning,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Minus,
  Trash,
  X,
  Check,
  Play,
  Brain,
  ListChecks,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useTodoStore } from '../stores/useTodoStore';
import { usePomodoroStore } from '@/features/pomodoro';
import { PomodoroPanel } from '@/features/pomodoro';
import type { TodoItem, TodoPriority, UpdateTodoItemInput } from '../types';
import { PRIORITY_CONFIG, isOverdue, isDueToday, parseTags } from '../types';

// ============================================================================
// TodoQuickAdd — 扁平输入条
// ============================================================================

const TodoQuickAdd: React.FC = () => {
  const { t } = useTranslation(['todo']);
  const { createItem, activeListId } = useTodoStore();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('none');
  const [dueDate, setDueDate] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !activeListId) return;
    try {
      await createItem({
        todoListId: activeListId,
        title: title.trim(),
        priority,
        dueDate: dueDate || undefined,
      });
      setTitle('');
      setPriority('none');
      setDueDate('');
      setIsExpanded(false);
    } catch {
      // error handled in store
    }
  }, [title, priority, dueDate, activeListId, createItem]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape') setIsExpanded(false);
    },
    [handleSubmit],
  );

  if (!activeListId) return null;

  return (
    <div>
      <div className="flex items-center gap-2.5 px-4 py-2.5 sm:px-6">
        <Plus size={16} className="flex-shrink-0 text-[color:var(--text-muted)]" />
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsExpanded(true)}
          placeholder={t('todo:actions.quickAddPlaceholder')}
          className="min-w-0 flex-1 bg-transparent border-0 focus-visible:ring-0 placeholder:text-muted-foreground/50"
        />
        {title.trim() && (
          <NotionButton variant="shell" size="sm" onClick={handleSubmit} className="h-7 text-xs">
            {t('todo:actions.add')}
          </NotionButton>
        )}
      </div>

      {isExpanded && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2.5 sm:px-6">
          <SegmentedControl<TodoPriority>
            ariaLabel={t('todo:fields.priority')}
            value={priority}
            onValueChange={setPriority}
            size="compact"
            itemClassName="!h-auto !px-2 !py-1 text-[11px] font-medium"
            options={(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => {
              const config = PRIORITY_CONFIG[p];
              const isActive = priority === p;
              return {
                value: p,
                title: t(config.labelKey),
                label: (
                  <span className={isActive ? config.color : ''}>{t(config.labelKey)}</span>
                ),
              };
            })}
          />

          <div className="flex items-center gap-1.5 rounded-[var(--radius-shell-control)] border border-[color:var(--input-shell-border)] bg-[color:var(--input-shell-surface)] px-2 py-1">
            <Calendar size={14} className="text-muted-foreground" />
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="cursor-pointer bg-transparent border-0 focus-visible:ring-0 text-xs h-auto min-h-0 p-0 w-auto"
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// TodoItemRow
// ============================================================================

const PriorityIcon: React.FC<{ priority: TodoPriority; className?: string }> = ({
  priority,
  className,
}) => {
  const config = PRIORITY_CONFIG[priority];
  const icons: Record<string, React.ElementType> = {
    Minus,
    ArrowDown,
    ArrowRight,
    ArrowUp,
    AlertTriangle: Warning,
  };
  const Icon = icons[config.icon] || Minus;
  return <Icon size={16} className={cn(config.color, className)} />;
};

const TodoItemRow: React.FC<{
  item: TodoItem;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  isSelected: boolean;
}> = ({ item, onToggle, onSelect, onDelete, isSelected }) => {
  const { t } = useTranslation(['todo']);
  const overdue = isOverdue(item);
  const dueToday = isDueToday(item);
  const tags = parseTags(item.tagsJson);
  const isCompleted = item.status === 'completed';

  return (
    <div
      data-selected={isSelected}
      className={cn(
        'group relative flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-100 sm:px-6',
        'hover:bg-[color:var(--interactive-hover)]',
        'data-[selected=true]:bg-[color:var(--interactive-selected)]',
        isCompleted && 'opacity-60',
      )}
      onClick={() => onSelect(item.id)}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle(item.id);
        }}
        className="flex-shrink-0 transition-transform duration-150 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 rounded-full"
        aria-label={isCompleted ? '标记为未完成' : '标记为完成'}
      >
        {isCompleted ? (
          <CheckCircle size={20} className="text-[color:hsl(var(--success))]" />
        ) : (
          <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-[color:var(--border-default)] transition-colors group-hover:border-[color:hsl(var(--primary))] group-focus-within:border-[color:hsl(var(--primary))]">
            <Check size={12} className="text-[color:hsl(var(--primary))] opacity-0 transition-opacity group-hover:opacity-40 group-focus-within:opacity-40" />
          </div>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div
          className={cn(
            'truncate text-sm transition-all duration-150',
            isCompleted
              ? 'text-muted-foreground line-through'
              : 'font-medium text-foreground',
          )}
        >
          {item.title}
        </div>

        {(item.dueDate ||
          tags.length > 0 ||
          item.priority !== 'none' ||
          item.estimatedPomodoros) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {item.estimatedPomodoros ? (
              <span
                className="study-shell-badge study-shell-badge--warning"
                title={`${item.completedPomodoros || 0} / ${item.estimatedPomodoros} Pomodoros`}
              >
                <Brain size={12} />
                {item.completedPomodoros || 0}/{item.estimatedPomodoros}
              </span>
            ) : null}

            {item.priority !== 'none' && (
              <span className="inline-flex items-center gap-1 text-[11px]">
                <PriorityIcon priority={item.priority as TodoPriority} className="h-3 w-3" />
                <span className="text-muted-foreground">
                  {t(PRIORITY_CONFIG[item.priority as TodoPriority].labelKey)}
                </span>
              </span>
            )}

            {item.dueDate && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[11px]',
                  overdue
                    ? 'font-medium text-[color:hsl(var(--destructive))]'
                    : dueToday
                    ? 'font-medium text-[color:hsl(var(--primary))]'
                    : 'text-muted-foreground',
                )}
              >
                <Calendar size={12} />
                {item.dueDate}
                {item.dueTime && ` ${item.dueTime}`}
              </span>
            )}

            {tags.length > 0 && (
              <div className="flex gap-1">
                {tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="study-shell-badge">
                    {tag}
                  </span>
                ))}
                {tags.length > 3 && <span className="study-shell-badge">+{tags.length - 3}</span>}
              </div>
            )}
          </div>
        )}
      </div>

      {!isCompleted && (
        <NotionButton
          variant="utility"
          size="icon"
          iconOnly
          onClick={(e) => {
            e.stopPropagation();
            usePomodoroStore.getState().start(item.id, item.title);
          }}
          title={t('todo:actions.startFocusSession')}
          aria-label="start-focus"
          className="flex-shrink-0 opacity-40 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 !p-1.5"
        >
          <Play size={16} />
        </NotionButton>
      )}

      <NotionButton
        variant="utility"
        size="icon"
        iconOnly
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item.id);
        }}
        aria-label="delete-todo"
        className="flex-shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100 !p-1.5 hover:!bg-[color:var(--button-danger-surface)] hover:!text-[color:hsl(var(--destructive))]"
      >
        <Trash size={16} />
      </NotionButton>
    </div>
  );
};

// ============================================================================
// TodoItemDetail
// ============================================================================

const TodoItemDetail: React.FC<{
  item: TodoItem;
  onClose: () => void;
  className?: string;
}> = ({ item, onClose, className }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { updateItem, toggleItem, deleteItem } = useTodoStore();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description || '');
  const [priority, setPriority] = useState<TodoPriority>(item.priority as TodoPriority);
  const [dueDate, setDueDate] = useState(item.dueDate || '');
  const [dueTime, setDueTime] = useState(item.dueTime || '');
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(item.estimatedPomodoros || 0);

  const handleSave = useCallback(async () => {
    const changes: UpdateTodoItemInput = { id: item.id };
    let hasChanges = false;
    if (title !== item.title) {
      changes.title = title;
      hasChanges = true;
    }
    if (description !== (item.description || '')) {
      changes.description = description;
      hasChanges = true;
    }
    if (priority !== item.priority) {
      changes.priority = priority;
      hasChanges = true;
    }
    if (dueDate !== (item.dueDate || '')) {
      changes.dueDate = dueDate;
      hasChanges = true;
    }
    if (dueTime !== (item.dueTime || '')) {
      changes.dueTime = dueTime;
      hasChanges = true;
    }
    if (estimatedPomodoros !== (item.estimatedPomodoros || 0)) {
      changes.estimatedPomodoros = estimatedPomodoros;
      hasChanges = true;
    }

    if (hasChanges) {
      await updateItem(changes);
    }
  }, [item, title, description, priority, dueDate, dueTime, estimatedPomodoros, updateItem]);

  const handleBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  const isCompleted = item.status === 'completed';

  return (
    <aside
      className={cn(
        'flex h-full flex-col bg-[color:var(--shell-inspector-panel)]',
        'animate-in slide-in-from-right-8 duration-200',
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => toggleItem(item.id)}
            className="transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))] focus-visible:ring-offset-1 rounded-full"
            aria-label={isCompleted ? '标记为未完成' : '标记为完成'}
          >
            {isCompleted ? (
              <CheckCircle size={20} className="text-[color:hsl(var(--success))]" />
            ) : (
              <div className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-[color:var(--border-default)] hover:border-[color:hsl(var(--primary))]">
                <Check size={12} className="text-[color:hsl(var(--primary))] opacity-0" />
              </div>
            )}
          </button>
          <span className="text-sm font-medium text-muted-foreground">
            {t('todo:detail.title')}
          </span>
        </div>
        <NotionButton
          variant="utility"
          size="icon"
          iconOnly
          onClick={onClose}
          aria-label={t('common:actions.close')}
          className="!p-1.5"
        >
          <X size={16} />
        </NotionButton>
      </div>

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-5 py-5 space-y-5">
        <Textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleBlur}
          className={cn(
            'w-full resize-none overflow-hidden bg-transparent border-0 focus-visible:ring-0 text-lg font-semibold tracking-tight leading-tight placeholder:text-muted-foreground/50 transition-colors min-h-0',
            isCompleted && 'text-muted-foreground line-through',
          )}
          rows={2}
          placeholder={t('todo:placeholders.title')}
        />

        {/* 属性面板 — 扁平列表，不用卡片包裹 */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 py-1">
            <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">
              {t('todo:fields.priority')}
            </span>
            <SegmentedControl<TodoPriority>
              ariaLabel={t('todo:fields.priority')}
              value={priority}
              onValueChange={(p) => {
                setPriority(p);
                updateItem({ id: item.id, priority: p });
              }}
              size="compact"
              className="flex-wrap"
              itemClassName="!h-auto !px-2 !py-0.5 text-[11px] font-medium"
              options={(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => {
                const isActive = priority === p;
                return {
                  value: p,
                  title: t(PRIORITY_CONFIG[p].labelKey),
                  label: (
                    <span className={isActive ? PRIORITY_CONFIG[p].color : ''}>
                      {t(PRIORITY_CONFIG[p].labelKey)}
                    </span>
                  ),
                };
              })}
            />
          </div>

          <div className="flex items-center gap-3 py-1">
            <span className="flex w-16 flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Calendar size={14} />
              {t('todo:fields.dueDate')}
            </span>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              onBlur={handleBlur}
              className="flex-1"
            />
          </div>

          {dueDate && (
            <div className="flex items-center gap-3 py-1">
              <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">
                {t('todo:fields.dueTime')}
              </span>
              <Input
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                onBlur={handleBlur}
                className="flex-1"
              />
            </div>
          )}

          <div className="flex items-center gap-3 py-1">
            <span className="flex w-16 flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Brain size={14} />
              {t('todo:fields.pomodoros', '番茄')}
            </span>
            <Input
              type="number"
              min={0}
              max={20}
              value={estimatedPomodoros || ''}
              onChange={(e) => setEstimatedPomodoros(Number(e.target.value) || 0)}
              onBlur={handleBlur}
              placeholder="0"
              className="w-20"
            />
          </div>
        </div>

        <div className="space-y-2 pt-2">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('todo:fields.description')}
          </span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleBlur}
            placeholder={t('todo:placeholders.description')}
            rows={8}
            className="w-full resize-none leading-relaxed"
          />
        </div>
      </CustomScrollArea>

      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {item.updatedAt
            ? t('todo:detail.updatedAt', {
                date: new Date(item.updatedAt).toLocaleDateString(),
              })
            : ''}
        </span>
        <NotionButton
          variant="danger"
          size="sm"
          onClick={() => {
            deleteItem(item.id);
            onClose();
          }}
          className="gap-1.5"
        >
          <Trash size={16} />
          {t('common:actions.delete')}
        </NotionButton>
      </div>
    </aside>
  );
};

// ============================================================================
// TodoMainPanel
// ============================================================================

export const TodoMainPanel: React.FC = () => {
  const { t } = useTranslation(['todo']);
  const { isSmallScreen } = useBreakpoint();
  const {
    items,
    activeListId,
    lists,
    isLoadingItems,
    filter,
    selectedItemId,
    toggleItem,
    deleteItem,
    selectItem,
    setSearch,
    setShowCompleted,
  } = useTodoStore();

  const activeList = lists.find((l) => l.id === activeListId);
  const selectedItem = items.find((i) => i.id === selectedItemId);

  const filteredItems = items.filter((item) => {
    if (filter.priorityFilter && item.priority !== filter.priorityFilter) return false;
    if (filter.view !== 'completed' && !filter.showCompleted && item.status === 'completed')
      return false;
    return true;
  });

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const completedCount = items.filter((i) => i.status === 'completed').length;

  const viewTitle = (() => {
    switch (filter.view) {
      case 'today':
        return t('todo:views.today');
      case 'upcoming':
        return t('todo:views.upcoming');
      case 'overdue':
        return t('todo:views.overdue');
      case 'completed':
        return t('todo:views.completed');
      default:
        return activeList?.title || t('todo:views.inbox');
    }
  })();

  return (
    <div className="flex min-w-0 flex-1 flex-row overflow-hidden">
      {/* 主列 */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部工具栏 */}
        <div className="study-shell-toolbar flex flex-shrink-0 flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            {!isSmallScreen && (
              <h2 className="truncate text-[15px] font-semibold text-foreground">
                {viewTitle}
              </h2>
            )}
            <span className="text-xs tabular-nums text-muted-foreground/40">
              {pendingCount}&nbsp;{t('todo:stats.pending')}
              {completedCount > 0 && (
                <>
                  <span className="mx-1 text-muted-foreground/30">·</span>
                  {completedCount}&nbsp;{t('todo:stats.completed')}
                </>
              )}
            </span>
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <div className="relative">
              <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" size={14} />
              <Input
                type="text"
                value={filter.search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('todo:actions.search')}
                className="h-8 w-44 pl-8 pr-3 text-xs sm:w-56"
              />
            </div>

            <NotionButton
              variant="utility"
              size="sm"
              onClick={() => setShowCompleted(!filter.showCompleted)}
              disabled={filter.view === 'completed'}
              data-selected={filter.showCompleted}
              className={cn(
                'h-8 gap-1.5 !px-2.5 text-xs',
                filter.showCompleted &&
                  '!bg-[color:var(--button-primary-surface)] !text-[color:var(--button-primary-foreground)]',
              )}
            >
              <CheckCircle size={14} />
              <span className="hidden sm:inline">{t('todo:filters.showCompleted')}</span>
            </NotionButton>
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CustomScrollArea className="flex-1 min-h-0" viewportClassName="pb-6">
            {filter.view === 'all' && (
              <>
                <TodoQuickAdd />
                <div className="h-px bg-border/20" />
              </>
            )}

            {isLoadingItems ? (
              <div className="flex items-center justify-center py-20">
                <CircleNotch size={24} className="animate-spin text-muted-foreground/60" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="study-shell-empty-state m-4 sm:m-6 animate-in fade-in duration-300">
                <div className="study-shell-empty-state__icon">
                  <ListChecks size={24} />
                </div>
                <h3 className="study-shell-empty-state__title">
                  {t('todo:empty.noItems')}
                </h3>
                <p className="study-shell-empty-state__description">
                  {t('todo:empty.hint')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border/[0.08]">
                {filteredItems.map((item) => (
                  <TodoItemRow
                    key={item.id}
                    item={item}
                    onToggle={toggleItem}
                    onSelect={selectItem}
                    onDelete={deleteItem}
                    isSelected={selectedItemId === item.id}
                  />
                ))}
              </div>
            )}
          </CustomScrollArea>
        </div>

        <PomodoroPanel />

        {/* 移动端详情：全屏覆盖 */}
        {isSmallScreen && selectedItem && (
          <div className="absolute inset-0 z-40 flex bg-[color:var(--surface-root)]">
            <TodoItemDetail
              key={selectedItem.id}
              item={selectedItem}
              onClose={() => selectItem(null)}
              className="w-full"
            />
          </div>
        )}
      </div>

      {/* 桌面端详情：右侧抽屉 */}
      {!isSmallScreen && selectedItem && (
        <TodoItemDetail
          key={selectedItem.id}
          item={selectedItem}
          onClose={() => selectItem(null)}
          className="w-[360px] flex-shrink-0 border-l border-[color:var(--shell-seam)]"
        />
      )}
    </div>
  );
};
