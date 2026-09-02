/**
 * Chat V2 - 正式页面入口
 *
 * 提供完整的 Chat V2 聊天界面，支持：
 * 1. 会话管理（创建/切换/删除）
 * 2. 消息交互（发送/流式回复）
 * 3. 多种功能（RAG/图谱/记忆/网络搜索）
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Chat, X, FileText, BookOpen, ClipboardText, Image, File, CircleNotch, DotsSixVertical, Warning, ArrowSquareOut, SquaresFour } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ChatContainer } from '../components/ChatContainer';
import { ChatErrorBoundary } from '../components/ChatErrorBoundary';
import { ThreadEmptyStateShell } from '../components/ui/ThreadEmptyStateShell';
import { SessionBrowser } from '../components/session-browser';
import { getErrorMessage } from '@/utils/errorUtils';
import { unifiedConfirm } from '@/utils/unifiedDialogs';
// Learning Hub 学习资源侧边栏
import { LearningHubSidebar } from '@/features/learning-hub';
import type { ResourceListItem, ResourceType } from '@/features/learning-hub/types';
import { useFinderStore } from '@/features/learning-hub/stores/finderStore';
import { useNotesOptional } from '@/features/notes/NotesContext';
import { lazy, Suspense } from 'react';

import { GroupEditorPanel, PRESET_ICONS } from '../components/groups/GroupEditorDialog';
import { useGroupManagement } from '../hooks/useGroupManagement';
import { useGroupCollapse } from '../hooks/useGroupCollapse';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import { usePageMount } from '@/debug-panel/hooks/usePageLifecycle';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useViewStore } from '@/stores/viewStore';
import { SandboxWorkbenchSurface } from '@/features/sandbox/components/SandboxWorkbenchSurface';
import {
  createSandboxOwnerKey,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from '@/app/shell/DesktopShellIcons';
import { DESKTOP_SHELL } from '@/app/shell/desktopShell';
// P1-07: 导入 sessionManager 以访问当前会话 store
import { sessionManager } from '../core/session/sessionManager';
import { useUIStore } from '@/stores/uiStore';

// 懒加载统一应用面板
const UnifiedAppPanel = lazy(() => import('@/features/learning-hub/apps/UnifiedAppPanel').then(m => ({ default: m.UnifiedAppPanel })));

// 🆕 对话控制面板（侧栏版）
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useSessionLifecycle } from './useSessionLifecycle';
import { useSessionEdit } from './useSessionEdit';
import { useChatPageLayout } from './useChatPageLayout';
import { useChatPageEvents } from './useChatPageEvents';
import { useSessionItemRenderer } from './SessionItemRenderer';
import { useSessionSidebarContent } from './SessionSidebarContent';
import { compareSessionsForSidebar } from '../utils/sessionPin';
import { StreamPreferencesProvider } from '../components/renderers/StreamPreferencesContext';
import type { StreamingSmoothingPreset } from '../components/renderers/streamingSmoothing';
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

type DesktopSecondaryPanelMode = 'sandbox' | 'attachment' | 'canvas';

interface DesktopSecondaryPanelSnapshot {
  mode: DesktopSecondaryPanelMode;
  openApp: OpenApp | null;
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
// 次级面板动效对齐 chat 动效 token（motion.css）：
// - 时长 = --chat-motion-base（200ms）；JS 侧 setTimeout 需要数值，
//   与下方 duration-[var(--chat-motion-base)] 保持同源语义（token 变更时同步此值）
// - 缓动 = --chat-motion-ease（标准出口曲线）
const DESKTOP_SECONDARY_PANEL_TRANSITION_MS = 200;
const DESKTOP_SECONDARY_PANEL_EASING = 'var(--chat-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))';
const DESKTOP_SECONDARY_PANEL_WIDTH = 'clamp(320px, 42vw, 720px)';

// ============================================================================
// 组件实现
// ============================================================================

export interface ChatV2PageProps {
  /**
   * OS 模式壳层降档信号（缺省 balanced 全速，独立页面/移动端行为不变）：
   * 窗口不可见时由 ChatAppWindow 经 useDeferredStreamPreset 降为 silky。
   */
  streamPreset?: StreamingSmoothingPreset;
  /**
   * OS 模式 background 档：壳层已停绘（visibility:hidden），流式渲染提交
   * 应暂停（token 缓冲不丢，回可见立即补渲）。缺省 false 行为不变。
   */
  isSuspended?: boolean;
}

