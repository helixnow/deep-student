/**
 * SessionBrowser - 会话历史全宽多列浏览视图
 *
 * 类似 Notion Gallery View 的极简设计风格
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Search,
  Plus,
  Trash2,
  Edit2,
  Check,
  X,
  Clock,
  Layers,
  CalendarDays,
  Folder,
  ChevronDown,
  Tag,
  FileText,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { useContentSearch } from '../../hooks/useContentSearch';
import { useSessionTags } from '../../hooks/useSessionTags';
import { SearchResultList } from './SearchResultList';
import { TagFilterPanel, SessionTagBadges, AddTagInput } from './TagFilter';

// ============================================================================
// 类型定义
// ============================================================================

// ★ 文档28清理：移除 subject 字段
export interface SessionItem {
  id: string;
  mode: string;
  title?: string;
  /** 会话简介（自动生成） */
  description?: string;
  createdAt: string;
  updatedAt: string;
  groupId?: string;
  groupName?: string;
}

/** 分组信息（用于按分组浏览） */
export interface BrowserGroupInfo {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  sortOrder: number;
}

/** 浏览视图分组模式 */
export type BrowseGroupMode = 'time' | 'group';

interface SessionBrowserProps {
  /** 会话列表 */
  sessions: SessionItem[];
  /** 分组信息列表（用于按分组浏览） */
  groups?: BrowserGroupInfo[];
  /** 是否加载中 */
  isLoading?: boolean;
  /** 选择会话 */
  onSelectSession: (sessionId: string) => void;
  /** 删除会话 */
  onDeleteSession: (sessionId: string) => void;
  /** 创建新会话 */
  onCreateSession: () => void;
  /** 重命名会话 */
  onRenameSession?: (sessionId: string, newTitle: string) => void;
  /** 额外的 className */
  className?: string;
  /** 嵌入模式：不显示头部，由父组件控制顶栏（用于移动端） */
  embeddedMode?: boolean;
  /** 搜索查询（嵌入模式下由父组件控制） */
  externalSearchQuery?: string;
  /** 搜索查询变化回调（嵌入模式下使用） */
  onSearchQueryChange?: (query: string) => void;
}

// 时间分组类型
type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

// 获取会话的时间分组
const getTimeGroup = (isoString: string): TimeGroup => {
  const date = new Date(isoString);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOf7DaysAgo = new Date(startOfToday.getTime() - 7 * 86400000);
  const startOf30DaysAgo = new Date(startOfToday.getTime() - 30 * 86400000);

  if (date >= startOfToday) return 'today';
  if (date >= startOfYesterday) return 'yesterday';
  if (date >= startOf7DaysAgo) return 'previous7Days';
  if (date >= startOf30DaysAgo) return 'previous30Days';
  return 'older';
};

// 按时间分组会话
const groupSessionsByTime = (sessions: SessionItem[]): Map<TimeGroup, SessionItem[]> => {
  const groups = new Map<TimeGroup, SessionItem[]>();
  const order: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'];
  order.forEach((g) => groups.set(g, []));

  sessions.forEach((session) => {
    const group = getTimeGroup(session.updatedAt);
    groups.get(group)?.push(session);
  });

  return groups;
};

// ============================================================================
// 会话卡片组件 (Notion Style)
// ============================================================================

interface SessionCardProps {
  session: SessionItem;
  isEditing: boolean;
  editingTitle: string;
  tags?: string[];
  onSelect: () => void;
  onDelete: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditTitleChange: (value: string) => void;
  onAddTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
}

