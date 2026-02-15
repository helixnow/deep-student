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
  ArrowLeft,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';

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

interface SessionBrowserProps {
  /** 会话列表 */
  sessions: SessionItem[];
  /** 是否加载中 */
  isLoading?: boolean;
  /** 选择会话 */
  onSelectSession: (sessionId: string) => void;
  /** 删除会话 */
  onDeleteSession: (sessionId: string) => void;
  /** 创建新会话 */
  onCreateSession: () => void;
  /** 刷新会话列表 */
  onRefresh?: () => void;
  /** 重命名会话 */
  onRenameSession?: (sessionId: string, newTitle: string) => void;
  /** 返回侧边栏模式 */
  onBack: () => void;
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
  onSelect: () => void;
  onDelete: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditTitleChange: (value: string) => void;
}

const SessionCard: React.FC<SessionCardProps> = ({
  session,
  isEditing,
  editingTitle,
  onSelect,
  onDelete,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
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
        <div className="absolute top-2 right-2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
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

export const SessionBrowser: React.FC<SessionBrowserProps> = ({
  sessions,
  isLoading = false,
  onSelectSession,
  onDeleteSession,
  onCreateSession,
  onRefresh,
  onRenameSession,
  onBack,
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

  // 编辑状态
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // 刷新动画状态
  const [refreshing, setRefreshing] = useState(false);

  // 时间分组标签
  const timeGroupLabels: Record<TimeGroup, string> = {
    today: t('page.timeGroups.today'),
    yesterday: t('page.timeGroups.yesterday'),
    previous7Days: t('page.timeGroups.previous7Days'),
    previous30Days: t('page.timeGroups.previous30Days'),
    older: t('page.timeGroups.older'),
  };

  // 过滤和分组会话
  const groupedSessions = useMemo(() => {
    const filtered = searchQuery.trim()
      ? sessions.filter((s) =>
          (s.title || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
      : sessions;
    return groupSessionsByTime(filtered);
  }, [sessions, searchQuery]);

  // 计算过滤后的数量
  const filteredCount = useMemo(() => {
    let count = 0;
    groupedSessions.forEach((group) => (count += group.length));
    return count;
  }, [groupedSessions]);

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

  // 刷新
  const handleRefresh = useCallback(async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  }, [onRefresh, refreshing]);

  return (
    <div className={cn('flex flex-col h-full bg-background/50', className)}>
      {/* 顶部工具栏 - Notion 风格，响应式布局（嵌入模式下不显示） */}
      {!embeddedMode && (
        <div className="flex-shrink-0 border-b border-border/40 bg-background/95 backdrop-blur-sm px-3 sm:px-6 sticky top-0 z-20">
          {/* 主行：返回、标题、操作按钮 */}
          <div className="flex items-center h-12 sm:h-14 gap-2 sm:gap-4">
            {/* 返回按钮 */}
            <NotionButton variant="ghost" size="sm" onClick={onBack} className="-ml-1">
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">{t('browser.back')}</span>
            </NotionButton>

            <div className="hidden sm:block h-4 w-px bg-border/40" />

            {/* 标题 */}
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <h1 className="text-sm sm:text-base font-medium text-foreground whitespace-nowrap">
                {t('browser.title')}
              </h1>
              <span className="text-xs px-1.5 py-0.5 rounded-md bg-muted/50 text-muted-foreground shrink-0">
                {filteredCount}
              </span>
            </div>

            <div className="flex-1 min-w-0" />

            {/* 桌面端搜索框 */}
            <div className="hidden sm:block relative w-48 md:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('page.searchPlaceholder')}
                className="w-full h-9 pl-9 pr-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
              />
            </div>

            {/* 刷新按钮 */}
            {onRefresh && (
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRefresh} disabled={refreshing} aria-label={t('browser.refresh')} title={t('browser.refresh')}>
                <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
              </NotionButton>
            )}

            {/* 新建按钮 - Notion 风格主操作 */}
            <NotionButton variant="ghost" size="sm" onClick={onCreateSession} className="text-primary hover:bg-primary/10 shrink-0">
              <Plus className="w-4 h-4" />
              <span className="hidden xs:inline">{t('page.newSession')}</span>
            </NotionButton>
          </div>

          {/* 移动端搜索框 - 单独一行 */}
          <div className="sm:hidden pb-2.5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('page.searchPlaceholder')}
                className="w-full h-9 pl-9 pr-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
              />
            </div>
          </div>
        </div>
      )}

      {/* 嵌入模式下的搜索框 */}
      {embeddedMode && (
        <div className="flex-shrink-0 px-3 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('page.searchPlaceholder')}
              className="w-full h-9 pl-9 pr-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
            />
          </div>
        </div>
      )}

      {/* 内容区域 */}
      <CustomScrollArea className="flex-1" viewportClassName={cn("p-3 sm:p-6", embeddedMode && "pb-20")}>
        {isLoading ? (
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
        ) : (
          // 分组显示会话卡片
          <div className="space-y-6 sm:space-y-8">
            {(['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'] as TimeGroup[]).map(
              (group) => {
                const groupSessions = groupedSessions.get(group) || [];
                if (groupSessions.length === 0) return null;

                return (
                  <div key={group}>
                    {/* 分组标题 - 极简风格 */}
                    <div className="mb-4 flex items-center gap-2 group/header">
                      <span className="text-sm font-medium text-muted-foreground/80 group-hover/header:text-foreground transition-colors">
                        {timeGroupLabels[group]}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60">
                        {groupSessions.length}
                      </span>
                      <div className="flex-1 h-px bg-border/30 group-hover/header:bg-border/60 transition-colors" />
                    </div>

                    {/* 会话卡片网格 */}
                    <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
                      {groupSessions.map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          isEditing={editingSessionId === session.id}
                          editingTitle={editingTitle}
                          onSelect={() => onSelectSession(session.id)}
                          onDelete={() => onDeleteSession(session.id)}
                          onStartEdit={() => handleStartEdit(session)}
                          onSaveEdit={() => handleSaveEdit(session.id)}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={setEditingTitle}
                        />
                      ))}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default SessionBrowser;
