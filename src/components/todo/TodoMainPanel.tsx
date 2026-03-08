/**
 * TodoMainPanel - 待办项主面板
 *
 * 包含快速添加、待办项列表、详情面板
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Search, CheckCircle2, Circle, Loader2,
  Calendar, AlertTriangle, ArrowUp, ArrowDown, ArrowRight,
  Minus, Trash2, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTodoStore } from './useTodoStore';
import type { TodoItem, TodoPriority, UpdateTodoItemInput } from './types';
import { PRIORITY_CONFIG, isOverdue, isDueToday, parseTags } from './types';

// ============================================================================
// TodoQuickAdd
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  if (!activeListId) return null;

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <Plus className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsExpanded(true)}
          placeholder={t('todo:actions.quickAddPlaceholder')}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        {title.trim() && (
          <button
            onClick={handleSubmit}
            className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            {t('todo:actions.add')}
          </button>
        )}
      </div>

      {/* 扩展选项 */}
      {isExpanded && title.trim() && (
        <div className="flex items-center gap-3 mt-2 ml-6">
          {/* 优先级选择 */}
          <div className="flex items-center gap-1">
            {(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => {
              const config = PRIORITY_CONFIG[p];
              return (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={cn(
                    'px-1.5 py-0.5 text-xs rounded transition-colors',
                    priority === p
                      ? 'bg-accent font-medium'
                      : 'hover:bg-accent/50'
                  )}
                  title={config.label}
                >
                  <span className={config.color}>{config.label}</span>
                </button>
              );
            })}
          </div>

          {/* 日期选择 */}
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="text-xs bg-transparent border border-border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      )}
    </div>
  );
};

// ============================================================================
// TodoItemRow
// ============================================================================

const PriorityIcon: React.FC<{ priority: TodoPriority; className?: string }> = ({ priority, className }) => {
  const config = PRIORITY_CONFIG[priority];
  const icons: Record<string, React.ElementType> = {
    Minus, ArrowDown, ArrowRight, ArrowUp, AlertTriangle,
  };
  const Icon = icons[config.icon] || Minus;
  return <Icon className={cn('w-3.5 h-3.5', config.color, className)} />;
};

