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
      <div className="px-2 pt-3 pb-1">
        <div className="text-xs font-medium text-muted-foreground px-2 mb-1 uppercase tracking-wider">
          {t('todo:sections.smartViews')}
        </div>
        {SMART_VIEWS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            onClick={() => handleSmartViewClick(id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
              filter.view === id && activeListId === null
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-foreground/80 hover:bg-accent/50'
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-border mx-3 my-1" />

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="flex items-center justify-between px-2 mb-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('todo:sections.lists')}
          </span>
          <button
            onClick={() => setIsCreating(true)}
            className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 新建列表输入 */}
        {isCreating && (
          <div className="px-1 mb-1">
            <input
              autoFocus
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => { if (!newListTitle.trim()) setIsCreating(false); }}
              placeholder={t('todo:actions.newListPlaceholder')}
              className="w-full px-2 py-1 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
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
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                activeListId === list.id && filter.view === 'all'
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-foreground/80 hover:bg-accent/50'
              )}
            >
              {list.isDefault ? (
                <Inbox className="w-4 h-4 flex-shrink-0 text-blue-500" />
              ) : (
                <CheckSquare
                  className="w-4 h-4 flex-shrink-0"
                  style={{ color: list.color || undefined }}
                />
              )}
              <span className="truncate flex-1 text-left">{list.title}</span>
              {list.isFavorite && (
                <Star className="w-3 h-3 fill-yellow-400 text-yellow-400 flex-shrink-0" />
              )}
            </button>

            {/* 上下文菜单触发 */}
            {!list.isDefault && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenuId(contextMenuId === list.id ? null : list.id);
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent/80 transition-opacity"
              >
                <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            )}

            {/* 简易上下文菜单 */}
            {contextMenuId === list.id && (
              <div className="absolute right-0 top-full z-50 mt-1 w-36 bg-popover border border-border rounded-md shadow-md py-1">
                <button
                  onClick={() => {
                    toggleListFavorite(list.id);
                    setContextMenuId(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                >
                  <Star className="w-3.5 h-3.5" />
                  {list.isFavorite ? t('todo:actions.unfavorite') : t('todo:actions.favorite')}
                </button>
                <button
                  onClick={() => {
                    deleteList(list.id);
                    setContextMenuId(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('common:actions.delete')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