const SessionCard: React.FC<SessionCardProps> = ({
  session,
  isEditing,
  editingTitle,
  tags,
  onSelect,
  onDelete,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
  onAddTag,
  onRemoveTag,
}) => {
  const { t } = useTranslation(['chatV2', 'common']);
  const deleteConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const clearDeleteConfirmTimeout = useCallback(() => {
    if (!deleteConfirmTimeoutRef.current) return;
    clearTimeout(deleteConfirmTimeoutRef.current);
    deleteConfirmTimeoutRef.current = null;
  }, []);

  const resetDeleteConfirmation = useCallback(() => {
    setConfirmingDelete(false);
    clearDeleteConfirmTimeout();
  }, [clearDeleteConfirmTimeout]);

  // 格式化时间 - 简化版
  const formatTime = useCallback((isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays < 7) {
        return t('common.daysAgo', { count: diffDays });
    } else {
        return date.toLocaleDateString();
    }
  }, [t]);

  const handleCardClick = useCallback(() => {
    if (!isEditing) {
      onSelect();
    }
  }, [isEditing, onSelect]);

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirmingDelete) {
        resetDeleteConfirmation();
        onDelete();
        return;
      }

      setConfirmingDelete(true);
      clearDeleteConfirmTimeout();
      deleteConfirmTimeoutRef.current = setTimeout(() => {
        resetDeleteConfirmation();
      }, 2500);
    },
    [clearDeleteConfirmTimeout, confirmingDelete, onDelete, resetDeleteConfirmation]
  );

  const handleEditClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      resetDeleteConfirmation();
      onStartEdit();
    },
    [onStartEdit, resetDeleteConfirmation]
  );

  useEffect(() => clearDeleteConfirmTimeout, [clearDeleteConfirmTimeout]);

  useEffect(() => {
    if (!isEditing) return;
    resetDeleteConfirmation();
  }, [isEditing, resetDeleteConfirmation]);

  return (
    <div
      onClick={handleCardClick}
      onMouseLeave={resetDeleteConfirmation}
      className={cn(
        'group relative flex flex-col justify-between',
        'p-3 sm:p-3.5 h-[120px] sm:h-[140px]',
        'rounded-lg border border-transparent',
        'hover:bg-muted/40 hover:border-border/40 transition-colors',
        'cursor-pointer'
      )}
    >
      {/* 操作按钮 - 悬停显示 (右上角) */}
      {!isEditing && (
        <div className="absolute top-2 right-2 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-10">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleEditClick} aria-label={t('page.renameSession')} title={t('page.renameSession')} className="!h-7 !w-7">
            <Edit2 className="w-3.5 h-3.5" />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDeleteClick} className={cn('!h-7 !w-7', confirmingDelete ? 'text-rose-500 bg-rose-500/10' : 'hover:text-rose-500 hover:bg-rose-500/10')} aria-label={confirmingDelete ? t('common:confirm_delete') : t('page.deleteSession')} title={confirmingDelete ? t('common:confirm_delete') : t('page.deleteSession')}>
            {confirmingDelete ? <Trash2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
          </NotionButton>
        </div>
      )}

      {/* 顶部内容：图标 + 标题 */}
      <div className="flex-1 min-h-0">
        {isEditing ? (
          <div className="flex items-center gap-1.5 h-full" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              value={editingTitle}
              onChange={(e) => onEditTitleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onSaveEdit();
                } else if (e.key === 'Escape') {
                  onCancelEdit();
                }
              }}
              autoFocus
              className="flex-1 h-8 px-2 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
              placeholder={t('page.sessionNamePlaceholder')}
            />
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onSaveEdit(); }} className="text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10" aria-label="save">
              <Check className="w-4 h-4" />
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onCancelEdit(); }} aria-label="cancel">
              <X className="w-4 h-4" />
            </NotionButton>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* 标题 */}
            <h3 className={cn(
                "text-sm font-medium text-foreground line-clamp-2 leading-relaxed group-hover:text-primary transition-colors",
                !session.title && "text-muted-foreground italic"
            )}>
              {session.title || t('page.untitled')}
            </h3>
            {session.groupName && (
              <span className="inline-flex w-fit text-[11px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                {session.groupName}
              </span>
            )}
            {/* 简介 */}
            {session.description && (
              <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                {session.description}
              </p>
            )}
            {/* 标签 */}
            <div className="flex items-center gap-0.5 flex-wrap">
              {tags && tags.length > 0 && (
                <SessionTagBadges tags={tags} maxDisplay={3} onRemove={onRemoveTag} />
              )}
              {onAddTag && (
                <AddTagInput onAdd={onAddTag} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部属性：时间 */}
      <div className="mt-auto pt-2">
        <div className="flex items-center text-xs text-muted-foreground/60">
          <Clock className="w-3 h-3 mr-1" />
          {formatTime(session.updatedAt)}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 骨架屏组件
// ============================================================================

const SessionCardSkeleton: React.FC = () => (
  <div className="flex flex-col justify-between p-3 sm:p-3.5 h-[120px] sm:h-[140px] rounded-lg">
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
    <div className="mt-auto pt-2 flex items-center gap-1">
      <Skeleton className="h-3 w-3 rounded" />
      <Skeleton className="h-3 w-12" />
    </div>
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

/** 搜索模式：标题搜索 or 内容搜索 */
type SearchMode = 'title' | 'content';

export const SessionBrowser: React.FC<SessionBrowserProps> = ({
  sessions,
  groups = [],
  isLoading = false,
  onSelectSession,
  onDeleteSession,
  onCreateSession,
  onRenameSession,
  className,
  embeddedMode = false,
  externalSearchQuery,
  onSearchQueryChange,
}) => {
  const { t } = useTranslation(['chatV2']);

  // 搜索状态（嵌入模式下使用外部控制）
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const searchQuery = embeddedMode && externalSearchQuery !== undefined ? externalSearchQuery : internalSearchQuery;
  const setSearchQuery = embeddedMode && onSearchQueryChange ? onSearchQueryChange : setInternalSearchQuery;

  // 搜索模式：标题 / 内容
  const [searchMode, setSearchMode] = useState<SearchMode>('title');
  const contentSearch = useContentSearch(300);

  // 标签系统
  const sessionTags = useSessionTags();
  const [showTagFilter, setShowTagFilter] = useState(false);

  // 当 sessions 变化时加载标签
  const sessionIdsKey = useMemo(() => sessions.map((s) => s.id).join(','), [sessions]);
  useEffect(() => {
    const ids = sessions.map((s) => s.id);
    if (ids.length > 0) {
      void sessionTags.loadTagsForSessions(ids);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionIdsKey 已稳定追踪 sessions 变化
  }, [sessionIdsKey]);

  // 搜索模式同步
  useEffect(() => {
    if (searchMode === 'content') {
      contentSearch.search(searchQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contentSearch.search 是稳定引用
  }, [searchQuery, searchMode]);

  // 编辑状态
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // 分组模式状态
  const [groupMode, setGroupMode] = useState<BrowseGroupMode>(
    groups.length > 0 ? 'group' : 'time'
  );

  // 分组折叠状态（key = groupId 或 '__ungrouped__'）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // 时间分组标签
  const timeGroupLabels: Record<TimeGroup, string> = {
    today: t('page.timeGroups.today'),
    yesterday: t('page.timeGroups.yesterday'),
    previous7Days: t('page.timeGroups.previous7Days'),
    previous30Days: t('page.timeGroups.previous30Days'),
    older: t('page.timeGroups.older'),
  };

  // 搜索过滤 + 标签过滤
  const filteredSessions = useMemo(() => {
    let filtered = sessions;

    // 标题搜索（仅标题模式）
    if (searchMode === 'title' && searchQuery.trim()) {
      filtered = filtered.filter((s) =>
        (s.title || '').toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // 标签过滤
    if (sessionTags.selectedFilterTags.size > 0) {
      filtered = filtered.filter((s) => {
        const tags = sessionTags.tagsBySession.get(s.id) || [];
        return Array.from(sessionTags.selectedFilterTags).every((ft) => tags.includes(ft));
      });
    }

    return filtered;
  }, [sessions, searchQuery, searchMode, sessionTags.selectedFilterTags, sessionTags.tagsBySession]);

  // 按时间分组会话
  const timeGroupedSessions = useMemo(() => {
    return groupSessionsByTime(filteredSessions);
  }, [filteredSessions]);

  // 按分组归类会话
  const sessionGroupedByGroup = useMemo(() => {
    const sortedGroups = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
    const grouped: { group: BrowserGroupInfo; sessions: SessionItem[] }[] = [];
    const groupMap = new Map<string, SessionItem[]>();

    filteredSessions.forEach((session) => {
      if (!session.groupId) return;
      const list = groupMap.get(session.groupId) ?? [];
      list.push(session);
      groupMap.set(session.groupId, list);
    });

    sortedGroups.forEach((group) => {
      const groupSessions = groupMap.get(group.id) ?? [];
      // 组内按 updatedAt 降序排列
      groupSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      grouped.push({ group, sessions: groupSessions });
    });

    // 未分组会话
    const groupIdSet = new Set(groups.map((g) => g.id));
    const ungrouped = filteredSessions
      .filter((s) => !s.groupId || !groupIdSet.has(s.groupId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return { grouped, ungrouped };
  }, [filteredSessions, groups]);

  // 计算过滤后的数量
  const filteredCount = filteredSessions.length;

  // 开始编辑
  const handleStartEdit = useCallback((session: SessionItem) => {
    setEditingSessionId(session.id);
    setEditingTitle(session.title || '');
  }, []);

  // 保存编辑
  const handleSaveEdit = useCallback(
    (sessionId: string) => {
      const trimmedTitle = editingTitle.trim();
      if (trimmedTitle && onRenameSession) {
        onRenameSession(sessionId, trimmedTitle);
      }
      setEditingSessionId(null);
      setEditingTitle('');
    },
    [editingTitle, onRenameSession]
  );

  // 取消编辑
  const handleCancelEdit = useCallback(() => {
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  return (
    <div className={cn('flex flex-col h-full bg-background/50', className)}>
      {/* 顶部工具栏 - Notion 风格，响应式布局（嵌入模式下不显示） */}
      {!embeddedMode && (
        <div className="flex-shrink-0 border-b border-border/40 bg-background/95 backdrop-blur-sm px-3 sm:px-6 sticky top-0 z-20">
          {/* 主行：标题、操作按钮 */}
          <div className="flex items-center h-12 sm:h-14 gap-2 sm:gap-4">
            {/* 标题 */}
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <h1 className="text-sm sm:text-base font-medium text-foreground whitespace-nowrap">
                {t('browser.title')}
              </h1>
              <span className="text-xs px-1.5 py-0.5 rounded-md bg-muted/50 text-muted-foreground shrink-0">
                {filteredCount}
              </span>
            </div>

            {/* 分组模式滑块切换 */}
            {groups.length > 0 && (
              <div className="relative flex items-center h-8 rounded-lg bg-muted/50 p-0.5">
                {/* 滑块背景 */}
                <div
                  className={cn(
                    'absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-background shadow-sm border border-border/50',
                    'transition-transform duration-200 ease-out',
                    groupMode === 'time' ? 'translate-x-0' : 'translate-x-full'
                  )}
                />
                <button
                  onClick={() => setGroupMode('time')}
                  className={cn(
                    'relative z-10 flex items-center gap-1.5 px-3 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'time' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('browser.groupByTime')}
                >
                  <CalendarDays className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('browser.groupByTime')}</span>
                </button>
                <button
                  onClick={() => setGroupMode('group')}
                  className={cn(
                    'relative z-10 flex items-center gap-1.5 px-3 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'group' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('browser.groupByGroup')}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('browser.groupByGroup')}</span>
                </button>
              </div>
            )}

            <div className="flex-1 min-w-0" />

            {/* 标签过滤按钮 */}
            {sessionTags.allTags.length > 0 && (
              <NotionButton
                variant={showTagFilter || sessionTags.selectedFilterTags.size > 0 ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setShowTagFilter(!showTagFilter)}
                className={cn('shrink-0', sessionTags.selectedFilterTags.size > 0 && 'text-primary')}
              >
                <Tag className="w-3.5 h-3.5" />
                {sessionTags.selectedFilterTags.size > 0 && (
                  <span className="text-[10px] px-1 rounded-full bg-primary/10">{sessionTags.selectedFilterTags.size}</span>
                )}
              </NotionButton>
            )}

            {/* 桌面端搜索框 + 模式切换 */}
            <div className="hidden sm:flex items-center gap-1">
              <div className="relative flex items-center h-8 rounded-lg bg-muted/50 p-0.5">
                <button
                  onClick={() => setSearchMode('title')}
                  className={cn(
                    'relative z-10 flex items-center gap-1 px-2 h-full rounded-md text-[11px] font-medium transition-colors',
                    searchMode === 'title' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('search.titleMode')}
                >
                  <Search className="w-3 h-3" />
                  <span>{t('search.titleMode')}</span>
                </button>
                <button
                  onClick={() => setSearchMode('content')}
                  className={cn(
                    'relative z-10 flex items-center gap-1 px-2 h-full rounded-md text-[11px] font-medium transition-colors',
                    searchMode === 'content' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('search.contentMode')}
                >
                  <FileText className="w-3 h-3" />
                  <span>{t('search.contentMode')}</span>
                </button>
              </div>
              <div className="relative w-48 md:w-56">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={searchMode === 'content' ? t('search.contentPlaceholder') : t('page.searchPlaceholder')}
                  className="w-full h-9 pl-9 pr-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
                />
              </div>
            </div>

            {/* 新建按钮 */}
            <NotionButton variant="ghost" size="sm" onClick={onCreateSession} className="text-primary hover:bg-primary/10 shrink-0">
              <Plus className="w-4 h-4" />
              <span className="hidden xs:inline">{t('page.newSession')}</span>
            </NotionButton>
          </div>

          {/* 移动端搜索框 - 单独一行 */}
          <div className="sm:hidden pb-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={searchMode === 'content' ? t('search.contentPlaceholder') : t('page.searchPlaceholder')}
                  className="w-full h-9 pl-9 pr-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
                />
              </div>
              <button
                onClick={() => setSearchMode(searchMode === 'title' ? 'content' : 'title')}
                className={cn(
                  'shrink-0 h-9 px-2.5 rounded-md text-[11px] font-medium transition-colors',
                  searchMode === 'content' ? 'bg-primary/10 text-primary' : 'bg-muted/30 text-muted-foreground'
                )}
              >
                {searchMode === 'content' ? <FileText className="w-4 h-4" /> : <Search className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 嵌入模式下的搜索框 + 分组滑块切换 */}
      {embeddedMode && (
        <div className="flex-shrink-0 px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchMode === 'content' ? t('search.contentPlaceholder') : t('page.searchPlaceholder')}
                className="w-full h-9 pl-9 pr-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
              />
            </div>
            {groups.length > 0 && (
              <div className="relative flex items-center h-8 rounded-lg bg-muted/50 p-0.5 shrink-0">
                <div
                  className={cn(
                    'absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-background shadow-sm border border-border/50',
                    'transition-transform duration-200 ease-out',
                    groupMode === 'time' ? 'translate-x-0' : 'translate-x-full'
                  )}
                />
                <button
                  onClick={() => setGroupMode('time')}
                  className={cn(
                    'relative z-10 flex items-center gap-1 px-2 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'time' ? 'text-foreground' : 'text-muted-foreground'
                  )}
                  title={t('browser.groupByTime')}
                >
                  <CalendarDays className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setGroupMode('group')}
                  className={cn(
                    'relative z-10 flex items-center gap-1 px-2 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'group' ? 'text-foreground' : 'text-muted-foreground'
                  )}
                  title={t('browser.groupByGroup')}
                >
                  <Layers className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 标签过滤面板 */}
      {showTagFilter && sessionTags.allTags.length > 0 && (
        <div className="flex-shrink-0 border-b border-border/40 px-3 sm:px-6 py-3">
          <TagFilterPanel
            allTags={sessionTags.allTags}
            selectedTags={sessionTags.selectedFilterTags}
            onToggleTag={sessionTags.toggleFilterTag}
            onClear={sessionTags.clearFilter}
          />
        </div>
      )}

      {/* 内容区域 */}
      <CustomScrollArea className="flex-1" viewportClassName={cn("p-3 sm:p-6", embeddedMode && "pb-20")}>
        {/* 内容搜索结果 */}
        {searchMode === 'content' && searchQuery.trim().length >= 2 ? (
          <SearchResultList
            results={contentSearch.results}
            loading={contentSearch.loading}
            query={searchQuery}
            onSelectResult={onSelectSession}
          />
        ) : isLoading ? (
          // 加载状态骨架屏
          <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
            {Array.from({ length: 9 }).map((_, i) => (
              <SessionCardSkeleton key={i} />
            ))}
          </div>
        ) : filteredCount === 0 ? (
          // 空状态 - Notion 风格简洁设计
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
            <span className="text-sm mb-2">
              {searchQuery
                ? t('browser.noResults')
                : t('page.noSessions')}
            </span>
            <span className="text-xs text-muted-foreground/60 mb-4">
              {searchQuery
                ? t('browser.tryDifferentKeyword')
                : t('page.selectOrCreate')}
            </span>
            {!searchQuery && (
              <NotionButton variant="ghost" size="sm" onClick={onCreateSession} className="text-primary hover:underline">
                {t('page.createFirst')}
              </NotionButton>
            )}
          </div>
        ) : groupMode === 'time' ? (
          // 按时间分组显示会话卡片
          <div className="space-y-6 sm:space-y-8">
            {(['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'] as TimeGroup[]).map(
              (timeGroup) => {
                const timeSessions = timeGroupedSessions.get(timeGroup) || [];
                if (timeSessions.length === 0) return null;

                return (
                  <div key={timeGroup}>
                    {/* 分组标题 - 极简风格 */}
                    <div className="mb-4 flex items-center gap-2 group/header">
                      <span className="text-sm font-medium text-muted-foreground/80 group-hover/header:text-foreground transition-colors">
                        {timeGroupLabels[timeGroup]}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60">
                        {timeSessions.length}
                      </span>
                      <div className="flex-1 h-px bg-border/30 group-hover/header:bg-border/60 transition-colors" />
                    </div>

                    {/* 会话卡片网格 */}
                    <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
                      {timeSessions.map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          isEditing={editingSessionId === session.id}
                          editingTitle={editingTitle}
                          tags={sessionTags.tagsBySession.get(session.id)}
                          onSelect={() => onSelectSession(session.id)}
                          onDelete={() => onDeleteSession(session.id)}
                          onStartEdit={() => handleStartEdit(session)}
                          onSaveEdit={() => handleSaveEdit(session.id)}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={setEditingTitle}
                          onAddTag={(tag) => sessionTags.addTag(session.id, tag)}
                          onRemoveTag={(tag) => sessionTags.removeTag(session.id, tag)}
                        />
                      ))}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        ) : (
          // 按分组显示会话卡片
          <div className="space-y-6 sm:space-y-8">
            {sessionGroupedByGroup.grouped.map(({ group: sessionGroup, sessions: groupSessions }) => {
              if (groupSessions.length === 0) return null;

              // 分组标题带图标/emoji
              const displayIcon = sessionGroup.icon;
              const isEmoji = displayIcon && !/^[a-zA-Z]/.test(displayIcon);

              const isCollapsed = collapsedGroups.has(sessionGroup.id);

              return (
                <div key={sessionGroup.id}>
                  <div
                    className="mb-4 flex items-center gap-2 group/header cursor-pointer select-none"
                    onClick={() => toggleGroupCollapse(sessionGroup.id)}
                  >
                    <ChevronDown className={cn(
                      'w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200',
                      isCollapsed && '-rotate-90'
                    )} />
                    {isEmoji ? (
                      <span className="text-sm">{displayIcon}</span>
                    ) : (
                      <Folder className="w-4 h-4 text-muted-foreground/60 group-hover/header:text-foreground transition-colors" />
                    )}
                    <span className="text-sm font-medium text-muted-foreground/80 group-hover/header:text-foreground transition-colors">
                      {sessionGroup.name}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60">
                      {groupSessions.length}
                    </span>
                    <div className="flex-1 h-px bg-border/30 group-hover/header:bg-border/60 transition-colors" />
                  </div>

                  {!isCollapsed && (
                    <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
                      {groupSessions.map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          isEditing={editingSessionId === session.id}
                          editingTitle={editingTitle}
                          tags={sessionTags.tagsBySession.get(session.id)}
                          onSelect={() => onSelectSession(session.id)}
                          onDelete={() => onDeleteSession(session.id)}
                          onStartEdit={() => handleStartEdit(session)}
                          onSaveEdit={() => handleSaveEdit(session.id)}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={setEditingTitle}
                          onAddTag={(tag) => sessionTags.addTag(session.id, tag)}
                          onRemoveTag={(tag) => sessionTags.removeTag(session.id, tag)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* 未分组会话 */}
            {sessionGroupedByGroup.ungrouped.length > 0 && (() => {
              const isUngroupedCollapsed = collapsedGroups.has('__ungrouped__');
              return (
                <div>
                  <div
                    className="mb-4 flex items-center gap-2 group/header cursor-pointer select-none"
                    onClick={() => toggleGroupCollapse('__ungrouped__')}
                  >
                    <ChevronDown className={cn(
                      'w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200',
                      isUngroupedCollapsed && '-rotate-90'
                    )} />
                    <Folder className="w-4 h-4 text-muted-foreground/60 group-hover/header:text-foreground transition-colors" />
                    <span className="text-sm font-medium text-muted-foreground/80 group-hover/header:text-foreground transition-colors">
                      {t('browser.ungrouped')}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60">
                      {sessionGroupedByGroup.ungrouped.length}
                    </span>
                    <div className="flex-1 h-px bg-border/30 group-hover/header:bg-border/60 transition-colors" />
                  </div>

                  {!isUngroupedCollapsed && (
                    <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
                      {sessionGroupedByGroup.ungrouped.map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          isEditing={editingSessionId === session.id}
                          editingTitle={editingTitle}
                          tags={sessionTags.tagsBySession.get(session.id)}
                          onSelect={() => onSelectSession(session.id)}
                          onDelete={() => onDeleteSession(session.id)}
                          onStartEdit={() => handleStartEdit(session)}
                          onSaveEdit={() => handleSaveEdit(session.id)}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={setEditingTitle}
                          onAddTag={(tag) => sessionTags.addTag(session.id, tag)}
                          onRemoveTag={(tag) => sessionTags.removeTag(session.id, tag)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default SessionBrowser;
