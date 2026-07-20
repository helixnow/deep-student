/**
 * SessionBrowser - 会话历史全宽多列浏览视图
 *
 * 类似 简洁 Gallery View 的极简设计风格
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import {
  Chat,
  MagnifyingGlass,
  Plus,
  Trash,
  PencilSimple,
  Check,
  X,
  Clock,
  Stack,
  CalendarBlank,
  Folder,
  CaretDown,
  Tag,
  FileText,
  CircleNotch,
  DownloadSimple,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { getSessionTitleText } from '@/features/chat/utils/sessionTitle';
import { useContentSearch } from '../../hooks/useContentSearch';
import { useSessionTags } from '../../hooks/useSessionTags';
import { SearchResultList } from './SearchResultList';
import { TagFilterPanel, SessionTagBadges, AddTagInput } from './TagFilter';
import { Input } from '@/components/ui/shad/Input';
import { groupTaskSessions, summarizeTaskSession } from './taskCenter';
import { exportSessionToFile } from './sessionExport';
import { useSessionSearch } from './useSessionSearch';

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
  metadata?: Record<string, unknown>;
  workspaceKey?: string;
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
export type BrowseGroupMode = 'time' | 'group' | 'workspace';

/** 从会话浏览器打开会话后跳转的目标视图（'sidebar' = 返回聊天侧栏视图） */
export type SessionOpenTarget = 'sidebar' | 'browser';

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
// 使用日历运算（而非固定 86400000ms 偏移）计算本地日界，避免夏令时切换日产生 1 小时偏差
const getTimeGroup = (isoString: string): TimeGroup => {
  const date = new Date(isoString);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const startOfToday = new Date(year, month, day);
  const startOfYesterday = new Date(year, month, day - 1);
  const startOf7DaysAgo = new Date(year, month, day - 7);
  const startOf30DaysAgo = new Date(year, month, day - 30);

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
// 会话卡片组件 (Clean Style)
// ============================================================================

interface SessionCardProps {
  session: SessionItem;
  isEditing: boolean;
  /** 编辑中的标题（仅编辑态卡片传实际值，非编辑卡片传空串以避免重命名时全网格重渲） */
  editingTitle: string;
  tags?: string[];
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onStartEdit: (session: SessionItem) => void;
  onSaveEdit: (sessionId: string) => void;
  onCancelEdit: () => void;
  onEditTitleChange: (value: string) => void;
  onAddTag?: (sessionId: string, tag: string) => void;
  onRemoveTag?: (sessionId: string, tag: string) => void;
}

// 🚀 性能：React.memo + 稳定回调，避免任一卡片状态变化时全网格重渲
const SessionCard: React.FC<SessionCardProps> = React.memo(({
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
  const fallbackTitle = t('page.untitled');
  const sessionTitle = getSessionTitleText(session.title, fallbackTitle);
  // 🚀 性能：按 session 引用缓存任务摘要，避免每次渲染重新解析 metadata
  const taskSummary = useMemo(() => summarizeTaskSession(session), [session]);
  const hasTaskSummary = taskSummary.status !== 'unknown'
    || taskSummary.artifactCount > 0
    || taskSummary.changeCount > 0
    || Boolean(taskSummary.lastArtifact);
  const deleteConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 触屏无 hover:重命名/删除按钮常显(与 FinderFileItem N-4 同范式)
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

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
      onSelect(session.id);
    }
  }, [isEditing, onSelect, session.id]);

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirmingDelete) {
        resetDeleteConfirmation();
        onDelete(session.id);
        return;
      }

      setConfirmingDelete(true);
      clearDeleteConfirmTimeout();
      deleteConfirmTimeoutRef.current = setTimeout(() => {
        resetDeleteConfirmation();
      }, 2500);
    },
    [clearDeleteConfirmTimeout, confirmingDelete, onDelete, resetDeleteConfirmation, session.id]
  );

  const handleEditClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      resetDeleteConfirmation();
      onStartEdit(session);
    },
    [onStartEdit, resetDeleteConfirmation, session]
  );

  const handleSaveEdit = useCallback(() => {
    onSaveEdit(session.id);
  }, [onSaveEdit, session.id]);

  const handleAddTag = useCallback(
    (tag: string) => onAddTag?.(session.id, tag),
    [onAddTag, session.id]
  );

  const handleRemoveTag = useCallback(
    (tag: string) => onRemoveTag?.(session.id, tag),
    [onRemoveTag, session.id]
  );

  // 导出会话（Markdown）：chat_v2_export_session → 保存对话框
  const handleExportClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (exporting) return;
      resetDeleteConfirmation();
      setExporting(true);
      void exportSessionToFile({
        sessionId: session.id,
        title: sessionTitle === fallbackTitle ? undefined : sessionTitle,
        format: 'markdown',
      }).finally(() => setExporting(false));
    },
    [exporting, fallbackTitle, resetDeleteConfirmation, session.id, sessionTitle]
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
        'p-3 sm:p-3.5 min-h-[120px] sm:min-h-[140px]',
        'rounded-lg border border-transparent',
        'hover:bg-[var(--interactive-hover)] hover:border-border/40 transition-colors',
        'cursor-pointer'
      )}
    >
      {/* 操作按钮 - 悬停显示 (右上角);触屏无 hover → 常显并放大触控目标 */}
      {!isEditing && (
        <div
          className={cn(
            'absolute top-2 right-2 flex gap-0.5 transition-opacity z-10',
            isTouchPrimary ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          )}
        >
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleEditClick} aria-label={t('page.renameSession')} title={t('page.renameSession')} className={isTouchPrimary ? '!h-9 !w-9' : '!h-7 !w-7'}>
            <PencilSimple size={isTouchPrimary ? 16 : 14} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleExportClick} disabled={exporting} aria-label={t('browser.exportSession', '导出会话')} title={t('browser.exportSession', '导出会话')} className={isTouchPrimary ? '!h-9 !w-9' : '!h-7 !w-7'}>
            {exporting ? <CircleNotch size={isTouchPrimary ? 16 : 14} className="animate-spin" /> : <DownloadSimple size={isTouchPrimary ? 16 : 14} />}
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleDeleteClick} className={cn(isTouchPrimary ? '!h-9 !w-9' : '!h-7 !w-7', confirmingDelete ? 'text-danger bg-danger/10' : 'hover:text-danger hover:bg-danger/10')} aria-label={confirmingDelete ? t('common:confirm_delete') : t('page.deleteSession')} title={confirmingDelete ? t('common:confirm_delete') : t('page.deleteSession')}>
            {confirmingDelete ? <Trash size={isTouchPrimary ? 16 : 14} /> : <X size={isTouchPrimary ? 16 : 14} />}
          </DsButton>
        </div>
      )}

      {/* 顶部内容：图标 + 标题 */}
      <div className="flex-1 min-h-0">
        {isEditing ? (
          <div className="flex items-center gap-1.5 h-full" onClick={(e) => e.stopPropagation()}>
            <Input
              type="text"
              value={editingTitle}
              onChange={(e) => onEditTitleChange(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                // IME 安全：中文输入法组合期间的 Enter/Escape 只作用于候选词
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSaveEdit();
                } else if (e.key === 'Escape') {
                  onCancelEdit();
                }
              }}
              autoFocus
              className="flex-1 h-8"
              placeholder={t('page.sessionNamePlaceholder')}
            />
            <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleSaveEdit(); }} className="text-success hover:bg-success/10" aria-label={t('page.saveSessionName')} title={t('page.saveSessionName')}>
              <Check size={16} />
            </DsButton>
            <DsButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); onCancelEdit(); }} aria-label={t('page.cancelEdit')} title={t('page.cancelEdit')}>
              <X size={16} />
            </DsButton>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* 标题 */}
            <h3 className={cn(
                "text-sm font-medium text-foreground line-clamp-2 leading-relaxed group-hover:text-primary transition-colors",
                // 触屏操作按钮常显（右上角约 112px 宽），标题预留空间避免被遮挡
                isTouchPrimary && "pr-28",
                sessionTitle === fallbackTitle && "text-muted-foreground italic"
            )}>
              {sessionTitle}
            </h3>
            {session.groupName && (
              <span className="inline-flex w-fit text-[11px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                {session.groupName}
              </span>
            )}
            {hasTaskSummary && <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
                taskSummary.status === 'running' && 'bg-info/10 text-info',
                taskSummary.status === 'blocked' && 'bg-warning/10 text-warning',
                taskSummary.status === 'completed' && 'bg-success/10 text-success',
              )}>
                {taskSummary.status === 'running' && <CircleNotch size={10} className="animate-spin" />}
                {t(`browser.taskStatus.${taskSummary.status}`)}
              </span>
              {taskSummary.artifactCount > 0 && <span>{t('browser.taskArtifacts', { count: taskSummary.artifactCount })}</span>}
              {taskSummary.changeCount > 0 && <span>{t('browser.taskChanges', { count: taskSummary.changeCount })}</span>}
            </div>}
            {taskSummary.lastArtifact && (
              <p className="truncate text-[11px] text-muted-foreground" title={taskSummary.lastArtifact}>
                {taskSummary.lastArtifact}
              </p>
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
                <SessionTagBadges tags={tags} maxDisplay={3} onRemove={onRemoveTag ? handleRemoveTag : undefined} />
              )}
              {onAddTag && (
                <AddTagInput onAdd={handleAddTag} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部属性：时间 */}
      <div className="mt-auto pt-2">
        <div className="flex items-center text-xs text-muted-foreground/60">
          <Clock size={12} className="mr-1" />
          {formatTime(session.updatedAt)}
        </div>
      </div>
    </div>
  );
});