const TodoItemRow: React.FC<{
  item: TodoItem;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  isSelected: boolean;
}> = ({ item, onToggle, onSelect, onDelete, isSelected }) => {
  const overdue = isOverdue(item);
  const dueToday = isDueToday(item);
  const tags = parseTags(item.tagsJson);
  const isCompleted = item.status === 'completed';

  return (
    <div
      className={cn(
        'group flex items-start gap-2 px-4 py-2.5 border-b border-border/50 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/60' : 'hover:bg-accent/30',
        isCompleted && 'opacity-60'
      )}
      onClick={() => onSelect(item.id)}
    >
      {/* 完成按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle(item.id);
        }}
        className="mt-0.5 flex-shrink-0 transition-colors"
      >
        {isCompleted ? (
          <CheckCircle2 className="w-4.5 h-4.5 text-green-500" />
        ) : (
          <Circle className={cn(
            'w-4.5 h-4.5',
            overdue ? 'text-red-400' : 'text-muted-foreground/50 hover:text-foreground/70'
          )} />
        )}
      </button>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {item.priority !== 'none' && <PriorityIcon priority={item.priority as TodoPriority} />}
          <span className={cn(
            'text-sm',
            isCompleted && 'line-through text-muted-foreground'
          )}>
            {item.title}
          </span>
        </div>

        {/* 元信息行 */}
        <div className="flex items-center gap-2 mt-0.5">
          {item.dueDate && (
            <span className={cn(
              'flex items-center gap-0.5 text-xs',
              overdue ? 'text-red-500 font-medium' : dueToday ? 'text-blue-500' : 'text-muted-foreground'
            )}>
              <Calendar className="w-3 h-3" />
              {item.dueDate}
              {item.dueTime && ` ${item.dueTime}`}
            </span>
          )}
          {tags.length > 0 && (
            <div className="flex gap-1">
              {tags.slice(0, 3).map((tag) => (
                <span key={tag} className="text-xs px-1 py-0.5 bg-accent rounded text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 删除按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item.id);
        }}
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

// ============================================================================
// TodoItemDetail
// ============================================================================

const TodoItemDetail: React.FC<{
  item: TodoItem;
  onClose: () => void;
}> = ({ item, onClose }) => {
  const { t } = useTranslation(['todo', 'common']);
  const { updateItem, toggleItem, deleteItem } = useTodoStore();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description || '');
  const [priority, setPriority] = useState<TodoPriority>(item.priority as TodoPriority);
  const [dueDate, setDueDate] = useState(item.dueDate || '');
  const [dueTime, setDueTime] = useState(item.dueTime || '');

  const handleSave = useCallback(async () => {
    const changes: UpdateTodoItemInput = { id: item.id };
    let hasChanges = false;
    if (title !== item.title) { changes.title = title; hasChanges = true; }
    if (description !== (item.description || '')) { changes.description = description; hasChanges = true; }
    if (priority !== item.priority) { changes.priority = priority; hasChanges = true; }
    if (dueDate !== (item.dueDate || '')) { changes.dueDate = dueDate; hasChanges = true; }
    if (dueTime !== (item.dueTime || '')) { changes.dueTime = dueTime; hasChanges = true; }
    if (hasChanges) {
      await updateItem(changes);
    }
  }, [item, title, description, priority, dueDate, dueTime, updateItem]);

  // Auto-save on blur
  const handleBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  return (
    <div className="w-80 flex-shrink-0 border-l border-border flex flex-col h-full bg-background">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-medium">{t('todo:detail.title')}</span>
        <button onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 标题 */}
        <div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleBlur}
            className="w-full text-base font-medium bg-transparent outline-none border-b border-transparent focus:border-border pb-1"
          />
        </div>

        {/* 状态 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-16">{t('todo:fields.status')}</span>
          <button
            onClick={() => toggleItem(item.id)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
              item.status === 'completed'
                ? 'bg-green-500/10 text-green-600'
                : 'bg-muted text-muted-foreground hover:bg-accent'
            )}
          >
            {item.status === 'completed' ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <Circle className="w-3.5 h-3.5" />
            )}
            {item.status === 'completed' ? t('todo:status.completed') : t('todo:status.pending')}
          </button>
        </div>

        {/* 优先级 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-16">{t('todo:fields.priority')}</span>
          <div className="flex gap-1">
            {(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPriority(p);
                  updateItem({ id: item.id, priority: p });
                }}
                className={cn(
                  'px-2 py-0.5 text-xs rounded transition-colors',
                  priority === p ? 'bg-accent font-medium' : 'hover:bg-accent/50'
                )}
              >
                <span className={PRIORITY_CONFIG[p].color}>{PRIORITY_CONFIG[p].label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 日期 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-16">{t('todo:fields.dueDate')}</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            onBlur={handleBlur}
            className="text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            type="time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            onBlur={handleBlur}
            className="text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* 描述 */}
        <div>
          <span className="text-xs text-muted-foreground block mb-1">{t('todo:fields.description')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleBlur}
            placeholder={t('todo:placeholders.description')}
            rows={4}
            className="w-full text-sm bg-transparent border border-border rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-ring resize-none placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      {/* 底部操作 */}
      <div className="px-4 py-3 border-t border-border">
        <button
          onClick={() => {
            deleteItem(item.id);
            onClose();
          }}
          className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          {t('common:actions.delete')}
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// TodoMainPanel
// ============================================================================

export const TodoMainPanel: React.FC = () => {
  const { t } = useTranslation(['todo']);
  const {
    items, activeListId, lists,
    isLoadingItems, filter, selectedItemId,
    toggleItem, deleteItem, selectItem,
    setSearch, setShowCompleted,
  } = useTodoStore();

  const activeList = lists.find((l) => l.id === activeListId);
  const selectedItem = items.find((i) => i.id === selectedItemId);

  // 客户端过滤
  const filteredItems = items.filter((item) => {
    if (filter.priorityFilter && item.priority !== filter.priorityFilter) return false;
    if (!filter.showCompleted && item.status === 'completed') return false;
    return true;
  });

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const completedCount = items.filter((i) => i.status === 'completed').length;

  // 视图标题
  const viewTitle = (() => {
    switch (filter.view) {
      case 'today': return t('todo:views.today');
      case 'upcoming': return t('todo:views.upcoming');
      case 'overdue': return t('todo:views.overdue');
      default: return activeList?.title || t('todo:views.inbox');
    }
  })();

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{viewTitle}</h2>
          <span className="text-xs text-muted-foreground">
            {pendingCount} {t('todo:stats.pending')}
            {completedCount > 0 && ` · ${completedCount} ${t('todo:stats.completed')}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* 搜索 */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={filter.search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('todo:actions.search')}
              className="pl-7 pr-2 py-1 text-xs w-40 bg-muted/50 border border-border rounded-md outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* 显示已完成 */}
          <button
            onClick={() => setShowCompleted(!filter.showCompleted)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors',
              filter.showCompleted
                ? 'bg-accent border-accent-foreground/20'
                : 'border-border hover:bg-accent/50'
            )}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {t('todo:filters.showCompleted')}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 待办列表 */}
        <div className="flex-1 overflow-y-auto">
          {/* 快速添加 */}
          {filter.view === 'all' && <TodoQuickAdd />}

          {/* 加载中 */}
          {isLoadingItems ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <CheckCircle2 className="w-10 h-10 mb-2 opacity-30" />
              <span className="text-sm">{t('todo:empty.noItems')}</span>
            </div>
          ) : (
            filteredItems.map((item) => (
              <TodoItemRow
                key={item.id}
                item={item}
                onToggle={toggleItem}
                onSelect={selectItem}
                onDelete={deleteItem}
                isSelected={selectedItemId === item.id}
              />
            ))
          )}
        </div>

        {/* 详情面板 */}
        {selectedItem && (
          <TodoItemDetail
            key={selectedItem.id}
            item={selectedItem}
            onClose={() => selectItem(null)}
          />
        )}
      </div>
    </div>
  );
};
