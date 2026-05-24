/**
 * Chat V2 - 正式页面入口
 *
 * 提供完整的 Chat V2 聊天界面，支持：
 * 1. 会话管理（创建/切换/删除）
 * 2. 消息交互（发送/流式回复）
 * 3. 多种功能（RAG/图谱/记忆/网络搜索）
 */

import React, { useState, useCallback, useEffect, useMemo, useDeferredValue, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Chat, PencilSimple, Check, X, SquaresFour, Books, FileText, BookOpen, ClipboardText, Image, File, CircleNotch, DotsSixVertical, List, ArrowClockwise, Folder, ArrowSquareOut } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ChatContainer } from '../components/ChatContainer';
import { ChatErrorBoundary } from '../components/ChatErrorBoundary';
import { SessionBrowser } from '../components/session-browser';
import { getErrorMessage } from '@/utils/errorUtils';
import { TauriAPI } from '@/utils/tauriApi';
// Learning Hub 学习资源侧边栏
import { LearningHubSidebar } from '@/features/learning-hub';
import type { ResourceListItem, ResourceType } from '@/features/learning-hub/types';
import { useFinderStore } from '@/features/learning-hub/stores/finderStore';
import { MobileBreadcrumb } from '@/features/learning-hub/components/MobileBreadcrumb';
import { useNotesOptional } from '@/features/notes/NotesContext';
import { registerOpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode } from '@/dstu/types';
import { mapDstuNodeToLearningHubItem } from './openResourceMapping';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import { lazy, Suspense } from 'react';

import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { GroupEditorPanel, PRESET_ICONS } from '../components/groups/GroupEditorDialog';
import { SessionGroupActions } from './SessionGroupActions';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { useGroupManagement } from '../hooks/useGroupManagement';
import { useGroupCollapse } from '../hooks/useGroupCollapse';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../types/group';
import type { ChatSession } from '../types/session';
import { usePageMount, pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { SidebarDrawer } from '@/components/ui/unified-sidebar/SidebarDrawer';
import { SandboxWorkbenchSurface } from '@/features/sandbox/components/SandboxWorkbenchSurface';
import { useSandboxWorkbenchStore } from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from '@/app/shell/DesktopShellIcons';
import { DESKTOP_SHELL } from '@/app/shell/desktopShell';
// P1-07: 导入命令面板事件 hook
import { useCommandEvents, COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
// P1-07: 导入 sessionManager 以访问当前会话 store
import { sessionManager } from '../core/session/sessionManager';
import { groupCache } from '../core/store/groupCache';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useUIStore } from '@/stores/uiStore';
// 导入默认技能管理器（用于新会话自动激活默认技能）
// P1-06: 导入 Tauri 文件对话框，用于创建分析会话时选择图片
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';

// 懒加载统一应用面板
const UnifiedAppPanel = lazy(() => import('@/features/learning-hub/apps/UnifiedAppPanel').then(m => ({ default: m.UnifiedAppPanel })));

// CardForge 2.0 Anki 面板 (Chat V2 集成)
import { AnkiPanelHost } from '../anki';

// 🆕 对话控制面板（侧栏版）
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { shouldShowSessionActionButtons } from './sessionItemActionVisibility';
import { groupSessionsByTime, type TimeGroup } from './timeGroups';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionEdit } from './useSessionEdit';
import { useChatPageLayout } from './useChatPageLayout';
import { useChatPageEvents } from './useChatPageEvents';
import { useSessionItemRenderer } from './SessionItemRenderer';
import { useSessionSidebarContent } from './SessionSidebarContent';
import { getSessionTitleText } from '../utils/sessionTitle';
import { compareSessionsForSidebar } from '../utils/sessionPin';
import { StreamPreferencesProvider } from '../components/renderers/StreamPreferencesContext';
import {
  clearHiddenDraftSessionId,
  clearHiddenDraftSessionMetadata,
  getHiddenDraftSessionScope,
} from './draftSession';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * 当前打开的应用信息
 */
interface OpenApp {
  type: ResourceType;
  id: string;
  title: string;
  filePath?: string;
}

/**
 * 获取应用类型对应的图标
 */
const getAppIcon = (type: ResourceType) => {
  switch (type) {
    case 'note': return FileText;
    case 'textbook': return BookOpen;
    case 'exam': return ClipboardText;
    case 'image': return Image;
    case 'file': return File;
    default: return FileText;
  }
};
const LAST_SESSION_KEY = 'chat-v2-last-session-id';

// ============================================================================
// 组件实现
// ============================================================================

