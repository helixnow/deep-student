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
  Minus, Trash2, X, MoreVertical, Check, Play, BrainCircuit
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTodoStore } from './useTodoStore';
import { usePomodoroStore } from '../pomodoro/usePomodoroStore';
import { PomodoroPanel } from '../pomodoro/PomodoroPanel';
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
    <div className="mx-6 my-4 bg-background border border-border/60 rounded-xl shadow-sm focus-within:shadow-md focus-within:border-primary/30 transition-all duration-200 overflow-hidden">
      <div className="flex items-center px-4 py-3">
        <Plus className="w-5 h-5 text-primary/70 flex-shrink-0 mr-3" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsExpanded(true)}
          placeholder={t('todo:actions.quickAddPlaceholder')}
          className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/50"
        />
        {title.trim() && (
          <button
            onClick={handleSubmit}
            className="ml-2 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors shadow-sm"
          >
            {t('todo:actions.add')}
          </button>
        )}
      </div>

      {/* 扩展选项 */}
      {isExpanded && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-t border-border/40">
          <div className="flex items-center gap-4">
            {/* 优先级选择 */}
            <div className="flex items-center gap-1 bg-background border border-border/50 rounded-md p-0.5">
              {(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => {
                const config = PRIORITY_CONFIG[p];
                return (
                  <button
                    key={p}
                    onClick={() => setPriority(p)}
                    className={cn(
                      'px-2 py-1 text-xs rounded-sm transition-colors',
                      priority === p
                        ? 'bg-accent font-medium shadow-sm'
                        : 'hover:bg-accent/50 text-muted-foreground'
                    )}
                    title={config.label}
                  >
                    <span className={priority === p ? config.color : ''}>{config.label}</span>
                  </button>
                );
              })}
            </div>

            {/* 日期选择 */}
            <div className="flex items-center gap-2 bg-background border border-border/50 rounded-md px-2 py-1">
              <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="text-xs bg-transparent outline-none cursor-pointer text-foreground/80"
              />
            </div>
          </div>
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
  return <Icon className={cn('w-4 h-4', config.color, className)} />;
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
        'group flex items-center gap-3 px-6 py-3 border-b border-border/40 cursor-pointer transition-all duration-200 hover:bg-accent/40',
        isSelected && 'bg-primary/5 border-l-2 border-l-primary',
        isCompleted && 'opacity-60 bg-muted/10'
      )}
      onClick={() => onSelect(item.id)}
      style={{
        borderLeftColor: isSelected ? 'hsl(var(--primary))' : 'transparent',
        borderLeftWidth: '2px'
      }}
    >
      {/* 完成按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle(item.id);
        }}
        className="flex-shrink-0 transition-all duration-200 hover:scale-110 focus:outline-none"
      >
        {isCompleted ? (
          <CheckCircle2 className="w-5 h-5 text-primary" />
        ) : (
          <div className="w-5 h-5 rounded-full border-[1.5px] border-muted-foreground/40 group-hover:border-primary/50 flex items-center justify-center transition-colors">
            <Check className="w-3.5 h-3.5 opacity-0 group-hover:opacity-30 text-primary transition-opacity" />
          </div>
        )}
      </button>

      {/* 内容 */}
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className={cn(
          'text-[15px] transition-all duration-200 truncate',
          isCompleted ? 'line-through text-muted-foreground' : 'text-foreground font-medium'
        )}>
          {item.title}
        </div>

        {/* 元信息行 - 只有在有数据时才渲染以节省空间 */}
        {(item.dueDate || tags.length > 0 || item.priority !== 'none' || item.estimatedPomodoros) && (
          <div className="flex items-center gap-3 mt-1">
            {/* Pomodoro Indicator */}
            {item.estimatedPomodoros ? (
              <div 
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600 border border-orange-500/20 text-xs"
                title={`${item.completedPomodoros || 0} / ${item.estimatedPomodoros} Pomodoros`}
              >
                <BrainCircuit className="w-3 h-3" />
                <span>{item.completedPomodoros || 0}/{item.estimatedPomodoros}</span>
              </div>
            ) : null}

            {item.priority !== 'none' && (
              <div className="flex items-center gap-1 text-xs">
                <PriorityIcon priority={item.priority as TodoPriority} />
                <span className="text-muted-foreground">{PRIORITY_CONFIG[item.priority as TodoPriority].label}</span>
              </div>
            )}
            
            {item.dueDate && (
              <span className={cn(
                'flex items-center gap-1.5 text-xs',
                overdue ? 'text-destructive font-medium' : dueToday ? 'text-primary font-medium' : 'text-muted-foreground'
              )}>
                <Calendar className="w-3.5 h-3.5" />
                {item.dueDate}
                {item.dueTime && ` ${item.dueTime}`}
              </span>
            )}
            
            {tags.length > 0 && (
              <div className="flex gap-1.5">
                {tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="text-[11px] px-1.5 py-0.5 bg-accent/60 text-muted-foreground rounded-md border border-border/50">
                    {tag}
                  </span>
                ))}
                {tags.length > 3 && (
                  <span className="text-[11px] px-1.5 py-0.5 bg-accent/60 text-muted-foreground rounded-md border border-border/50">
                    +{tags.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pomodoro Quick Start Button (Only for uncompleted tasks) */}
      {!isCompleted && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            usePomodoroStore.getState().start(item.id, item.title);
          }}
          title="Start Focus Session"
          className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-orange-500/10 text-muted-foreground hover:text-orange-500 transition-all duration-200 flex-shrink-0"
        >
          <Play className="w-4 h-4" />
        </button>
      )}

      {/* 删除按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item.id);
        }}
        className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all duration-200 flex-shrink-0"
      >
        <Trash2 className="w-4 h-4" />
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
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(item.estimatedPomodoros || 0);

  const handleSave = useCallback(async () => {
    const changes: UpdateTodoItemInput = { id: item.id };
    let hasChanges = false;
    if (title !== item.title) { changes.title = title; hasChanges = true; }
    if (description !== (item.description || '')) { changes.description = description; hasChanges = true; }
    if (priority !== item.priority) { changes.priority = priority; hasChanges = true; }
    if (dueDate !== (item.dueDate || '')) { changes.dueDate = dueDate; hasChanges = true; }
    if (dueTime !== (item.dueTime || '')) { changes.dueTime = dueTime; hasChanges = true; }
    if (estimatedPomodoros !== (item.estimatedPomodoros || 0)) { changes.estimatedPomodoros = estimatedPomodoros; hasChanges = true; }
    
    if (hasChanges) {
      await updateItem(changes);
    }
  }, [item, title, description, priority, dueDate, dueTime, estimatedPomodoros, updateItem]);

  // Auto-save on blur
  const handleBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  const isCompleted = item.status === 'completed';

  return (
    <div className="w-[340px] flex-shrink-0 border-l border-border flex flex-col h-full bg-background/50 backdrop-blur-sm shadow-xl animate-in slide-in-from-right-8 duration-300">
      {/* 头部 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <button
            onClick={() => toggleItem(item.id)}
            className="transition-transform hover:scale-110 focus:outline-none"
          >
            {isCompleted ? (
              <CheckCircle2 className="w-5 h-5 text-primary" />
            ) : (
              <div className="w-5 h-5 rounded-full border-[1.5px] border-muted-foreground/40 hover:border-primary/50 flex items-center justify-center">
                <Check className="w-3.5 h-3.5 opacity-0 text-primary" />
              </div>
            )}
          </button>
          <span className="text-sm font-medium text-muted-foreground">{t('todo:detail.title')}</span>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
        {/* 标题 */}
        <div>
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleBlur}
            className={cn(
              "w-full text-xl font-bold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50 transition-colors",
              isCompleted && "line-through text-muted-foreground"
            )}
            rows={2}
            placeholder="Task title"
          />
        </div>

        {/* 属性面板 */}
        <div className="bg-muted/30 rounded-xl border border-border/50 p-1 space-y-1">
          {/* 优先级 */}
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors group">
            <div className="w-6 flex justify-center">
              <MoreVertical className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground" />
            </div>
            <span className="text-sm text-muted-foreground w-20">{t('todo:fields.priority')}</span>
            <div className="flex-1 flex gap-1 flex-wrap">
              {(['none', 'low', 'medium', 'high', 'urgent'] as TodoPriority[]).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setPriority(p);
                    updateItem({ id: item.id, priority: p });
                  }}
                  className={cn(
                    'px-2 py-1 text-xs rounded-md transition-all',
                    priority === p 
                      ? 'bg-background shadow-sm border border-border/50 font-medium' 
                      : 'hover:bg-background/50 text-muted-foreground border border-transparent'
                  )}
                >
                  <span className={PRIORITY_CONFIG[p].color}>{PRIORITY_CONFIG[p].label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 日期 */}
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors group">
            <div className="w-6 flex justify-center">
              <Calendar className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground" />
            </div>
            <span className="text-sm text-muted-foreground w-20">{t('todo:fields.dueDate')}</span>
            <div className="flex-1 flex items-center gap-2">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                onBlur={handleBlur}
                className="flex-1 text-sm bg-background border border-border/50 rounded-md px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
              />
            </div>
          </div>
          
          {/* 时间 */}
          {dueDate && (
             <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors group">
              <div className="w-6 flex justify-center"></div>
              <span className="text-sm text-muted-foreground w-20">Time</span>
              <div className="flex-1 flex items-center gap-2">
                <input
                  type="time"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                  onBlur={handleBlur}
                  className="flex-1 text-sm bg-background border border-border/50 rounded-md px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
                />
              </div>
            </div>
          )}
        </div>

        {/* 描述 */}
        <div className="space-y-2">
          <span className="text-sm font-medium text-foreground block">{t('todo:fields.description')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleBlur}
            placeholder={t('todo:placeholders.description')}
            rows={8}
            className="w-full text-sm bg-muted/30 border border-border/50 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 focus:bg-background resize-none placeholder:text-muted-foreground/50 transition-all leading-relaxed"
          />
        </div>
      </div>

      {/* 底部操作 */}
      <div className="px-5 py-4 border-t border-border/50 bg-muted/10 flex justify-between items-center">
        <span className="text-xs text-muted-foreground">
          {item.updatedAt ? `Updated ${new Date(item.updatedAt).toLocaleDateString()}` : ''}
        </span>
        <button
          onClick={() => {
            deleteItem(item.id);
            onClose();
          }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded-md transition-colors"
        >
          <Trash2 className="w-4 h-4" />
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
    <div className="flex-1 flex flex-col h-full min-w-0 bg-background">
      {/* 头部 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/40">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">{viewTitle}</h2>
          <span className="text-sm font-medium text-muted-foreground/80">
            {pendingCount} {t('todo:stats.pending')}
            {completedCount > 0 && ` · ${completedCount} ${t('todo:stats.completed')}`}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* 搜索 */}
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
            <input
              value={filter.search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('todo:actions.search')}
              className="pl-9 pr-3 py-2 text-sm w-48 bg-muted/40 border border-border/60 rounded-full outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 focus:w-64 transition-all duration-300"
            />
          </div>

          {/* 显示已完成 */}
          <button
            onClick={() => setShowCompleted(!filter.showCompleted)}
            className={cn(
              'flex items-center gap-2 px-3 py-2 text-sm rounded-full border transition-all duration-200',
              filter.showCompleted
                ? 'bg-primary/10 border-primary/20 text-primary font-medium'
                : 'bg-transparent border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <CheckCircle2 className="w-4 h-4" />
            {t('todo:filters.showCompleted')}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 待办列表 */}
        <div className="flex-1 overflow-y-auto">
          {/* 快速添加 */}
          {filter.view === 'all' && <TodoQuickAdd />}

          {/* 列表内容 */}
          <div className="pb-8">
            {isLoadingItems ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-muted-foreground animate-in fade-in duration-500">
                <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 opacity-40" />
                </div>
                <span className="text-base font-medium">{t('todo:empty.noItems')}</span>
                <span className="text-sm text-muted-foreground/60 mt-1">Enjoy your day!</span>
              </div>
            ) : (
              <div className="flex flex-col">
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
          </div>
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

      {/* 番茄钟面板 */}
      <PomodoroPanel />
    </div>
  );
};

