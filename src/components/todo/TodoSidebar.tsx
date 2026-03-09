/**
 * TodoSidebar - 待办列表侧边栏
 *
 * 显示所有待办列表 + 智能视图（今日、即将到期、已过期）
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Inbox, Star, Calendar, AlertTriangle, Clock, Plus,
  MoreHorizontal, Trash2, CheckSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTodoStore } from './useTodoStore';
import type { TodoViewFilter } from './types';

const SMART_VIEWS: { id: TodoViewFilter; icon: React.ElementType; labelKey: string }[] = [
  { id: 'all', icon: Inbox, labelKey: 'todo:views.inbox' },
  { id: 'today', icon: Calendar, labelKey: 'todo:views.today' },
  { id: 'upcoming', icon: Clock, labelKey: 'todo:views.upcoming' },
  { id: 'overdue', icon: AlertTriangle, labelKey: 'todo:views.overdue' },
];

export const TodoSidebar: React.FC = () => {
  const { t } = useTranslation(['todo', 'common']);
  const {
    lists, activeListId, filter,
    setActiveList, setViewFilter,
    createList, deleteList, toggleListFavorite,
  } = useTodoStore();

  const [isCreating, setIsCreating] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);

  const handleCreateList = useCallback(async () => {
    if (!newListTitle.trim()) return;
    try {
      const list = await createList(newListTitle.trim());
      setNewListTitle('');
      setIsCreating(false);
      setActiveList(list.id);
      setViewFilter('all');
    } catch {
      // error handled in store
    }
  }, [newListTitle, createList, setActiveList, setViewFilter]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreateList();
    if (e.key === 'Escape') {
      setIsCreating(false);
      setNewListTitle('');
    }
  }, [handleCreateList]);

  const handleSmartViewClick = useCallback((view: TodoViewFilter) => {
    setViewFilter(view);
    if (view === 'all') {
      const defaultList = lists.find(l => l.isDefault) || lists[0];
      if (defaultList) setActiveList(defaultList.id);
    } else {
      setActiveList(null);
    }
  }, [lists, setActiveList, setViewFilter]);

  const handleListClick = useCallback((listId: string) => {
    setActiveList(listId);
    setViewFilter('all');
  }, [setActiveList, setViewFilter]);

  return (
    <div className="w-60 flex-shrink-0 border-r border-border flex flex-col h-full bg-muted/30">
      {/* 智能视图 */}
      <div className="px-3 pt-4 pb-2">
        <div className="text-xs font-semibold text-muted-foreground/70 px-2 mb-2 tracking-wider">
          {t('todo:sections.smartViews')}
        </div>
        <div className="space-y-0.5">
          {SMART_VIEWS.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              onClick={() => handleSmartViewClick(id)}
              className={cn(
                'w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-all duration-200',
                filter.view === id && activeListId === null
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-foreground/70 hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className={cn(
                "w-4 h-4 flex-shrink-0",
                filter.view === id && activeListId === null ? "text-primary" : "text-muted-foreground"
              )} />
              <span className="truncate">{t(labelKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-border/50 mx-4 my-2" />

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="flex items-center justify-between px-2 mb-2 group/header">
          <span className="text-xs font-semibold text-muted-foreground/70 tracking-wider">
            {t('todo:sections.lists')}
          </span>
          <button
            onClick={() => setIsCreating(true)}
            className="p-1 rounded-md opacity-0 group-hover/header:opacity-100 hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-200"
            title={t('todo:actions.newListPlaceholder')}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="space-y-0.5">
          {/* 新建列表输入 */}
          {isCreating && (
            <div className="px-1 mb-2">
              <input
                autoFocus
                value={newListTitle}
                onChange={(e) => setNewListTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => { if (!newListTitle.trim()) setIsCreating(false); }}
                placeholder={t('todo:actions.newListPlaceholder')}
                className="w-full px-3 py-1.5 text-sm bg-background border shadow-sm rounded-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
              />
            </div>
          )}

          {/* 列表项 */}
          {lists.map((list) => (
            <div
              key={list.id}
              className="group relative"
            >
              <button
                onClick={() => handleListClick(list.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-all duration-200',
                  activeListId === list.id && filter.view === 'all'
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-foreground/70 hover:bg-accent hover:text-foreground'
                )}
              >
                {list.isDefault ? (
                  <Inbox className={cn(
                    "w-4 h-4 flex-shrink-0",
                    activeListId === list.id && filter.view === 'all' ? "text-primary" : "text-blue-500/80"
                  )} />
                ) : (
                  <CheckSquare
                    className="w-4 h-4 flex-shrink-0"
                    style={{ color: list.color || (activeListId === list.id && filter.view === 'all' ? undefined : 'var(--muted-foreground)') }}
                  />
                )}
                <span className="truncate flex-1 text-left">{list.title}</span>
                {list.isFavorite && (
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 flex-shrink-0" />
                )}
              </button>

              {/* 上下文菜单触发 */}
              {!list.isDefault && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setContextMenuId(contextMenuId === list.id ? null : list.id);
                  }}
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-all duration-200",
                    contextMenuId === list.id ? "opacity-100 bg-accent text-foreground" : "opacity-0 group-hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 text-muted-foreground"
                  )}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
              )}

              {/* 简易上下文菜单 */}
              {contextMenuId === list.id && (
                <div className="absolute right-0 top-full z-50 mt-1 w-40 bg-popover border border-border/50 rounded-lg shadow-lg py-1.5 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                  <button
                    onClick={() => {
                      toggleListFavorite(list.id);
                      setContextMenuId(null);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent transition-colors"
                  >
                    <Star className={cn("w-4 h-4", list.isFavorite && "fill-amber-400 text-amber-400")} />
                    {list.isFavorite ? t('todo:actions.unfavorite') : t('todo:actions.favorite')}
                  </button>
                  <button
                    onClick={() => {
                      deleteList(list.id);
                      setContextMenuId(null);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('common:actions.delete')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