export const ChatV2Page: React.FC = () => {
  const { t } = useTranslation(['chatV2', 'learningHub', 'common']);

  // ========== 页面生命周期监控 ==========
  usePageMount('chat-v2', 'ChatV2Page');

  // ========== 响应式布局支持 ==========
  const { isSmallScreen } = useBreakpoint();

  // 状态声明提前，用于 useMobileHeader
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionIdState] = useState<string | null>(null);

  // 🔧 P1-26 + P1-28: 包装 setCurrentSessionId
  // - 同步更新 sessionManager（P1-26）
  // - 保存到 localStorage（P1-28）
  const setCurrentSessionId = useCallback((sessionIdOrUpdater: string | null | ((prev: string | null) => string | null)) => {
    setCurrentSessionIdState((prev) => {
      const newId = typeof sessionIdOrUpdater === 'function' ? sessionIdOrUpdater(prev) : sessionIdOrUpdater;
      // 同步更新 sessionManager 的当前会话 ID
      sessionManager.setCurrentSessionId(newId);
      // 🔧 P1-28: 保存到 localStorage（只保存有效的会话 ID）
      if (newId) {
        try {
          // 批判性修复：只持久化普通会话 sess_，避免 Worker 会话 agent_ 污染“上次会话”
          if (newId.startsWith('sess_')) {
            localStorage.setItem(LAST_SESSION_KEY, newId);
          }
        } catch (e) {
          console.warn('[ChatV2Page] Failed to save last session ID:', e);
        }
      }
      // 🔧 Bug fix: 切换对话时关闭右侧预览面板，避免上一个对话的预览残留
      if (newId !== prev) {
        setOpenApp(null);
        setAttachmentPreviewOpen(false);
        useSandboxWorkbenchStore.getState().closeSession();
      }
      return newId;
    });
  }, [t]);
  // 🔧 P1-005 修复：使用 ref 追踪最新状态，避免 deleteSession 中的闭包竞态条件
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [learningHubSheetOpen, setLearningHubSheetOpen] = useState(false);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const sandboxActiveSession = useSandboxWorkbenchStore((state) => state.activeSession);
  const sandboxWorkbenchOpen = useSandboxWorkbenchStore((state) => state.isOpen);
  const openSandboxWorkbench = useSandboxWorkbenchStore((state) => state.openWorkbench);
  const closeSandboxWorkbench = useSandboxWorkbenchStore((state) => state.closeWorkbench);
  const sandboxDesktopPanelRef = useRef<ImperativePanelHandle>(null);
  // 移动端：资源库右侧滑屏状态
  const [mobileResourcePanelOpen, setMobileResourcePanelOpen] = useState(false);
  // 移动端：分组编辑器资源选择回调（右面板复用，返回 'added'|'removed'|false）
  const groupPickerAddRef = useRef<((sourceId: string) => 'added' | 'removed' | false) | null>(null);
  // 移动端：分组已关联资源 ID 集合（用于右面板高亮显示）
  const [groupPinnedIds, setGroupPinnedIds] = useState<Set<string>>(new Set());
  // 📱 移动端资源库面包屑导航（用于应用顶栏）
  const finderCurrentPath = useFinderStore(state => state.currentPath);
  const finderJumpToBreadcrumb = useFinderStore(state => state.jumpToBreadcrumb);
  const finderBreadcrumbs = finderCurrentPath.breadcrumbs;
  const [isLoading, setIsLoading] = useState(false);
  // 🔧 防闪烁：首次加载会话列表期间为 true，避免短暂显示全空状态
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const globalLeftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);
  const [localSidebarCollapsed, setLocalSidebarCollapsed] = useState(false);
  const sidebarCollapsed = globalLeftPanelCollapsed || localSidebarCollapsed;
  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    setLocalSidebarCollapsed(collapsed);
    // 同步重置全局状态，避免 topbar 收起后本地切换失效
    if (!collapsed && globalLeftPanelCollapsed) {
      useUIStore.getState().setLeftPanelCollapsed(false);
    }
  }, [globalLeftPanelCollapsed]);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [pendingArchiveSessionId, setPendingArchiveSessionId] = useState<string | null>(null);

  const deleteConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDeleteConfirmTimeout = useCallback(() => {
    if (!deleteConfirmTimeoutRef.current) return;
    clearTimeout(deleteConfirmTimeoutRef.current);
    deleteConfirmTimeoutRef.current = null;
  }, []);
  const resetDeleteConfirmation = useCallback(() => {
    setPendingDeleteSessionId(null);
    clearDeleteConfirmTimeout();
  }, [clearDeleteConfirmTimeout]);

  useEffect(() => clearDeleteConfirmTimeout, [clearDeleteConfirmTimeout]);

  // Learning Hub 学习资源状态
  // 🔧 修复：NotesProvider 已废弃（未挂载），canvasSidebarOpen/toggleCanvasSidebar 改为本地 state
  const notesContext = useNotesOptional();
  const [canvasSidebarOpen, setCanvasSidebarOpen] = useState(false);
  const toggleCanvasSidebar = useCallback(() => {
    setCanvasSidebarOpen(prev => {
      const next = !prev;
      window.dispatchEvent(new CustomEvent(next ? 'canvas:opened' : 'canvas:closed'));
      return next;
    });
  }, []);

  // 监听笔记工具打开事件，在右侧 DSTU 面板中打开笔记
  const deferredSessionId = useDeferredValue(currentSessionId);
  // 是否正在切换会话（用于显示加载指示器）
  // 只有当从一个已存在的会话切换到另一个会话时才显示
  // - 首次选择会话（null → A）不显示
  // - 关闭所有会话（A → null）不显示
  // - 会话间切换（A → B）才显示
  const isSessionSwitching = currentSessionId !== null && deferredSessionId !== null && currentSessionId !== deferredSessionId;

  // 🚀 防闪动优化：只有切换超过 500ms 才显示加载指示器
  const [showSwitchingIndicator, setShowSwitchingIndicator] = useState(false);

  useEffect(() => {
    if (isSessionSwitching) {
      // 切换开始，延迟 500ms 后显示指示器
      const timer = setTimeout(() => {
        setShowSwitchingIndicator(true);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      // 切换完成，立即隐藏指示器
      setShowSwitchingIndicator(false);
    }
  }, [isSessionSwitching]);

  // 会话重命名状态
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  
  // 搜索过滤状态
  const [searchQuery, setSearchQuery] = useState('');

  // 分组管理
  const {
    groups,
    isLoading: isGroupsLoading,
    loadGroups,
    createGroup,
    updateGroup,
    archiveGroup,
    reorderGroups,
  } = useGroupManagement();
  const { collapsedMap, toggleGroupCollapse, expandGroup, pruneDeletedGroups } = useGroupCollapse();
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<SessionGroup | null>(null);
  const [groupEditorAutoFocusField, setGroupEditorAutoFocusField] = useState<'name' | null>(null);
  const [pendingArchiveGroup, setPendingArchiveGroup] = useState<SessionGroup | null>(null);
  
  // 视图模式：sidebar（侧边栏+聊天）或 browser（全宽浏览）
  const [viewMode, setViewMode] = useState<'sidebar' | 'browser'>('sidebar');
  
  // ★ 待打开的资源（用于 openResource handler）
  const [pendingOpenResource, setPendingOpenResource] = useState<ResourceListItem | null>(null);
  
  // ★ 当前打开的应用（复用 Learning Hub 的 UnifiedAppPanel）
  const [openApp, setOpenApp] = useState<OpenApp | null>(null);
  
  const normalizedSearchQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);

  // 过滤会话
  const filteredSessions = useMemo(() => {
    const filtered = !normalizedSearchQuery
      ? sessions
      : sessions.filter((s) => (s.title || '').toLowerCase().includes(normalizedSearchQuery));
    return [...filtered].sort(compareSessionsForSidebar);
  }, [normalizedSearchQuery, sessions]);

  // 按分组归类会话
  const sessionsByGroup = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    filteredSessions.forEach((session) => {
      if (!session.groupId) return;
      const list = map.get(session.groupId) ?? [];
      list.push(session);
      map.set(session.groupId, list);
    });
    map.forEach((list, key) => {
      map.set(key, [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    });
    return map;
  }, [filteredSessions]);

  const groupNameMap = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach((group) => {
      // 判断 icon 是预设图标名称还是 emoji，只有 emoji 才添加到标签前面
      const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
      const label = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
      map.set(group.id, label);
    });
    return map;
  }, [groups]);

  const visibleGroups = useMemo(() => {
    if (!normalizedSearchQuery) return groups;
    return groups.filter((group) => {
      const text = `${group.name} ${group.description ?? ''}`.toLowerCase();
      if (text.includes(normalizedSearchQuery)) return true;
      return (sessionsByGroup.get(group.id) ?? []).length > 0;
    });
  }, [groups, normalizedSearchQuery, sessionsByGroup]);

  const groupDragDisabled = normalizedSearchQuery.length > 0;

  const sessionsForBrowser = useMemo(() => {
    return sessions.map((s) => ({
      ...s,
      groupName: s.groupId ? groupNameMap.get(s.groupId) : undefined,
    }));
  }, [groupNameMap, sessions]);

  // 浏览模式的分组信息
  const browserGroups = useMemo(() => {
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      color: g.color,
      sortOrder: g.sortOrder,
    }));
  }, [groups]);

  // 未分组会话（仍按时间分组展示，含未知分组）
  const ungroupedSessions = useMemo(
    () => filteredSessions.filter((s) => !s.groupId || !groupNameMap.has(s.groupId)),
    [filteredSessions, groupNameMap]
  );
  const groupedSessions = useMemo(() => groupSessionsByTime(ungroupedSessions), [ungroupedSessions]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // P2-4 fix: Prune stale collapsed state when groups change
  useEffect(() => {
    if (groups.length > 0) {
      pruneDeletedGroups(groups.map((g) => g.id));
    }
  }, [groups, pruneDeletedGroups]);
  
  // 时间分组标签映射
  const timeGroupLabels: Record<TimeGroup, string> = {
    today: t('page.timeGroups.today'),
    yesterday: t('page.timeGroups.yesterday'),
    previous7Days: t('page.timeGroups.previous7Days'),
    previous30Days: t('page.timeGroups.previous30Days'),
    older: t('page.timeGroups.older'),
  };

  // P1-22: 分页状态
  const PAGE_SIZE = 50;
  const [hasMoreSessions, setHasMoreSessions] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // 真实的会话总数（用于显示）
  const [totalSessionCount, setTotalSessionCount] = useState<number | null>(null);
  const [ungroupedSessionCount, setUngroupedSessionCount] = useState<number | null>(null);

  // 🆕 对话控制侧栏标签页状态
  const [showChatControl, setShowChatControl] = useState(false);

  useEffect(() => {
    setShowChatControl(false);
  }, [currentSessionId, viewMode, groupEditorOpen]);

  // ===== 会话生命周期 hook =====
  const {
    loadUngroupedCount, createSession, createAnalysisSession,
    loadSessions, loadMoreSessions, deleteSession,
    handleViewAgentSession,
  } = useSessionLifecycle({
    currentSessionId,
    setSessions, setCurrentSessionId, setIsLoading, setTotalSessionCount,
    setUngroupedSessionCount, setHasMoreSessions, setIsInitialLoading,
    setIsLoadingMore, setShowChatControl,
    isLoadingMore, hasMoreSessions, sessionsRef,
    t, PAGE_SIZE, LAST_SESSION_KEY,
  });

  const promotingDraftIdsRef = useRef<Set<string>>(new Set());
  const promoteHiddenDraftSession = useCallback(async (
    sessionId: string,
    metadata: Record<string, unknown> | null | undefined
  ) => {
    const draftScope = getHiddenDraftSessionScope(metadata);
    if (!draftScope || promotingDraftIdsRef.current.has(sessionId)) {
      return;
    }

    promotingDraftIdsRef.current.add(sessionId);
    try {
      const nextMetadata = clearHiddenDraftSessionMetadata(metadata);
      const promotedSession = await invoke<ChatSession>('chat_v2_update_session_settings', {
        sessionId,
        settings: { metadata: nextMetadata ?? null },
      });

      sessionManager.get(sessionId)?.setState({
        sessionMetadata: nextMetadata,
      });
      clearHiddenDraftSessionId(draftScope);
      setSessions((prev) => [promotedSession, ...prev.filter((session) => session.id !== sessionId)]);
      setTotalSessionCount((prev) => (prev !== null ? prev + 1 : null));
      if (!promotedSession.groupId) {
        void loadUngroupedCount();
      }
      window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    } catch (error) {
      console.warn('[ChatV2Page] Failed to promote hidden draft session:', getErrorMessage(error));
    } finally {
      promotingDraftIdsRef.current.delete(sessionId);
    }
  }, [loadUngroupedCount]);

  // 加载会话列表（根据全局科目过滤）
  // 🔧 修复：不依赖 currentSessionId，避免与 useEffect 中的 setCurrentSessionId 形成循环
  // 🔧 分组懒加载修复：分别加载已分组会话（全量）和未分组会话（分页），确保每个分组都能显示其会话
  const [currentSessionHasMessages, setCurrentSessionHasMessages] = useState(false);
  
  useEffect(() => {
    if (!currentSessionId) {
      setCurrentSessionHasMessages(false);
      return;
    }
    
    const store = sessionManager.get(currentSessionId);
    if (!store) {
      setCurrentSessionHasMessages(false);
      return;
    }
    
    // 立即检查当前消息数量
    const initialState = store.getState();
    const initialHasMessages = initialState.messageOrder.length > 0;
    setCurrentSessionHasMessages(initialHasMessages);
    if (initialHasMessages) {
      void promoteHiddenDraftSession(currentSessionId, initialState.sessionMetadata);
    }
    
    // 订阅 store 的消息数量变化
    const unsubscribe = store.subscribe((state, prevState) => {
      const hasMessages = state.messageOrder.length > 0;
      const prevHasMessages = prevState.messageOrder.length > 0;
      // 只在状态变化时更新
      if (hasMessages !== prevHasMessages) {
        console.log('[ChatV2Page] Message count changed, hasMessages:', hasMessages);
        setCurrentSessionHasMessages(hasMessages);
        if (hasMessages) {
          void promoteHiddenDraftSession(currentSessionId, state.sessionMetadata);
        }
      }
    });
    
    return unsubscribe;
  }, [currentSessionId, promoteHiddenDraftSession]);

  // 🔧 修复：后端自动生成标题后，同步更新 sessions 列表
  useEffect(() => {
    if (!currentSessionId) return;
    const store = sessionManager.get(currentSessionId);
    if (!store) return;

    const unsubscribe = store.subscribe((state, prevState) => {
      if (state.title && state.title !== prevState.title) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentSessionId
              ? { ...s, title: state.title, description: state.description ?? s.description }
              : s
          )
        );
      }
    });
    return unsubscribe;
  }, [currentSessionId]);

  // ========== 移动端统一顶栏配置 ==========
  const currentSession = sessions.find(s => s.id === currentSessionId);
  const currentSessionGroupName = currentSession?.groupId
    ? groupNameMap.get(currentSession.groupId) ?? null
    : null;

  // ===== 会话编辑 hook =====
  const {
    startEditSession, saveSessionTitle, cancelEditSession, archiveSession, togglePinSession,
    openCreateGroup, openEditGroup, openRenameGroup, closeGroupEditor,
    handleSubmitGroup, confirmArchiveGroup,
    moveSessionToGroup, formatTime,
  } = useSessionEdit({
    resetDeleteConfirmation, currentSessionId, setCurrentSessionId, setEditingSessionId, setEditingTitle,
    setRenamingSessionId, setRenameError, setSessions,
    setGroupEditorOpen, setEditingGroup, setGroupEditorAutoFocusField, setShowChatControl,
    setViewMode, setSessionSheetOpen, setPendingArchiveGroup,
    setGroupPinnedIds, setMobileResourcePanelOpen,
    editingTitle, editingGroup, pendingArchiveGroup, sessionsRef,
    groupPickerAddRef, t,
    updateGroup, createGroup, archiveGroup, reorderGroups,
    loadUngroupedCount, groupDragDisabled, visibleGroups,
  });

  // ===== 左侧主导航栏分组操作事件监听 =====
  useEffect(() => {
    const handler = (event: Event) => {
      const { action, groupId, group } = (event as CustomEvent).detail ?? {};
      switch (action) {
        case 'create-group':
          openCreateGroup();
          break;
        case 'create-session':
          void createSession(typeof groupId === 'string' && groupId.trim() ? groupId : undefined);
          break;
        case 'rename-group':
          if (group) openRenameGroup(group);
          break;
        case 'edit-group':
          if (group) openEditGroup(group);
          break;
        case 'archive-group':
          if (group) setPendingArchiveGroup(group);
          break;
      }
    };
    window.addEventListener('modern-sidebar:group-action', handler);
    return () => window.removeEventListener('modern-sidebar:group-action', handler);
  }, [createSession, openCreateGroup, openRenameGroup, openEditGroup, setPendingArchiveGroup]);

  useEffect(() => {
    const handler = (event: Event) => {
      const { action, session, sessionId } = (event as CustomEvent).detail ?? {};
      if (action !== 'rename-session') {
        return;
      }

      const targetSession =
        sessionsRef.current.find((item) => item.id === sessionId)
        ?? (session && typeof session.id === 'string' ? session : null);

      if (!targetSession) {
        return;
      }

      setCurrentSessionId(targetSession.id);
      setViewMode('sidebar');
      setSessionSheetOpen(false);
      startEditSession(targetSession, { stopPropagation() {} } as React.MouseEvent);
    };

    window.addEventListener('modern-sidebar:session-action', handler);
    return () => window.removeEventListener('modern-sidebar:session-action', handler);
  }, [setCurrentSessionId, setSessionSheetOpen, setViewMode, startEditSession]);

  // ===== 页面布局 hook =====
  useChatPageLayout({
    currentSession, currentSessionId, expandGroup, currentSessionHasMessages,
    viewMode, sessionSheetOpen, t, sessionCount: sessions.length,
    createSession, isLoading,
    mobileResourcePanelOpen, finderBreadcrumbs, finderJumpToBreadcrumb,
    setMobileResourcePanelOpen, setSessionSheetOpen, setShowChatControl, setViewMode,
  });

  // ===== 页面事件 hook =====
  useChatPageEvents({
    notesContext, t, loadSessions, isInitialLoading, currentSessionId,
    createSession, createAnalysisSession,
    setSessions, setCurrentSessionId, loadUngroupedCount,
    canvasSidebarOpen, toggleCanvasSidebar, setPendingOpenResource,
    setOpenApp, isSmallScreen, setMobileResourcePanelOpen,
    attachmentPreviewOpen, setAttachmentPreviewOpen,
    sidebarCollapsed, handleSidebarCollapsedChange, setSessionSheetOpen,
  });

  // ===== 会话项渲染 hook =====
  const {
    renderSessionItem, handleBrowserSelectSession, handleBrowserRenameSession,
  } = useSessionItemRenderer({
    editingSessionId, hoveredSessionId: null, currentSessionId, pendingDeleteSessionId, pendingArchiveSessionId,
    editingTitle, renamingSessionId, renameError, groups, sessions, totalSessionCount,
    t, resetDeleteConfirmation, setCurrentSessionId, setHoveredSessionId: () => {},
    setEditingTitle, setPendingDeleteSessionId, setPendingArchiveSessionId, setSessions, setViewMode,
    clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    startEditSession, saveSessionTitle, cancelEditSession,
    moveSessionToGroup, deleteSession, archiveSession, togglePinSession, formatTime,
  });

  // ===== 侧边栏内容 hook =====
  const { renderSessionSidebarContent } = useSessionSidebarContent({
    searchQuery, setSearchQuery, setViewMode, setSessionSheetOpen,
    setShowChatControl, setPendingDeleteSessionId,
    showChatControl,
    isInitialLoading, sessions, visibleGroups, sessionsByGroup, ungroupedSessions,
    currentSessionId, totalSessionCount,
    hasMoreSessions, isLoadingMore, pendingDeleteSessionId,
    t,
    resetDeleteConfirmation, clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    createSession, loadMoreSessions,
    renderSessionItem,
  });

  const handleOpenApp = useCallback((item: ResourceListItem) => {
    console.log('[ChatV2Page] handleOpenApp:', item);
    setOpenApp({
      type: item.type,
      id: item.id,
      title: item.title,
      filePath: item.path,
    });
  }, []);
  
  // ★ 关闭应用面板
  const handleCloseApp = useCallback(() => {
    setOpenApp(null);
    setAttachmentPreviewOpen(false);
  }, []);

  const handleCloseSandbox = useCallback(() => {
    setOpenApp(null);
    setAttachmentPreviewOpen(false);
    setCanvasSidebarOpen(false);
    setMobileResourcePanelOpen(false);
  }, [setAttachmentPreviewOpen, setCanvasSidebarOpen, setMobileResourcePanelOpen, setOpenApp]);
  const otherSecondaryPanelOpen = canvasSidebarOpen || attachmentPreviewOpen;

  const toggleSandboxWorkbench = useCallback(() => {
    const panel = sandboxDesktopPanelRef.current;
    if (!panel || !sandboxActiveSession) return;

    if (sandboxWorkbenchOpen) {
      panel.collapse();
    } else {
      openSandboxWorkbench();
      panel.expand();
    }
  }, [openSandboxWorkbench, sandboxActiveSession, sandboxWorkbenchOpen]);

  useEffect(() => {
    if (isSmallScreen || !sandboxActiveSession || otherSecondaryPanelOpen) return;

    const panel = sandboxDesktopPanelRef.current;
    if (!panel) return;

    if (sandboxWorkbenchOpen) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [isSmallScreen, sandboxActiveSession, sandboxWorkbenchOpen, otherSecondaryPanelOpen]);

  const renderDesktopSecondaryPanel = () => {
    if (!sandboxWorkbenchOpen && !canvasSidebarOpen && !attachmentPreviewOpen) {
      return null;
    }

    if (sandboxWorkbenchOpen && sandboxActiveSession) {
      return (
        <div className="h-full transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none opacity-100 translate-x-0">
          <SandboxWorkbenchSurface
            embedded
            className="h-full"
            onClose={handleCloseSandbox}
          />
        </div>
      );
    }

    if (attachmentPreviewOpen && !canvasSidebarOpen && openApp) {
      return (
        <div className="study-shell-panel h-full flex flex-col">
          {/* 应用标题栏 */}
          <div className="study-shell-toolbar flex items-center justify-between px-3 py-2 border-b shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {(() => {
                const AppIcon = getAppIcon(openApp.type);
                return <AppIcon size={16} className="text-muted-foreground shrink-0" />;
              })()}
              <span className="text-sm font-medium truncate">
                {openApp.title || t('common:untitled')}
              </span>
              <span className="text-xs text-muted-foreground">
                ({t(`learningHub:resourceType.${openApp.type}`, openApp.type)})
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInLearningHub} aria-label="在学习中心打开" title="在学习中心打开" className="!h-7 !w-7">
                <ArrowSquareOut size={14} className="text-muted-foreground" />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCloseApp} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                <X size={16} className="text-muted-foreground" />
              </NotionButton>
            </div>
          </div>

          {/* 应用内容 - 复用 UnifiedAppPanel */}
          <div className="flex-1 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <CircleNotch size={24} className="animate-spin text-muted-foreground" />
                  <span className="ml-2 text-muted-foreground">
                    {t('common:loading')}
                  </span>
                </div>
              }
            >
              <UnifiedAppPanel
                type={openApp.type}
                resourceId={openApp.id}
                dstuPath={openApp.filePath || `/${openApp.id}`}
                onClose={handleCloseApp}
                onTitleChange={handleTitleChange}
                className="h-full"
              />
            </Suspense>
          </div>
        </div>
      );
    }

    return (
      <PanelGroup direction="horizontal" className="h-full">
        {/* Learning Hub 侧边栏 */}
        <Panel
          defaultSize={openApp ? 35 : 100}
          minSize={openApp ? 25 : 100}
          className="h-full"
        >
          <LearningHubSidebar
            mode="canvas"
            onClose={toggleCanvasSidebar}
            onOpenApp={handleOpenApp}
            className="h-full"
          />
        </Panel>

        {/* 应用面板（当有 openApp 时显示） */}
        {openApp && (
          <>
            <PanelResizeHandle className="w-1 bg-border hover:bg-primary/30 transition-colors flex items-center justify-center">
              <DotsSixVertical size={12} className="text-muted-foreground/50" />
            </PanelResizeHandle>
            <Panel
              defaultSize={65}
              minSize={40}
              className="h-full"
            >
              <div className="study-shell-panel h-full flex flex-col border-l border-[color:var(--shell-inspector-border)]">
                {/* 应用标题栏 */}
                <div className="study-shell-toolbar flex items-center justify-between px-3 py-2 border-b shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {(() => {
                      const AppIcon = getAppIcon(openApp.type);
                      return <AppIcon size={16} className="text-muted-foreground shrink-0" />;
                    })()}
                    <span className="text-sm font-medium truncate">
                      {openApp.title || t('common:untitled')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({t(`learningHub:resourceType.${openApp.type}`, openApp.type)})
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInLearningHub} aria-label="在学习中心打开" title="在学习中心打开" className="!h-7 !w-7">
                      <ArrowSquareOut size={14} className="text-muted-foreground" />
                    </NotionButton>
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCloseApp} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                      <X size={16} className="text-muted-foreground" />
                    </NotionButton>
                  </div>
                </div>

                {/* 应用内容 - 复用 UnifiedAppPanel */}
                <div className="flex-1 overflow-hidden">
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center h-full">
                        <CircleNotch size={24} className="animate-spin text-muted-foreground" />
                        <span className="ml-2 text-muted-foreground">
                          {t('common:loading')}
                        </span>
                      </div>
                    }
                  >
                    <UnifiedAppPanel
                      type={openApp.type}
                      resourceId={openApp.id}
                      dstuPath={openApp.filePath || `/${openApp.id}`}
                      onClose={handleCloseApp}
                      onTitleChange={handleTitleChange}
                      className="h-full"
                    />
                  </Suspense>
                </div>
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>
    );
  };

  useEffect(() => {
    if (!sandboxActiveSession) {
      return;
    }

    setOpenApp(null);
    setAttachmentPreviewOpen(false);
    setCanvasSidebarOpen(false);
    setMobileResourcePanelOpen(true);
  }, [sandboxActiveSession, setAttachmentPreviewOpen, setCanvasSidebarOpen, setMobileResourcePanelOpen, setOpenApp]);

  const navigateToShellView = useCallback((view: 'learning-hub' | 'skills-management' | 'settings') => {
    window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view } }));
  }, []);

  // ★ 在学习中心打开当前资源（跳转到完整页面）
  const handleOpenInLearningHub = useCallback(() => {
    if (!openApp) return;
    const { type, id, title } = openApp;
    const dstuPath = openApp.filePath || (id.startsWith('/') ? id : `/${id}`);

    switch (type) {
      case 'exam':
        window.dispatchEvent(new CustomEvent('navigateToExamSheet', {
          detail: { sessionId: id },
        }));
        break;
      case 'note':
        window.dispatchEvent(new CustomEvent('navigateToNote', {
          detail: { noteId: id },
        }));
        break;
      case 'essay':
        window.dispatchEvent(new CustomEvent('navigateToEssay', {
          detail: { essayId: id, title },
        }));
        break;
      case 'translation':
        window.dispatchEvent(new CustomEvent('navigateToTranslation', {
          detail: { translationId: id, title },
        }));
        break;
      default:
        window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
          detail: { view: 'learning-hub', openResource: dstuPath },
        }));
        break;
    }
    handleCloseApp();
  }, [openApp, handleCloseApp]);

  // ★ 标题更新回调
  const handleTitleChange = useCallback((title: string) => {
    setOpenApp(prev => prev ? { ...prev, title } : null);
  }, []);

  // ★ 处理从 openResource 触发的待打开资源
  // 简化逻辑：直接调用 handleOpenApp，不再通过事件传递
  useEffect(() => {
    const resourcePanelReady = isSmallScreen ? mobileResourcePanelOpen : canvasSidebarOpen;
    if (pendingOpenResource && resourcePanelReady) {
      // 侧边栏已打开，直接设置 openApp
      handleOpenApp(pendingOpenResource);
      setPendingOpenResource(null);
    }
  }, [pendingOpenResource, canvasSidebarOpen, mobileResourcePanelOpen, isSmallScreen, handleOpenApp]);

  // ★ 监听附件预览事件，在右侧面板打开附件
  // 使用独立的附件预览状态，不依赖于 NotesContext
  const renderMainContent = () => (
    <div className="flex h-full flex-col overflow-hidden relative">
      {/* 🚀 会话切换加载指示器（防闪动：只有超过 500ms 才显示） */}
      {showSwitchingIndicator && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/50 backdrop-blur-[1px] transition-opacity duration-150"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-card shadow-lg border">
            <CircleNotch size={16} className="animate-spin text-primary" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">
              {t('page.switchingSession')}
            </span>
          </div>
        </div>
      )}
      {/* 🔧 修复：使用 currentSessionId 作为主要判断条件
          deferredSessionId 可能因为 useDeferredValue 在并发模式下的行为而延迟更新
          当 ChatContainer 渲染失败时，deferredSessionId 会一直保持旧值（null）
          使用 currentSessionId 确保选中会话时立即显示内容 */}
      {viewMode === 'browser' && !isSmallScreen ? (
        <SessionBrowser
          sessions={sessionsForBrowser}
          groups={browserGroups}
          isLoading={isLoading}
          onSelectSession={handleBrowserSelectSession}
          onDeleteSession={deleteSession}
          onCreateSession={() => {
            setViewMode('sidebar');
            void createSession();
          }}
          onRenameSession={handleBrowserRenameSession}
          className="h-full flex-1"
        />
      ) : groupEditorOpen ? (
        <GroupEditorPanel
          mode={editingGroup ? 'edit' : 'create'}
          initial={editingGroup}
          autoFocusField={groupEditorAutoFocusField}
          onSubmit={handleSubmitGroup}
          onClose={closeGroupEditor}
          onArchive={editingGroup ? () => {
            setPendingArchiveGroup(editingGroup);
            closeGroupEditor();
          } : undefined}
          onMobileBrowse={isSmallScreen ? (addResource, currentIds) => {
            groupPickerAddRef.current = addResource;
            setGroupPinnedIds(new Set(currentIds));
            setMobileResourcePanelOpen(true);
          } : undefined}
        />
      ) : currentSessionId ? (
        <ChatContainer
          sessionId={currentSessionId}
          className="flex-1 h-full"
          emptyStateGroupName={currentSessionGroupName}
          onViewAgentSession={handleViewAgentSession}
        />
      ) : (
        /* 🔧 防闪烁：加载中或正在自动创建会话，显示空白 */
        <div className="flex-1" />
      )}
    </div>
  );

  return (
    <StreamPreferencesProvider preset="balanced" mode="blocked">
      <div className={cn(
        "study-shell-page chat-v2 absolute inset-0 flex overflow-hidden",
        isSmallScreen && "flex-col"
      )}>
      {/* ===== 移动端布局：DeepSeek 风格推拉式侧边栏 ===== */}
      {isSmallScreen ? (
        <MobileSlidingLayout
          className="flex-1"
          sidebar={
            <div className="study-shell-sidebar-frame font-sidebar-study-ui h-full flex flex-col bg-[color:var(--shell-navigation-surface)] text-[color:var(--shell-navigation-foreground)]">
              {renderSessionSidebarContent()}
            </div>
          }
          rightPanel={
            <div
              className="study-shell-panel h-full flex flex-col"
              style={{
                paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
              }}
            >
              {sandboxWorkbenchOpen && sandboxActiveSession ? (
                <SandboxWorkbenchSurface
                  embedded
                  className="h-full"
                  onClose={handleCloseSandbox}
                />
              ) : openApp ? (
                <div className="study-shell-panel h-full flex flex-col">
                  {/* 附件/资源预览标题栏 */}
                  <div className="study-shell-toolbar study-shell-toolbar--floating flex items-center justify-between px-3 py-2 border-b shrink-0 backdrop-blur-lg">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const AppIcon = getAppIcon(openApp.type);
                        return <AppIcon size={16} className="text-muted-foreground shrink-0" />;
                      })()}
                      <span className="text-sm font-medium truncate">
                        {openApp.title || t('common:untitled')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInLearningHub} aria-label="在学习中心打开" title="在学习中心打开" className="!h-7 !w-7">
                        <ArrowSquareOut size={14} className="text-muted-foreground" />
                      </NotionButton>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={() => { handleCloseApp(); setMobileResourcePanelOpen(false); }} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                        <X size={16} className="text-muted-foreground" />
                      </NotionButton>
                    </div>
                  </div>
                  {/* 应用内容 */}
                  <div className="flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <CircleNotch size={24} className="animate-spin text-muted-foreground" />
                          <span className="ml-2 text-muted-foreground">{t('common:loading')}</span>
                        </div>
                      }
                    >
                      <UnifiedAppPanel
                        type={openApp.type}
                        resourceId={openApp.id}
                        dstuPath={openApp.filePath || `/${openApp.id}`}
                        onClose={() => {
                          handleCloseApp();
                          setMobileResourcePanelOpen(false);
                        }}
                        onTitleChange={handleTitleChange}
                        className="h-full"
                      />
                    </Suspense>
                  </div>
                </div>
              ) : (
                <LearningHubSidebar
                  mode="canvas"
                  onClose={() => setMobileResourcePanelOpen(false)}
                  onOpenApp={(item) => {
                    if (groupPickerAddRef.current) {
                      const result = groupPickerAddRef.current(item.id);
                      if (result === 'added') {
                        setGroupPinnedIds(prev => new Set([...prev, item.id]));
                      } else if (result === 'removed') {
                        setGroupPinnedIds(prev => {
                          const next = new Set(prev);
                          next.delete(item.id);
                          return next;
                        });
                      }
                      return;
                    }
                    handleOpenApp(item);
                  }}
                  highlightedIds={groupPickerAddRef.current ? groupPinnedIds : undefined}
                  className="h-full"
                  hideToolbarAndNav
                />
              )}
            </div>
          }
          screenPosition={
            sandboxWorkbenchOpen || mobileResourcePanelOpen ? 'right' :
            sessionSheetOpen ? 'left' : 'center'
          }
          onScreenPositionChange={(pos: ScreenPosition) => {
            setSessionSheetOpen(pos === 'left');
            setMobileResourcePanelOpen(pos === 'right');
          }}
          rightPanelEnabled={true}
          sidebarWidth={304}
          showSidebarAppNavigation={false}
          showContentOverlay
          enableGesture={true}
          edgeWidth={20}
          threshold={0.3}
        >
          {/* 移动端：会话浏览作为主内容区域的一部分，直接切换 */}
          {viewMode === 'browser' ? (
            <SessionBrowser
              sessions={sessionsForBrowser}
              groups={browserGroups}
              isLoading={isLoading}
              onSelectSession={handleBrowserSelectSession}
              onDeleteSession={deleteSession}
              onCreateSession={() => {
                setViewMode('sidebar');
                void createSession();
              }}
              onRenameSession={handleBrowserRenameSession}
              className="h-full"
              embeddedMode={true}
            />
          ) : (
            renderMainContent()
          )}
        </MobileSlidingLayout>
      ) : null}

      {/* 桌面端：主聊天区域 + Canvas 侧边栏 */}
      {!isSmallScreen && (
        <PanelGroup direction="horizontal" autoSaveId="chat-v2-canvas-layout" className="flex-1 min-w-0 h-full">
          <Panel defaultSize={(canvasSidebarOpen || attachmentPreviewOpen || sandboxWorkbenchOpen || sandboxActiveSession) ? 60 : 100} minSize={30} className="h-full">
            {renderMainContent()}
          </Panel>
          {(sandboxWorkbenchOpen || canvasSidebarOpen || attachmentPreviewOpen) && (
            <>
              <PanelResizeHandle
                className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary transition-colors cursor-col-resize"
                title={t('learningHub:toolbar.resize')}
              />
            </>
          )}
          {(sandboxActiveSession || canvasSidebarOpen || attachmentPreviewOpen) && (
            <Panel
              ref={sandboxDesktopPanelRef}
              defaultSize={sandboxWorkbenchOpen ? 42 : openApp ? 50 : 30}
              minSize={20}
              maxSize={70}
              collapsedSize={0}
              collapsible
              onCollapse={() => {
                if (sandboxWorkbenchOpen) {
                  closeSandboxWorkbench();
                }
              }}
              className="h-full overflow-hidden transition-[flex-grow] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
            >
              {renderDesktopSecondaryPanel()}
            </Panel>
          )}
        </PanelGroup>
      )}

      {!isSmallScreen && sandboxActiveSession && (
        <div
          className="absolute z-20"
          style={{
            top: `calc(var(--topbar-safe-area, 0px) + ${(DESKTOP_SHELL.titlebarBaseHeight - 32) / 2}px)`,
            right: '16px',
          }}
        >
          <CommonTooltip
            content={sandboxWorkbenchOpen ? '收起沙箱工作台' : '展开沙箱工作台'}
            position="bottom"
          >
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={toggleSandboxWorkbench}
              className={cn(
                'relative overflow-hidden border border-border/80 bg-background/95 shadow-[var(--shadow-shell-soft)] backdrop-blur-md transition-[transform,opacity,background-color,color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] hover:bg-background hover:shadow-lg',
                sandboxWorkbenchOpen
                  ? '!h-8 !w-8 translate-x-0 rounded-[var(--shell-nav-row-radius)] border-foreground/10 bg-foreground/[0.04] text-foreground'
                  : '!h-8 !w-8 translate-x-0 rounded-[var(--shell-nav-row-radius)] text-muted-foreground'
              )}
              aria-label={sandboxWorkbenchOpen ? '收起沙箱工作台' : '展开沙箱工作台'}
              title={sandboxWorkbenchOpen ? '收起沙箱工作台' : '展开沙箱工作台'}
            >
              <span className="relative block h-[18px] w-[18px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-0 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
                    sandboxWorkbenchOpen ? 'translate-x-[-4px] opacity-0' : 'translate-x-0 opacity-100'
                  )}
                >
                  <SidebarFrameIcon />
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-0 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
                    sandboxWorkbenchOpen ? 'translate-x-0 opacity-100' : 'translate-x-[4px] opacity-0'
                  )}
                >
                  <SidebarFrameWithLeftRailIcon />
                </span>
              </span>
            </NotionButton>
          </CommonTooltip>
        </div>
      )}

      {/* 移动端：Learning Hub SidebarDrawer */}
      {isSmallScreen && (
        <SidebarDrawer
          open={learningHubSheetOpen}
          onOpenChange={setLearningHubSheetOpen}
          side="right"
          width={320}
        >
          <div className="h-full flex flex-col">
            {/* 标题栏 */}
            <div className="study-shell-toolbar flex items-center justify-between px-4 py-3 border-b shrink-0">
              <span className="font-medium">{t('learningHub:title')}</span>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setLearningHubSheetOpen(false)} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                <X size={16} className="text-muted-foreground" />
              </NotionButton>
            </div>
            <div className="flex-1 overflow-hidden">
              {openApp ? (
                <div className="h-full flex flex-col">
                  {/* 应用标题栏 */}
                  <div className="study-shell-toolbar flex items-center justify-between px-3 py-2 border-b shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const AppIcon = getAppIcon(openApp.type);
                        return <AppIcon size={16} className="text-muted-foreground shrink-0" />;
                      })()}
                      <span className="text-sm font-medium truncate">
                        {openApp.title || t('common:untitled')}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({t(`learningHub:resourceType.${openApp.type}`, openApp.type)})
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInLearningHub} aria-label="在学习中心打开" title="在学习中心打开" className="!h-7 !w-7">
                        <ArrowSquareOut size={14} className="text-muted-foreground" />
                      </NotionButton>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCloseApp} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                        <X size={16} className="text-muted-foreground" />
                      </NotionButton>
                    </div>
                  </div>

                  {/* 应用内容 */}
                  <div className="flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <CircleNotch size={24} className="animate-spin text-muted-foreground" />
                          <span className="ml-2 text-muted-foreground">
                            {t('common:loading')}
                          </span>
                        </div>
                      }
                    >
                      <UnifiedAppPanel
                        type={openApp.type}
                        resourceId={openApp.id}
                        dstuPath={openApp.filePath || `/${openApp.id}`}
                        onClose={handleCloseApp}
                        onTitleChange={handleTitleChange}
                        className="h-full"
                      />
                    </Suspense>
                  </div>
                </div>
              ) : (
                <LearningHubSidebar
                  mode="canvas"
                  onClose={() => setLearningHubSheetOpen(false)}
                  onOpenApp={handleOpenApp}
                  className="h-full"
                />
              )}
            </div>
          </div>
        </SidebarDrawer>
      )}

      {/* CardForge 2.0 Anki 编辑面板 - 监听 open-anki-panel 事件 */}
        <AnkiPanelHost />

      {/* 归档分组确认对话框 */}
        <NotionAlertDialog
          open={!!pendingArchiveGroup}
          onOpenChange={(open) => !open && setPendingArchiveGroup(null)}
          title={t('page.archiveGroupTitle')}
          description={t('page.archiveGroupDesc', { name: pendingArchiveGroup?.name })}
          confirmText={t('page.archiveGroupConfirm')}
          cancelText={t('common:cancel')}
          confirmVariant="warning"
          onConfirm={confirmArchiveGroup}
        />

      </div>
    </StreamPreferencesProvider>
  );
};

export default ChatV2Page;