SessionCard.displayName = 'SessionCard';

// ============================================================================
// 骨架屏组件
// ============================================================================

const SessionCardSkeleton: React.FC = () => (
  <div className="flex flex-col justify-between p-3 sm:p-3.5 min-h-[120px] sm:min-h-[140px] rounded-lg">
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

  // 标题模式下的会话元信息搜索（chat_v2_search_sessions，命中标题/描述/标签），
  // 补充纯前端的标题子串过滤
  const sessionSearch = useSessionSearch(searchQuery, searchMode === 'title');

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
  // 🚀 性能：镜像 editingTitle 到 ref，让 handleSaveEdit 不依赖 editingTitle，
  // 保持回调稳定（否则重命名时每键都会使全部卡片的 memo 失效）
  const editingTitleRef = useRef('');

  const handleEditTitleChange = useCallback((value: string) => {
    editingTitleRef.current = value;
    setEditingTitle(value);
  }, []);

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
  const timeGroupLabels: Record<TimeGroup, string> = useMemo(() => ({
    today: t('page.timeGroups.today'),
    yesterday: t('page.timeGroups.yesterday'),
    previous7Days: t('page.timeGroups.previous7Days'),
    previous30Days: t('page.timeGroups.previous30Days'),
    older: t('page.timeGroups.older'),
  }), [t]);

  // 搜索过滤 + 标签过滤
  const filteredSessions = useMemo(() => {
    let filtered = sessions;

    // 标题搜索（仅标题模式）：
    // 前端标题子串过滤即时响应，chat_v2_search_sessions 的结果（命中描述/标签）异步补充
    if (searchMode === 'title' && searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const titleMatched = filtered.filter((s) =>
        (s.title || '').toLowerCase().includes(query)
      );

      const seenIds = new Set(titleMatched.map((s) => s.id));
      const sessionById = new Map(sessions.map((s) => [s.id, s]));
      const backendExtra: SessionItem[] = [];
      for (const hit of sessionSearch.results) {
        if (seenIds.has(hit.id)) continue;
        seenIds.add(hit.id);
        // 优先复用列表里已有的会话对象（带 groupName 等展示字段），否则从后端结果映射
        const known = sessionById.get(hit.id);
        backendExtra.push(
          known ?? {
            id: hit.id,
            mode: hit.mode,
            title: hit.title,
            description: hit.description,
            createdAt: hit.createdAt,
            updatedAt: hit.updatedAt,
            groupId: hit.groupId,
            metadata: hit.metadata,
          }
        );
      }
      filtered = [...titleMatched, ...backendExtra];
    }

    // 标签过滤
    if (sessionTags.selectedFilterTags.size > 0) {
      filtered = filtered.filter((s) => {
        const tags = sessionTags.tagsBySession.get(s.id) || [];
        return Array.from(sessionTags.selectedFilterTags).every((ft) => tags.includes(ft));
      });
    }

    return filtered;
  }, [sessions, searchQuery, searchMode, sessionSearch.results, sessionTags.selectedFilterTags, sessionTags.tagsBySession]);

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

    // 未分组会话只展示真正没有 groupId 的会话。
    // 有 groupId 但分组缺失通常代表归档/删除后的 stale state，不能降级成全局会话。
    const ungrouped = filteredSessions
      .filter((s) => !s.groupId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return { grouped, ungrouped };
  }, [filteredSessions, groups]);

  const sessionsGroupedByWorkspace = useMemo(() => {
    return [...groupTaskSessions(filteredSessions).entries()]
      .map(([workspaceKey, workspaceSessions]) => ({
        workspaceKey,
        sessions: [...workspaceSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .sort((a, b) => a.workspaceKey.localeCompare(b.workspaceKey));
  }, [filteredSessions]);

  // 计算过滤后的数量
  const filteredCount = filteredSessions.length;

  // 开始编辑
  const handleStartEdit = useCallback((session: SessionItem) => {
    const initialTitle = getSessionTitleText(session.title, '');
    setEditingSessionId(session.id);
    editingTitleRef.current = initialTitle;
    setEditingTitle(initialTitle);
  }, []);

  // 保存编辑（读 ref 而非 state，保持回调稳定）
  const handleSaveEdit = useCallback(
    (sessionId: string) => {
      const trimmedTitle = editingTitleRef.current.trim();
      if (trimmedTitle && onRenameSession) {
        onRenameSession(sessionId, trimmedTitle);
      }
      setEditingSessionId(null);
      editingTitleRef.current = '';
      setEditingTitle('');
    },
    [onRenameSession]
  );

  // 取消编辑
  const handleCancelEdit = useCallback(() => {
    setEditingSessionId(null);
    editingTitleRef.current = '';
    setEditingTitle('');
  }, []);

  return (
    <div className={cn('flex flex-col h-full bg-background/50', className)}>
      {/* 顶部工具栏 - 简洁风格，响应式布局（嵌入模式下不显示） */}
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
            {(
              <div className="relative flex items-center h-8 rounded-lg bg-muted/50 p-0.5">
                <button
                  onClick={() => setGroupMode('time')}
                  className={cn(
                    'relative z-10 flex items-center gap-1.5 px-3 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'time' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('browser.groupByTime')}
                >
                  <CalendarBlank size={14} />
                  <span className="hidden sm:inline">{t('browser.groupByTime')}</span>
                </button>
                <button
                  onClick={() => setGroupMode('group')}
                  className={cn(
                    'relative z-10 flex items-center gap-1.5 px-3 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'group' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('browser.groupByGroup')}
                >
                  <Stack size={14} />
                  <span className="hidden sm:inline">{t('browser.groupByGroup')}</span>
                </button>
                <button
                  onClick={() => setGroupMode('workspace')}
                  className={cn(
                    'relative z-10 flex items-center gap-1.5 px-3 h-full rounded-md text-xs font-medium transition-colors',
                    groupMode === 'workspace' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground/70'
                  )}
                  title={t('browser.groupByWorkspace')}
                >
                  <Folder size={14} />
                  <span className="hidden sm:inline">{t('browser.groupByWorkspace')}</span>
                </button>
              </div>
            )}

            <div className="flex-1 min-w-0" />

            {/* 标签过滤按钮 */}
            {sessionTags.allTags.length > 0 && (
              <DsButton
                variant={showTagFilter || sessionTags.selectedFilterTags.size > 0 ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setShowTagFilter(!showTagFilter)}
                className={cn('shrink-0', sessionTags.selectedFilterTags.size > 0 && 'text-primary')}
              >
                <Tag size={14} />
                {sessionTags.selectedFilterTags.size > 0 && (
                  <span className="text-2xs px-1 rounded-full bg-primary/10">{sessionTags.selectedFilterTags.size}</span>
                )}
              </DsButton>
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
                  <MagnifyingGlass size={12} />
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
                  <FileText size={12} />
                  <span>{t('search.contentMode')}</span>
                </button>
              </div>
              <div className="relative w-48 md:w-56">
                <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={searchMode === 'content' ? t('search.contentPlaceholder') : t('page.searchPlaceholder')}
                  className="w-full h-9 pl-9 pr-3"
                />
              </div>
            </div>

            {/* 新建按钮 */}
            <DsButton variant="ghost" size="sm" onClick={onCreateSession} className="text-primary hover:bg-primary/10 shrink-0">
              <Plus size={16} />
              <span className="hidden xs:inline">{t('page.newSession')}</span>
            </DsButton>
          </div>

          {/* （原 sm:hidden 移动端搜索行为死代码：非嵌入形态仅在 ≥768px 渲染，已移除；
              移动端搜索/模式切换统一走下方 embeddedMode 分支） */}
        </div>
      )}

      {/* 嵌入模式下的搜索框 + 模式切换 + 标签过滤 + 分组滑块切换
          400px 窄屏改造：单行四组件挤压 → 拆两行。
          第一行：搜索框（flex-1）+ 标题/内容模式切换 + 标签过滤；
          第二行：分组滑块整行拉伸（三个 flex-1 分段，图标+文字，40px 高触控目标）。 */}
      {embeddedMode && (
        <div className="flex-shrink-0 px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchMode === 'content' ? t('search.contentPlaceholder') : t('page.searchPlaceholder')}
                className="w-full h-10 pl-9 pr-3"
              />
            </div>
            {/* 标题/内容搜索模式切换（补齐移动端与桌面的功能对等） */}
            <button
              onClick={() => setSearchMode(searchMode === 'title' ? 'content' : 'title')}
              className={cn(
                'shrink-0 h-10 min-w-10 px-2.5 rounded-md text-[11px] font-medium transition-colors inline-flex items-center justify-center',
                searchMode === 'content' ? 'bg-primary/10 text-primary' : 'bg-muted/30 text-muted-foreground'
              )}
              title={searchMode === 'content' ? t('search.contentMode') : t('search.titleMode')}
              aria-label={searchMode === 'content' ? t('search.contentMode') : t('search.titleMode')}
              aria-pressed={searchMode === 'content'}
            >
              {searchMode === 'content' ? <FileText size={16} /> : <MagnifyingGlass size={16} />}
            </button>
            {/* 标签过滤入口（补齐移动端与桌面的功能对等） */}
            {sessionTags.allTags.length > 0 && (
              <DsButton
                variant={showTagFilter || sessionTags.selectedFilterTags.size > 0 ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setShowTagFilter(!showTagFilter)}
                className={cn('shrink-0 !h-10 min-w-10', sessionTags.selectedFilterTags.size > 0 && 'text-primary')}
                aria-label={t('tags.filterTitle')}
                title={t('tags.filterTitle')}
              >
                <Tag size={14} />
                {sessionTags.selectedFilterTags.size > 0 && (
                  <span className="text-2xs px-1 rounded-full bg-primary/10">{sessionTags.selectedFilterTags.size}</span>
                )}
              </DsButton>
            )}
          </div>
          {/* 分组滑块独占一行：三分段等宽拉伸，40px 触控高度，图标+文字标签 */}
          <div className="relative flex items-stretch h-10 rounded-lg bg-muted/50 p-0.5">
            <button
              onClick={() => setGroupMode('time')}
              className={cn(
                'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors min-w-0',
                groupMode === 'time' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
              )}
              title={t('browser.groupByTime')}
              aria-label={t('browser.groupByTime')}
              aria-pressed={groupMode === 'time'}
            >
              <CalendarBlank size={14} className="shrink-0" />
              <span className="truncate">{t('browser.groupByTime')}</span>
            </button>
            <button
              onClick={() => setGroupMode('group')}
              className={cn(
                'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors min-w-0',
                groupMode === 'group' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
              )}
              title={t('browser.groupByGroup')}
              aria-label={t('browser.groupByGroup')}
              aria-pressed={groupMode === 'group'}
            >
              <Stack size={14} className="shrink-0" />
              <span className="truncate">{t('browser.groupByGroup')}</span>
            </button>
            <button
              onClick={() => setGroupMode('workspace')}
              className={cn(
                'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors min-w-0',
                groupMode === 'workspace' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
              )}
              title={t('browser.groupByWorkspace')}
              aria-label={t('browser.groupByWorkspace')}
              aria-pressed={groupMode === 'workspace'}
            >
              <Folder size={14} className="shrink-0" />
              <span className="truncate">{t('browser.groupByWorkspace')}</span>
            </button>
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
      <CustomScrollArea className="min-h-0 flex-1" viewportClassName={cn("p-3 sm:p-6", embeddedMode && "pb-20")}>
        {/* 内容搜索结果 */}
        {searchMode === 'content' && searchQuery.trim().length >= 2 ? (
          <SearchResultList
            results={contentSearch.results}
            loading={contentSearch.loading}
            error={contentSearch.error}
            query={searchQuery}
            onRetry={contentSearch.retry}
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
          // 空状态 - 简洁风格简洁设计（搜索或标签过滤导致的空结果不应提示"暂无会话"）
          (() => {
            const hasActiveFilter = Boolean(searchQuery.trim()) || sessionTags.selectedFilterTags.size > 0;
            return (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Chat size={40} className="mb-3 opacity-40" />
                <span className="text-sm mb-2">
                  {hasActiveFilter
                    ? t('browser.noResults')
                    : t('page.noSessions')}
                </span>
                <span className="text-xs text-muted-foreground/60 mb-4">
                  {hasActiveFilter
                    ? t('browser.tryDifferentKeyword')
                    : t('page.selectOrCreate')}
                </span>
                {!hasActiveFilter && (
                  <DsButton variant="ghost" size="sm" onClick={onCreateSession} className="text-primary hover:underline">
                    {t('page.createFirst')}
                  </DsButton>
                )}
              </div>
            );
          })()
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
                          editingTitle={editingSessionId === session.id ? editingTitle : ''}
                          tags={sessionTags.tagsBySession.get(session.id)}
                          onSelect={onSelectSession}
                          onDelete={onDeleteSession}
                          onStartEdit={handleStartEdit}
                          onSaveEdit={handleSaveEdit}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={handleEditTitleChange}
                          onAddTag={sessionTags.addTag}
                          onRemoveTag={sessionTags.removeTag}
                        />
                      ))}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        ) : groupMode === 'workspace' ? (
          <div className="space-y-6 sm:space-y-8">
            {sessionsGroupedByWorkspace.map(({ workspaceKey, sessions: workspaceSessions }) => {
              const summaryCounts = workspaceSessions.reduce(
                (counts, session) => {
                  counts[summarizeTaskSession(session).status] += 1;
                  return counts;
                },
                { running: 0, blocked: 0, completed: 0, unknown: 0 },
              );
              return (
                <section key={workspaceKey}>
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <Folder size={16} className="text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {workspaceKey === 'default' ? t('browser.defaultWorkspace') : workspaceKey}
                    </span>
                    {(['running', 'blocked', 'completed'] as const).map(status => (
                      summaryCounts[status] > 0 && (
                        <span key={status} className="text-[11px] text-muted-foreground">
                          {t(`browser.taskStatus.${status}`)} {summaryCounts[status]}
                        </span>
                      )
                    ))}
                    <div className="h-px min-w-8 flex-1 bg-border/40" />
                  </div>
                  <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
                    {workspaceSessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        isEditing={editingSessionId === session.id}
                        editingTitle={editingSessionId === session.id ? editingTitle : ''}
                        tags={sessionTags.tagsBySession.get(session.id)}
                        onSelect={onSelectSession}
                        onDelete={onDeleteSession}
                        onStartEdit={handleStartEdit}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={handleCancelEdit}
                        onEditTitleChange={handleEditTitleChange}
                        onAddTag={sessionTags.addTag}
                        onRemoveTag={sessionTags.removeTag}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
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
                    <CaretDown size={14} className={cn(
                      'text-muted-foreground/60 transition-transform duration-200',
                      isCollapsed && '-rotate-90'
                    )} />
                    {isEmoji ? (
                      <span className="text-sm">{displayIcon}</span>
                    ) : (
                      <Folder size={16} className="text-muted-foreground/60 group-hover/header:text-foreground transition-colors" />
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
                          editingTitle={editingSessionId === session.id ? editingTitle : ''}
                          tags={sessionTags.tagsBySession.get(session.id)}
                          onSelect={onSelectSession}
                          onDelete={onDeleteSession}
                          onStartEdit={handleStartEdit}
                          onSaveEdit={handleSaveEdit}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={handleEditTitleChange}
                          onAddTag={sessionTags.addTag}
                          onRemoveTag={sessionTags.removeTag}
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
                    <CaretDown className={cn(
                      'w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200',
                      isUngroupedCollapsed && '-rotate-90'
                    )} />
                    <Folder size={16} className="text-muted-foreground/60 group-hover/header:text-foreground transition-colors" />
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
                          editingTitle={editingSessionId === session.id ? editingTitle : ''}
                          tags={sessionTags.tagsBySession.get(session.id)}
                          onSelect={onSelectSession}
                          onDelete={onDeleteSession}
                          onStartEdit={handleStartEdit}
                          onSaveEdit={handleSaveEdit}
                          onCancelEdit={handleCancelEdit}
                          onEditTitleChange={handleEditTitleChange}
                          onAddTag={sessionTags.addTag}
                          onRemoveTag={sessionTags.removeTag}
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