export const ChatV2Page: React.FC<ChatV2PageProps> = ({
  streamPreset = 'balanced',
  isSuspended = false,
}) => {
  const { t } = useTranslation(['chatV2', 'learningHub', 'common']);

  // ========== 页面生命周期监控 ==========
  usePageMount('chat-v2', 'ChatV2Page');

  // ========== 响应式布局支持 ==========
  const { isSmallScreen } = useBreakpoint();
  const [sandboxOwnerKey] = useState(() => createSandboxOwnerKey('chat-page'));

  useEffect(() => {
    return () => {
      useSandboxWorkbenchStore.getState().disposeOwner(sandboxOwnerKey);
    };
  }, [sandboxOwnerKey]);

  // 状态声明提前，供下方多个布局/事件 hook 使用
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionIdState] = useState<string | null>(null);

  // 🔧 P1-26 + P1-28: 包装 setCurrentSessionId
  // - 同步更新 sessionManager（P1-26）
  // - 保存到 localStorage（P1-28）
  // 副作用移出 setState updater（updater 必须纯函数，StrictMode 下会被双调用）
  const currentSessionIdRef = useRef<string | null>(null);
  const setCurrentSessionId = useCallback((sessionIdOrUpdater: string | null | ((prev: string | null) => string | null)) => {
    const prev = currentSessionIdRef.current;
    const newId = typeof sessionIdOrUpdater === 'function' ? sessionIdOrUpdater(prev) : sessionIdOrUpdater;
    currentSessionIdRef.current = newId;
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
      useSandboxWorkbenchStore.getState().closeSession(sandboxOwnerKey);
    }
    setCurrentSessionIdState(newId);
  }, [sandboxOwnerKey]);
  // 🔧 P1-005 修复：使用 ref 追踪最新状态，避免 deleteSession 中的闭包竞态条件
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const sandboxActiveSession = useSandboxWorkbenchStore(
    (state) => selectSandboxWorkbenchOwnerState(state, sandboxOwnerKey).activeSession,
  );
  const sandboxWorkbenchOpen = useSandboxWorkbenchStore(
    (state) => selectSandboxWorkbenchOwnerState(state, sandboxOwnerKey).isOpen,
  );
  const activateSandboxOwner = useSandboxWorkbenchStore((state) => state.activateOwner);
  const openSandboxWorkbench = useSandboxWorkbenchStore((state) => state.openWorkbench);
  const closeSandboxWorkbench = useSandboxWorkbenchStore((state) => state.closeWorkbench);
  const handleSandboxOwnerActivation = useCallback(() => {
    activateSandboxOwner(sandboxOwnerKey);
  }, [activateSandboxOwner, sandboxOwnerKey]);
  // 移动端：资源库右侧滑屏状态
  const [mobileResourcePanelOpen, setMobileResourcePanelOpen] = useState(false);
  // ★ 移动端右屏资源库多选状态：学习资源面板不再自带次顶栏，多选切换按钮
  // 上移全局顶栏（useChatPageLayout 渲染），此处仅镜像状态 + 透传切换句柄。
  const [resourceMultiSelectActive, setResourceMultiSelectActive] = useState(false);
  const resourceMultiSelectToggleRef = useRef<(() => void) | null>(null);
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
  const [desktopSecondaryPanelSnapshot, setDesktopSecondaryPanelSnapshot] = useState<DesktopSecondaryPanelSnapshot | null>(null);

  // 会话切换加载态统一：由 ChatContainer 负责「保留上一帧 + 轻蒙层」，
  // 页面级不再叠加第二层全屏切换指示器（避免双指示器打架）

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
  const [groupEditorDirty, setGroupEditorDirty] = useState(false);
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

  const activeGroupIds = useMemo(() => new Set(groups.map((group) => group.id)), [groups]);

  const staleSessionGroups = useMemo<SessionGroup[]>(() => {
    const staleGroupIds = Array.from(new Set(
      sessions
        .map((session) => session.groupId)
        .filter((groupId): groupId is string => !!groupId)
        .filter((groupId) => !activeGroupIds.has(groupId))
    ));
    const now = new Date().toISOString();
    return staleGroupIds.map((groupId, index) => ({
      id: groupId,
      name: t('browser.staleTopic'),
      description: t('browser.staleTopicDescription'),
      icon: 'Folder',
      color: 'muted',
      defaultSkillIds: [],
      pinnedResourceIds: [],
      sortOrder: Number.MAX_SAFE_INTEGER - staleGroupIds.length + index,
      persistStatus: 'archived',
      createdAt: now,
      updatedAt: now,
    }));
  }, [activeGroupIds, sessions, t]);

  const displayGroups = useMemo(
    () => [...groups, ...staleSessionGroups],
    [groups, staleSessionGroups]
  );

  const groupNameMap = useMemo(() => {
    const map = new Map<string, string>();
    displayGroups.forEach((group) => {
      // 判断 icon 是预设图标名称还是 emoji，只有 emoji 才添加到标签前面
      const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
      const label = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
      map.set(group.id, label);
    });
    return map;
  }, [displayGroups]);

  const visibleGroups = useMemo(() => {
    if (!normalizedSearchQuery) return displayGroups;
    return displayGroups.filter((group) => {
      const text = `${group.name} ${group.description ?? ''}`.toLowerCase();
      if (text.includes(normalizedSearchQuery)) return true;
      return (sessionsByGroup.get(group.id) ?? []).length > 0;
    });
  }, [displayGroups, normalizedSearchQuery, sessionsByGroup]);

  const editableVisibleGroups = useMemo(
    () => visibleGroups.filter((group) => activeGroupIds.has(group.id)),
    [activeGroupIds, visibleGroups]
  );

  const groupDragDisabled = normalizedSearchQuery.length > 0;

  const sessionsForBrowser = useMemo(() => {
    // ★ 性能：分组查找建 Map，避免每个 session 在 displayGroups 上线性 find
    // （O(sessions×groups) → O(sessions+groups)）
    const groupById = new Map(displayGroups.map((group) => [group.id, group]));
    return sessions.map((s) => ({
      ...s,
      groupName: s.groupId ? groupNameMap.get(s.groupId) : undefined,
      workspaceKey: (() => {
        const metadata = s.metadata ?? {};
        const direct = metadata.workspaceId ?? metadata.workspace_id
          ?? metadata.defaultRuntimeRootId ?? metadata.default_runtime_root_id;
        if (typeof direct === 'string' && direct.trim()) return direct;
        const group = s.groupId ? groupById.get(s.groupId) : undefined;
        return group?.defaultRuntimeRootId ?? 'default';
      })(),
    }));
  }, [displayGroups, groupNameMap, sessions]);

  // 浏览模式的分组信息
  const browserGroups = useMemo(() => {
    return [...groups, ...staleSessionGroups].map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      color: g.color,
      sortOrder: g.sortOrder,
    }));
  }, [groups, staleSessionGroups]);

  // 未分组会话（仍按时间分组展示）
  const ungroupedSessions = useMemo(
    () => filteredSessions.filter((s) => !s.groupId),
    [filteredSessions]
  );

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // P2-4 fix: Prune stale collapsed state when groups change
  useEffect(() => {
    if (groups.length > 0) {
      pruneDeletedGroups(groups.map((g) => g.id));
    }
  }, [groups, pruneDeletedGroups]);

  // P1-22: 分页状态
  const PAGE_SIZE = 50;
  const [hasMoreSessions, setHasMoreSessions] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // 真实的会话总数（用于显示）
  const [totalSessionCount, setTotalSessionCount] = useState<number | null>(null);
  const [ungroupedSessionCount, setUngroupedSessionCount] = useState<number | null>(null);

  // ===== 会话生命周期 hook =====
  const {
    loadUngroupedCount, createSession, createAnalysisSession,
    loadSessions, loadMoreSessions, deleteSession,
    getOrCreateHiddenDraftSession, handleViewAgentSession,
  } = useSessionLifecycle({
    currentSessionId,
    setSessions, setCurrentSessionId, setIsLoading, setTotalSessionCount,
    setUngroupedSessionCount, setHasMoreSessions, setIsInitialLoading,
    setIsLoadingMore,
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
        setSessions((prev) => {
          // ★ 性能：列表项已是目标标题时返回原引用，跳过整页重渲染
          // 及其连带的会话列表排序/分组派生重算
          const existing = prev.find((s) => s.id === currentSessionId);
          if (
            !existing ||
            (existing.title === state.title &&
              existing.description === (state.description ?? existing.description))
          ) {
            return prev;
          }
          return prev.map((s) =>
            s.id === currentSessionId
              ? { ...s, title: state.title, description: state.description ?? s.description }
              : s
          );
        });
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
    handleSubmitGroup, confirmArchiveGroup, archiveGroupDirect, applySessionGroupUpdate,
    moveSessionToGroup, handleDragEnd, formatTime,
  } = useSessionEdit({
    resetDeleteConfirmation, currentSessionId, setCurrentSessionId, setEditingSessionId, setEditingTitle,
    setRenamingSessionId, setRenameError, setSessions,
    setGroupEditorOpen, setEditingGroup, setGroupEditorAutoFocusField,
    setViewMode, setSessionSheetOpen, setPendingArchiveGroup,
    setGroupPinnedIds, setMobileResourcePanelOpen,
    editingTitle, editingGroup, pendingArchiveGroup, sessionsRef,
    groupPickerAddRef, t,
    updateGroup, createGroup, archiveGroup, reorderGroups,
    loadUngroupedCount, getOrCreateHiddenDraftSession, groupDragDisabled, visibleGroups: editableVisibleGroups,
  });

  const groupEditorCloseConfirmKeyRef = useRef(0);
  useEffect(() => {
    if (groupEditorOpen) {
      groupEditorCloseConfirmKeyRef.current += 1;
    }
  }, [groupEditorOpen]);

  const requestCloseGroupEditor = useCallback(() => {
    if (groupEditorDirty && !unifiedConfirm(
      t('page.groupUnsavedChangesConfirm'),
      { key: `chat-group-editor-unsaved-${groupEditorCloseConfirmKeyRef.current}` },
    )) {
      return false;
    }
    setGroupEditorDirty(false);
    closeGroupEditor();
    return true;
  }, [closeGroupEditor, groupEditorDirty, t]);

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
      const { action, session, sessionId, groupId } = (event as CustomEvent).detail ?? {};

      // 桌面 ModernSidebar 直接删除/移动会话后，同步本页 sessions 状态（避免 Browser/移动列表残留）
      if (action === 'session-deleted' && typeof sessionId === 'string') {
        setSessions((prev) => prev.filter((item) => item.id !== sessionId));
        setTotalSessionCount((prev) => (prev !== null ? Math.max(0, prev - 1) : null));
        void loadUngroupedCount();
        return;
      }
      if (action === 'session-moved' && typeof sessionId === 'string') {
        applySessionGroupUpdate(sessionId, typeof groupId === 'string' && groupId ? groupId : null);
        void loadUngroupedCount();
        return;
      }

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
  }, [applySessionGroupUpdate, loadUngroupedCount, setCurrentSessionId, setSessionSheetOpen, setViewMode, startEditSession]);

  // ===== 移动端右屏/子屏收口 =====
  // 沙箱工作台占据右屏时，顶栏返回箭头与手势/返回键统一走这里收回
  const mobileSandboxOpen = sandboxWorkbenchOpen && !!sandboxActiveSession;
  const closeMobileSandbox = useCallback(() => {
    closeSandboxWorkbench(sandboxOwnerKey);
    setMobileResourcePanelOpen(false);
  }, [closeSandboxWorkbench, sandboxOwnerKey]);
  // 右屏资源预览返回上一层（资源库列表），而非直接退回聊天
  const closeMobileOpenApp = useCallback(() => {
    setOpenApp(null);
  }, []);

  // ===== Android 返回键：中屏子视图（会话浏览 / 分组编辑器）逐层返回 =====
  // 左/右屏由 MobileSlidingLayout 以 overlay 优先级先行消费，这里只处理中屏内容
  const mobileCenterBackRef = useRef({ viewMode, groupEditorOpen });
  mobileCenterBackRef.current = { viewMode, groupEditorOpen };
  useEffect(() => {
    if (!isSmallScreen) return;
    return registerBackHandler(() => {
      // 页面常驻挂载：仅在 chat-v2 为当前视图时消费返回键
      if (useViewStore.getState().currentView !== 'chat-v2') return false;
      const {
        viewMode: centerMode,
        groupEditorOpen: editorOpen,
      } = mobileCenterBackRef.current;
      if (centerMode === 'browser') {
        setViewMode('sidebar');
        setSessionSheetOpen(true);
        return true;
      }
      if (editorOpen) {
        requestCloseGroupEditor();
        return true;
      }
      return false;
    }, BACK_PRIORITY.view);
  }, [isSmallScreen, requestCloseGroupEditor, setSessionSheetOpen, setViewMode]);

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
    editingTitle, renamingSessionId, renameError, groups: visibleGroups, sessions, totalSessionCount,
    t, resetDeleteConfirmation, setCurrentSessionId, setHoveredSessionId: () => {},
    setEditingTitle, setPendingDeleteSessionId, setPendingArchiveSessionId, setSessions, setViewMode,
    clearDeleteConfirmTimeout, deleteConfirmTimeoutRef,
    startEditSession, saveSessionTitle, cancelEditSession,
    moveSessionToGroup, deleteSession, archiveSession, togglePinSession, formatTime,
    // B3: 移动端点会话条目后收起左抽屉并回到聊天中屏
    //（浏览视图下打开抽屉选会话也能闭环；桌面端不渲染该侧栏，空操作无副作用）
    onSessionActivated: () => {
      setViewMode('sidebar');
      setSessionSheetOpen(false);
    },
  });

  // ===== 侧边栏内容 hook =====
  const { renderSessionSidebarContent, renderSessionSidebarHeader } = useSessionSidebarContent({
    searchQuery, setSearchQuery, viewMode, setViewMode, setSessionSheetOpen,
    editableGroupIds: activeGroupIds,
    onCreateGroup: openCreateGroup,
    onRenameGroup: openRenameGroup,
    onEditGroup: openEditGroup,
    // 移动侧栏自带分组归档行内确认，确认后直接执行（不再走 pendingArchiveGroup 主区确认条）
    onArchiveGroup: (group) => { void archiveGroupDirect(group); },
    isInitialLoading, sessions, visibleGroups, sessionsByGroup, ungroupedSessions,
    currentSessionId,
    hasMoreSessions, isLoadingMore,
    t,
    resetDeleteConfirmation,
    createSession, loadMoreSessions,
    renderSessionItem,
    // 会话拖入分组（hello-pangea DnD；handleDragEnd 识别 session-group:/session-ungrouped）
    onSessionDragEnd: handleDragEnd,
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
  const toggleSandboxWorkbench = useCallback(() => {
    if (!sandboxActiveSession) return;

    if (sandboxWorkbenchOpen) {
      closeSandboxWorkbench(sandboxOwnerKey);
    } else {
      openSandboxWorkbench(sandboxOwnerKey);
    }
  }, [closeSandboxWorkbench, openSandboxWorkbench, sandboxActiveSession, sandboxOwnerKey, sandboxWorkbenchOpen]);

  const desktopSecondaryPanelMode: DesktopSecondaryPanelMode | null = sandboxWorkbenchOpen && sandboxActiveSession
    ? 'sandbox'
    : attachmentPreviewOpen && openApp
      ? 'attachment'
      : canvasSidebarOpen
        ? 'canvas'
        : null;
  const desktopSecondaryPanelOpen = !isSmallScreen && desktopSecondaryPanelMode !== null;
  const desktopSecondaryPanelSnapshotApp = desktopSecondaryPanelMode === 'attachment'
    ? openApp
    : desktopSecondaryPanelSnapshot?.mode === 'attachment'
      ? desktopSecondaryPanelSnapshot.openApp
      : null;
  const desktopSecondaryPanelSnapshotMode = desktopSecondaryPanelMode ?? desktopSecondaryPanelSnapshot?.mode ?? null;

  useEffect(() => {
    if (isSmallScreen) {
      setDesktopSecondaryPanelSnapshot(null);
      return;
    }

    if (desktopSecondaryPanelMode) {
      // ★ 内容相同则跳过 set：避免每次 set 新对象字面量触发
      //   「状态变化 → 重渲染 → effect 重跑 → 又 set 新对象」的自续循环
      const nextOpenApp = desktopSecondaryPanelMode === 'attachment' ? openApp : null;
      if (
        desktopSecondaryPanelSnapshot?.mode === desktopSecondaryPanelMode &&
        desktopSecondaryPanelSnapshot.openApp === nextOpenApp
      ) {
        return;
      }
      setDesktopSecondaryPanelSnapshot({
        mode: desktopSecondaryPanelMode,
        openApp: nextOpenApp,
      });
      return;
    }

    if (!desktopSecondaryPanelSnapshot) {
      return;
    }

    const timer = window.setTimeout(() => {
      setDesktopSecondaryPanelSnapshot(null);
    }, DESKTOP_SECONDARY_PANEL_TRANSITION_MS);

    return () => window.clearTimeout(timer);
  }, [desktopSecondaryPanelMode, desktopSecondaryPanelSnapshot, isSmallScreen, openApp]);

  const desktopSecondaryPanelShouldRender = !isSmallScreen && desktopSecondaryPanelSnapshotMode !== null;
  const desktopSecondaryPanelShellClassName = cn(
    'h-full overflow-hidden will-change-transform transition-[transform,opacity] duration-[var(--chat-motion-base,200ms)] motion-reduce:transition-none',
    desktopSecondaryPanelOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-full opacity-0'
  );

  const renderDesktopSecondaryPanel = (options?: { mode?: DesktopSecondaryPanelMode | null; openApp?: OpenApp | null }) => {
    const panelMode = options?.mode ?? desktopSecondaryPanelMode;
    const panelOpenApp = options?.openApp ?? openApp;

    if (!panelMode) {
      return null;
    }

    if (panelMode === 'sandbox' && sandboxActiveSession) {
      return (
        <div className="h-full transition-[opacity,transform] duration-200 ease-[var(--panel-ease)] motion-reduce:transition-none opacity-100 translate-x-0">
          <SandboxWorkbenchSurface
            embedded
            className="h-full"
            onClose={handleCloseSandbox}
            ownerKey={sandboxOwnerKey}
          />
        </div>
      );
    }

    if (panelMode === 'attachment' && panelOpenApp) {
      return renderOpenAppPanel({ openAppOverride: panelOpenApp });
    }

    return (
      <PanelGroup direction="horizontal" className="h-full" autoSaveId="chat-v2-canvas-panels">
        {/* Learning Hub 侧边栏 */}
        <Panel
          id="chat-v2-canvas-sidebar"
          order={1}
          defaultSize={openApp ? 35 : 100}
          minSize={openApp ? 25 : 100}
          className="h-full"
        >
          <LearningHubSidebar
            mode="canvas"
            hostId="canvas"
            sessionActive={canvasSidebarOpen}
            commandsEnabled={false}
            onClose={toggleCanvasSidebar}
            onOpenApp={handleOpenApp}
            onReferenceToChat={() => {
              // Sidebar injects via useVfsContextInject; callback keeps the entry wired.
            }}
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
              id="chat-v2-canvas-app"
              order={2}
              defaultSize={65}
              minSize={40}
              className="h-full"
            >
              {renderOpenAppPanel()}
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
    setMobileResourcePanelOpen(false);
  }, [openApp, handleCloseApp, setMobileResourcePanelOpen]);

  // ===== 页面布局 hook =====
  useChatPageLayout({
    currentSession, currentSessionId, expandGroup, currentSessionHasMessages,
    viewMode, sessionSheetOpen, t, sessionCount: sessions.length,
    createSession, isLoading,
    mobileResourcePanelOpen, finderBreadcrumbs, finderJumpToBreadcrumb,
    setMobileResourcePanelOpen, setSessionSheetOpen, setViewMode,
    mobileSandboxOpen, closeMobileSandbox,
    openAppTitle: openApp ? (openApp.title ?? '') : null,
    closeMobileOpenApp,
    groupEditorOpen,
    groupEditorMode: editingGroup ? 'edit' : 'create',
    closeGroupEditor: requestCloseGroupEditor,
    resourceMultiSelectActive,
    resourceMultiSelectToggleRef,
  });

  // ★ 标题更新回调
  const handleTitleChange = useCallback((title: string) => {
    setOpenApp(prev => prev ? { ...prev, title } : null);
  }, []);

  const renderOpenAppPanel = useCallback((
    options?: {
      fullScreen?: boolean;
      onClose?: () => void;
      openAppOverride?: OpenApp | null;
    }
  ) => {
    const panelOpenApp = options?.openAppOverride ?? openApp;
    if (!panelOpenApp) return null;

    const handleClose = options?.onClose ?? handleCloseApp;

    return (
      <div className={cn(
        'study-shell-panel h-full flex flex-col',
        !options?.fullScreen && 'border-l border-[color:var(--shell-inspector-border)]'
      )}>
        <div
          className={cn(
            'study-shell-toolbar items-center justify-between px-3 py-2 border-b shrink-0',
            isSmallScreen && options?.fullScreen ? 'hidden' : 'flex',
            options?.fullScreen && 'study-shell-toolbar--floating backdrop-blur-lg'
          )}
          aria-hidden={isSmallScreen && options?.fullScreen}
        >
          <div className="flex items-center gap-2 min-w-0">
            {(() => {
              const AppIcon = getAppIcon(panelOpenApp.type);
              return <AppIcon size={16} className="text-muted-foreground shrink-0" />;
            })()}
            <span className="text-sm font-medium truncate">
              {panelOpenApp.title || t('common:untitled')}
            </span>
            <span className="text-xs text-muted-foreground">
              ({t(`learningHub:resourceType.${panelOpenApp.type}`, panelOpenApp.type)})
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DsButton variant="ghost" size="icon" iconOnly onClick={handleOpenInLearningHub} aria-label={t('page.openInLearningHub')} title={t('page.openInLearningHub')} className="!h-7 !w-7">
              <ArrowSquareOut size={14} className="text-muted-foreground" />
            </DsButton>
            <DsButton variant="ghost" size="icon" iconOnly onClick={handleClose} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
              <X size={16} className="text-muted-foreground" />
            </DsButton>
          </div>
        </div>

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
              type={panelOpenApp.type}
              resourceId={panelOpenApp.id}
              dstuPath={panelOpenApp.filePath || `/${panelOpenApp.id}`}
              onClose={handleClose}
              onTitleChange={handleTitleChange}
              isActive
              className="h-full"
            />
          </Suspense>
        </div>
      </div>
    );
  }, [openApp, handleCloseApp, handleOpenInLearningHub, handleTitleChange, isSmallScreen, t]);

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

  // ===== 无会话空状态 / 首屏加载态（统一在主内容槽内联渲染，不用模态） =====
  const renderNoSessionState = () => {
    if (isInitialLoading) {
      // 首次加载：延迟淡入的安静指示（chat-loading-shell-defer 自带 150ms 延迟，避免闪烁）
      return (
        <div className="chat-loading-shell-defer flex flex-1 items-center justify-center" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-muted-foreground">
            <CircleNotch size={16} className="animate-spin" aria-hidden="true" />
            <span className="text-sm">{t('page.loading')}</span>
          </div>
        </div>
      );
    }
    // 加载完成仍无会话（自动创建失败等）：与会话内空态共用 ThreadEmptyStateShell
    // 统一内容模型（品牌 → 标题 → 描述 → CTA → hint）
    return (
      <CustomScrollArea
        data-slot="chat-page-empty-state"
        className="chat-thread-enter min-h-0 flex-1"
        viewportClassName="px-6 py-8"
      >
        <div className="flex min-h-full items-center justify-center">
          <ThreadEmptyStateShell
            title={t('page.welcome')}
            brandIcon={<Chat size={26} weight="duotone" />}
            description={t('page.emptyPage.subtitle')}
            hint={t('page.emptyPage.hint')}
            actions={
              <>
                <DsButton variant="primary" size="sm" onClick={() => void createSession()}>
                  <Plus size={14} />
                  {t('page.newChat')}
                </DsButton>
                {!isSmallScreen && sessions.length > 0 && (
                  <DsButton variant="outline" size="sm" onClick={() => setViewMode('browser')}>
                    <SquaresFour size={14} />
                    {t('browser.title')}
                  </DsButton>
                )}
              </>
            }
          />
        </div>
      </CustomScrollArea>
    );
  };

  // ===== 归档分组内联确认条（替代模态确认框；Esc 取消，取消键自动聚焦） =====
  const renderArchiveConfirmBar = () => pendingArchiveGroup ? (
    <div
      role="alertdialog"
      aria-label={t('page.archiveGroupTitle')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setPendingArchiveGroup(null);
        }
      }}
      className="chat-thread-enter z-30 mx-3 mt-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-shell-control)] border border-warning/40 bg-warning/10 px-3 py-2 shadow-[var(--shadow-shell-soft)]"
    >
      <Warning size={16} weight="fill" className="shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm leading-snug text-foreground">
        {t('page.archiveGroupDesc', { name: pendingArchiveGroup.name })}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <DsButton
          variant="ghost"
          size="sm"
          autoFocus
          onClick={() => setPendingArchiveGroup(null)}
        >
          {t('common:cancel')}
        </DsButton>
        <DsButton variant="warning" size="sm" onClick={() => void confirmArchiveGroup()}>
          {t('page.archiveGroupConfirm')}
        </DsButton>
      </div>
    </div>
  ) : null;

  // ★ 监听附件预览事件，在右侧面板打开附件
  // 使用独立的附件预览状态，不依赖于 NotesContext
  const renderMainContent = () => (
    <div className="flex h-full min-h-0 flex-col overflow-hidden relative">
      {renderArchiveConfirmBar()}
      {/* 使用 currentSessionId 作为主要判断条件，选中会话时立即显示内容 */}
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
          onClose={requestCloseGroupEditor}
          onDirtyChange={setGroupEditorDirty}
          onArchive={editingGroup ? () => {
            setPendingArchiveGroup(editingGroup);
            closeGroupEditor();
          } : undefined}
          onMobileBrowse={isSmallScreen ? (addResource, currentIds) => {
            groupPickerAddRef.current = addResource;
            setGroupPinnedIds(new Set(currentIds));
            // 清掉残留的资源预览，确保右屏展示的是资源库选择列表
            setOpenApp(null);
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
        renderNoSessionState()
      )}
    </div>
  );

  return (
    <StreamPreferencesProvider preset={streamPreset} mode="blocked" suspended={isSuspended}>
      <div className={cn(
        "study-shell-page chat-v2 absolute inset-0 flex overflow-hidden",
        isSmallScreen && "flex-col"
      )}
        data-wb-chat-session={currentSessionId ?? undefined}
        data-sandbox-owner-key={sandboxOwnerKey}
        onPointerDownCapture={handleSandboxOwnerActivation}
        onFocusCapture={handleSandboxOwnerActivation}
      >
      {/* 页面级错误隔离：SessionBrowser / GroupEditor / 次级面板等线程外区域的
          运行时错误在此兜底，避免打穿到 App ViewLayer 白屏整页。
          resetKey：切换会话时自动清除错误态并 remount 子树 */}
      <ChatErrorBoundary className="flex-1" resetKey={currentSessionId}>
      {/* ===== 移动端布局：DeepSeek 风格推拉式侧边栏 ===== */}
      {isSmallScreen ? (
        <MobileSlidingLayout
          className="flex-1"
          drawerHeader={renderSessionSidebarHeader()}
          sidebar={
            <div className="min-h-0">
              {renderSessionSidebarContent({ unifiedMobileDrawer: true, mobileDrawerHeader: 'fixed' })}
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
                  ownerKey={sandboxOwnerKey}
                />
              ) : openApp ? (
                renderOpenAppPanel({
                  fullScreen: true,
                  onClose: closeMobileOpenApp,
                })
              ) : (
                <LearningHubSidebar
                  mode="canvas"
                  hostId="canvas-mobile"
                  sessionActive={mobileResourcePanelOpen}
                  commandsEnabled={false}
                  onClose={() => setMobileResourcePanelOpen(false)}
                  onMultiSelectModeChange={setResourceMultiSelectActive}
                  multiSelectToggleRef={resourceMultiSelectToggleRef}
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
                  onReferenceToChat={() => {
                    // Sidebar injects via useVfsContextInject; callback keeps the entry wired.
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
            if (pos !== 'right' && openApp && !sandboxWorkbenchOpen) {
              setOpenApp(null);
            }
            setSessionSheetOpen(pos === 'left');
            setMobileResourcePanelOpen(pos === 'right');
            if (pos !== 'right' && sandboxWorkbenchOpen) {
              closeSandboxWorkbench(sandboxOwnerKey);
            }
          }}
          rightPanelEnabled={true}
          sidebarWidth="auto"
          showSidebarAppNavigation
          showContentOverlay
          enableGesture={true}
          edgeWidth={20}
          threshold={0.3}
        >
          {/* 移动端：会话浏览作为主内容区域的一部分，直接切换 */}
          <div className="relative flex h-full flex-col">
            {viewMode === 'browser' && renderArchiveConfirmBar()}
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
                className="min-h-0 flex-1"
                embeddedMode={true}
              />
            ) : (
              <div className="min-h-0 flex-1">
                {renderMainContent()}
              </div>
            )}
          </div>
        </MobileSlidingLayout>
      ) : null}

      {/* 桌面端：主聊天区域 + 次级面板（附件预览不再全屏替换聊天，统一走侧栏内联预览） */}
      {!isSmallScreen && (
        <div className="flex flex-1 min-w-0 h-full overflow-hidden">
          <div className="h-full min-h-0 min-w-0 flex-1">
            {renderMainContent()}
          </div>
          {desktopSecondaryPanelShouldRender && (
            <div
              className="h-full shrink-0 overflow-hidden border-l border-[color:var(--shell-inspector-border)] bg-background shadow-[-12px_0_32px_hsl(var(--shadow-base)/0.08)] transition-[width] duration-[var(--chat-motion-base,200ms)] motion-reduce:transition-none"
              style={{
                width: desktopSecondaryPanelOpen ? DESKTOP_SECONDARY_PANEL_WIDTH : 0,
                transitionTimingFunction: DESKTOP_SECONDARY_PANEL_EASING,
              }}
            >
              <div
                className={cn('h-full min-w-0', desktopSecondaryPanelShellClassName)}
                style={{
                  width: DESKTOP_SECONDARY_PANEL_WIDTH,
                  transitionTimingFunction: DESKTOP_SECONDARY_PANEL_EASING,
                }}
              >
                {renderDesktopSecondaryPanel({
                  mode: desktopSecondaryPanelSnapshotMode,
                  openApp: desktopSecondaryPanelSnapshotApp,
                })}
              </div>
            </div>
          )}
        </div>
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
            content={sandboxWorkbenchOpen ? t('page.collapseSandboxWorkbench') : t('page.expandSandboxWorkbench')}
            position="bottom"
          >
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={toggleSandboxWorkbench}
              className={cn(
                'relative overflow-hidden border border-border/80 bg-background/95 shadow-[var(--shadow-shell-soft)] backdrop-blur-md transition-[transform,opacity,background-color,color,border-color,box-shadow] duration-200 ease-[var(--dropdown-ease)] hover:bg-background hover:shadow-lg',
                sandboxWorkbenchOpen
                  ? '!h-8 !w-8 translate-x-0 rounded-[var(--shell-nav-row-radius)] border-foreground/10 bg-foreground/[0.04] text-foreground'
                  : '!h-8 !w-8 translate-x-0 rounded-[var(--shell-nav-row-radius)] text-muted-foreground'
              )}
              aria-label={sandboxWorkbenchOpen ? t('page.collapseSandboxWorkbench') : t('page.expandSandboxWorkbench')}
              title={sandboxWorkbenchOpen ? t('page.collapseSandboxWorkbench') : t('page.expandSandboxWorkbench')}
            >
              <span className="relative block h-[18px] w-[18px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-0 transition-[opacity,transform] duration-200 ease-[var(--dropdown-ease)]',
                    sandboxWorkbenchOpen ? 'translate-x-[-4px] opacity-0' : 'translate-x-0 opacity-100'
                  )}
                >
                  <SidebarFrameIcon />
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-0 transition-[opacity,transform] duration-200 ease-[var(--dropdown-ease)]',
                    sandboxWorkbenchOpen ? 'translate-x-0 opacity-100' : 'translate-x-[4px] opacity-0'
                  )}
                >
                  <SidebarFrameWithLeftRailIcon />
                </span>
              </span>
            </DsButton>
          </CommonTooltip>
        </div>
      )}

      </ChatErrorBoundary>
      </div>
    </StreamPreferencesProvider>
  );
};

export default ChatV2Page;
