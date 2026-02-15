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
import { Plus, MessageSquare, Trash2, Edit2, Check, X, LayoutGrid, Library, FileText, BookOpen, ClipboardList, Image, File, Loader2, GripVertical, Menu, ChevronRight, RefreshCw, SlidersHorizontal, Folder, Settings, ExternalLink } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvided, type DraggableStateSnapshot } from '@hello-pangea/dnd';
import { UnifiedSidebar, UnifiedSidebarHeader, UnifiedSidebarContent } from '@/components/ui/unified-sidebar/UnifiedSidebar';
import { UnifiedSidebarSection } from '@/components/ui/unified-sidebar/UnifiedSidebarSection';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { NotionButton } from '@/components/ui/NotionButton';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ChatContainer } from '../components/ChatContainer';
import { SessionBrowser } from '../components/session-browser';
import { getErrorMessage } from '@/utils/errorUtils';
import { TauriAPI } from '@/utils/tauriApi';
// Learning Hub 学习资源侧边栏
import { LearningHubSidebar } from '@/components/learning-hub';
import type { ResourceListItem, ResourceType } from '@/components/learning-hub/types';
import { useFinderStore } from '@/components/learning-hub/stores/finderStore';
import { MobileBreadcrumb } from '@/components/learning-hub/components/MobileBreadcrumb';
import { useNotesOptional } from '@/components/notes/NotesContext';
import { registerOpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode } from '@/dstu/types';
import { mapDstuNodeToLearningHubItem } from './openResourceMapping';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import { lazy, Suspense } from 'react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/shad/AlertDialog';
import { GroupEditorPanel, PRESET_ICONS } from '../components/groups/GroupEditorDialog';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import { useGroupManagement } from '../hooks/useGroupManagement';
import { useGroupCollapse } from '../hooks/useGroupCollapse';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../types/group';
import type { ChatSession } from '../types/session';
import { usePageMount, pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import { SidebarDrawer } from '@/components/ui/unified-sidebar/SidebarDrawer';
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
const UnifiedAppPanel = lazy(() => import('@/components/learning-hub/apps/UnifiedAppPanel'));

// CardForge 2.0 Anki 面板 (Chat V2 集成)
import { AnkiPanelHost } from '../anki';

// 🆕 对话控制面板（侧栏版）
import { AdvancedPanel } from '../plugins/chat/AdvancedPanel';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { shouldShowSessionActionButtons } from './sessionItemActionVisibility';

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
    case 'exam': return ClipboardList;
    case 'image': return Image;
    case 'file': return File;
    default: return FileText;
  }
};

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
const groupSessionsByTime = (sessions: ChatSession[]): Map<TimeGroup, ChatSession[]> => {
  const groups = new Map<TimeGroup, ChatSession[]>();
  const order: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'];
  order.forEach(g => groups.set(g, []));
  
  sessions.forEach(session => {
    const group = getTimeGroup(session.updatedAt);
    groups.get(group)?.push(session);
  });
  
  return groups;
};

// ============================================================================
// 常量
// ============================================================================

// 🔧 P1-28: localStorage 键，用于保存/恢复上次打开的会话
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
      }
      return newId;
    });
  }, [t]);
  // 🔧 P1-005 修复：使用 ref 追踪最新状态，避免 deleteSession 中的闭包竞态条件
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [learningHubSheetOpen, setLearningHubSheetOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  // 移动端：资源库右侧滑屏状态
  const [mobileResourcePanelOpen, setMobileResourcePanelOpen] = useState(false);
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
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
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
  useEffect(() => {
    const handleOpenNote = (event: CustomEvent<{ noteId: string; source?: string }>) => {
      const { noteId, source } = event.detail;
      if (!noteId) return;
      
      // 方案1: 使用 openCanvasWithNote 打开笔记并显示侧边栏
      if (notesContext?.openCanvasWithNote) {
        try {
          notesContext.openCanvasWithNote(noteId);
        } catch (error) {
          console.error('[ChatV2Page] Failed to open note in canvas:', error);
          showGlobalNotification('error', t('page.openNoteFailed', '打开笔记失败'));
        }
      } else {
        // 方案2: 备选 - 发送全局事件请求导航到 Learning Hub
        window.dispatchEvent(new CustomEvent('navigateToNote', {
          detail: { noteId, source }
        }));
      }
    };
    
    // TODO: migrate to centralized event registry
    window.addEventListener('DSTU_OPEN_NOTE' as any, handleOpenNote as any);
    return () => {
      window.removeEventListener('DSTU_OPEN_NOTE' as any, handleOpenNote as any);
    };
  }, [notesContext]);

  const loadUngroupedCount = useCallback(async () => {
    try {
      const count = await invoke<number>('chat_v2_count_sessions', {
        status: 'active',
        groupId: '',
      });
      setUngroupedSessionCount(count);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load ungrouped count:', getErrorMessage(error));
    }
  }, []);

  // 创建新会话（使用全局科目）- 提前定义用于 useMobileHeader
  const createSession = useCallback(async (groupId?: string) => {
    setIsLoading(true);
    try {
      const session = await createSessionWithDefaults({
        mode: 'chat',
        title: null,
        metadata: null,
        groupId,
      });

      setSessions((prev) => [session, ...prev]);
      setTotalSessionCount((prev) => (prev !== null ? prev + 1 : null));
      if (!groupId) {
        void loadUngroupedCount();
      }
      setCurrentSessionId(session.id);
    } catch (error) {
      console.error('[ChatV2Page] Failed to create session:', getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [loadUngroupedCount]);

  // P1-06: 创建分析模式会话
  // 打开文件对话框让用户选择图片，然后创建 analysis 模式会话
  const createAnalysisSession = useCallback(async () => {
    try {
      // 打开文件对话框选择图片
      const selected = await dialogOpen({
        multiple: true,
        directory: false,
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
          },
        ],
      });

      // 用户取消选择
      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        console.log('[ChatV2Page] No images selected for analysis session');
        return;
      }

      // 确保 selected 是数组
      const imagePaths = Array.isArray(selected) ? selected : [selected];

      setIsLoading(true);

      // 读取图片并转换为 base64
      const images: string[] = [];
      for (const path of imagePaths) {
        try {
          const bytes = await TauriAPI.readFileAsBytes(path);
          // 🔒 审计修复: 分块编码 base64，避免 String.fromCharCode(...bytes) 对大文件栈溢出
          // 原代码对 >1MB 文件触发 RangeError: Maximum call stack size exceeded
          const CHUNK_SIZE = 0x8000; // 32KB chunks
          let binary = '';
          for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            const chunk = bytes.subarray(i, i + CHUNK_SIZE);
            binary += String.fromCharCode.apply(null, Array.from(chunk));
          }
          const base64 = btoa(binary);
          // 根据文件扩展名确定 MIME 类型
          const ext = path.split('.').pop()?.toLowerCase() || 'png';
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
          images.push(`data:${mimeType};base64,${base64}`);
        } catch (error) {
          console.error('[ChatV2Page] Failed to read image:', path, error);
        }
      }

      if (images.length === 0) {
        console.error('[ChatV2Page] Failed to read any images');
        setIsLoading(false);
        return;
      }

      // 创建 analysis 模式会话，并传递图片作为初始化配置
      const session = await createSessionWithDefaults({
        mode: 'analysis',
        title: t('page.analysis_session_title'),
        metadata: {
          initConfig: {
            images,
          },
        },
        initConfig: {
          images,
        },
      });

      setSessions((prev) => [session, ...prev]);
      setTotalSessionCount((prev) => (prev !== null ? prev + 1 : null));
      void loadUngroupedCount();
      setCurrentSessionId(session.id);

      console.log('[ChatV2Page] Created analysis session:', session.id, 'with', images.length, 'images');
    } catch (error) {
      console.error('[ChatV2Page] Failed to create analysis session:', getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // ========== 移动端状态 ==========
  // 🚀 性能优化：使用 useDeferredValue 实现乐观更新
  // - currentSessionId 立即更新（侧边栏高亮立即响应）
  // - deferredSessionId 延迟更新（ChatContainer 重渲染在后台进行）
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
    deleteGroup,
    reorderGroups,
  } = useGroupManagement();
  const { collapsedMap, toggleGroupCollapse, expandGroup, pruneDeletedGroups } = useGroupCollapse();
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<SessionGroup | null>(null);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<SessionGroup | null>(null);
  
  // 视图模式：sidebar（侧边栏+聊天）或 browser（全宽浏览）
  const [viewMode, setViewMode] = useState<'sidebar' | 'browser'>('sidebar');
  
  // ★ 待打开的资源（用于 openResource handler）
  const [pendingOpenResource, setPendingOpenResource] = useState<ResourceListItem | null>(null);
  
  // ★ 当前打开的应用（复用 Learning Hub 的 UnifiedAppPanel）
  const [openApp, setOpenApp] = useState<OpenApp | null>(null);
  
  const normalizedSearchQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);

  // 过滤会话
  const filteredSessions = useMemo(() => {
    if (!normalizedSearchQuery) return sessions;
    return sessions.filter((s) => (s.title || '').toLowerCase().includes(normalizedSearchQuery));
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

  // 🔧 P1-29: 回收站状态
  const [showTrash, setShowTrash] = useState(false);
  // 🆕 对话控制侧栏标签页状态
  const [showChatControl, setShowChatControl] = useState(false);
  const [deletedSessions, setDeletedSessions] = useState<ChatSession[]>([]);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);

  // 加载会话列表（根据全局科目过滤）
  // 🔧 修复：不依赖 currentSessionId，避免与 useEffect 中的 setCurrentSessionId 形成循环
  // 🔧 分组懒加载修复：分别加载已分组会话（全量）和未分组会话（分页），确保每个分组都能显示其会话
  const loadSessions = useCallback(async () => {
    try {
      // 并行获取：所有已分组会话 + 未分组首页 + 计数
      const [groupedResult, ungroupedResult, totalCount, ungroupedCount] = await Promise.all([
        // groupId="*" 表示 group_id IS NOT NULL，一次性加载所有已分组会话
        invoke<ChatSession[]>('chat_v2_list_sessions', {
          status: 'active',
          groupId: '*',
          limit: 10000,
          offset: 0,
        }),
        // 未分组会话分页加载
        invoke<ChatSession[]>('chat_v2_list_sessions', {
          status: 'active',
          groupId: '',
          limit: PAGE_SIZE,
          offset: 0,
        }),
        invoke<number>('chat_v2_count_sessions', { status: 'active' }),
        invoke<number>('chat_v2_count_sessions', { status: 'active', groupId: '' }),
      ]);

      const allSessions = [...groupedResult, ...ungroupedResult]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setSessions(allSessions);
      setTotalSessionCount(totalCount);
      setUngroupedSessionCount(ungroupedCount);
      // "加载更多"只针对未分组会话
      setHasMoreSessions(ungroupedResult.length >= PAGE_SIZE);

      // 🔧 P1-28: 优先恢复上次打开的会话
      let sessionToSelect: string | null = null;

      // 尝试从 localStorage 读取上次会话 ID
      try {
        const lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
        if (lastSessionId) {
          // 检查该会话是否仍然存在于列表中
          const sessionExists = allSessions.some(s => s.id === lastSessionId);
          if (sessionExists) {
            sessionToSelect = lastSessionId;
            console.log('[ChatV2Page] Restoring last session:', lastSessionId);
          } else {
            // 🔧 批判性修复：lastSessionId 可能是：
            // 1) 不在第一页分页结果中的 sess_...
            // 2) Worker 会话 agent_...（被后端过滤，不会出现在 chat_v2_list_sessions）
            // 因此不能直接清理 localStorage，而是需要向后端校验存在性。
            try {
              const session = await invoke<ChatSession | null>('chat_v2_get_session', { sessionId: lastSessionId });
              if (session) {
                sessionToSelect = lastSessionId;
                console.log('[ChatV2Page] Restoring last session via get_session:', lastSessionId);
              } else {
                localStorage.removeItem(LAST_SESSION_KEY);
                console.log('[ChatV2Page] Last session truly not found, clearing:', lastSessionId);
              }
            } catch (e) {
              // 后端校验失败时，保守处理：清理 localStorage，避免死循环
              localStorage.removeItem(LAST_SESSION_KEY);
              console.warn('[ChatV2Page] Failed to validate last session, clearing:', lastSessionId, e);
            }
          }
        }
      } catch (e) {
        console.warn('[ChatV2Page] Failed to read last session ID:', e);
      }

      // 如果没有恢复的会话，回退到第一条
      if (!sessionToSelect && allSessions.length > 0) {
        sessionToSelect = allSessions[0].id;
      }

      // 🔧 优化空态体验：当没有任何会话时，自动创建一个空会话
      if (!sessionToSelect && allSessions.length === 0) {
        try {
          const newSession = await createSessionWithDefaults({
            mode: 'chat',
            title: null,
            metadata: null,
          });
          setSessions([newSession]);
          setTotalSessionCount(1);
          sessionToSelect = newSession.id;
          console.log('[ChatV2Page] Auto-created initial session:', newSession.id);
        } catch (e) {
          console.warn('[ChatV2Page] Failed to auto-create initial session:', e);
        }
      }

      setCurrentSessionId(sessionToSelect);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load sessions:', getErrorMessage(error));
    } finally {
      setIsInitialLoading(false);
    }
  }, []);

  // P1-22: 加载更多会话（无限滚动分页）
  // 🔧 分组懒加载修复：只加载更多未分组会话，已分组会话在初始加载时已全量获取
  // 🔧 批判性修复：使用 sessionsRef 动态计算 offset，避免删除/移动会话后 ref 漂移导致跳过会话
  const loadMoreSessions = useCallback(async () => {
    if (isLoadingMore || !hasMoreSessions) return;

    setIsLoadingMore(true);
    try {
      // 动态计算当前已加载的未分组会话数量作为 offset
      const currentUngroupedLoaded = sessionsRef.current.filter(s => !s.groupId).length;
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '',
        limit: PAGE_SIZE,
        offset: currentUngroupedLoaded,
      });

      if (result.length > 0) {
        setSessions(prev => [...prev, ...result]);
      }
      // 如果返回数量小于 PAGE_SIZE，说明没有更多数据
      setHasMoreSessions(result.length >= PAGE_SIZE);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load more sessions:', getErrorMessage(error));
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMoreSessions]);

  // ========== 🔧 P1修复：基于消息数量判断是否为空对话 ==========
  // 问题：原逻辑基于标题判断，但标题是后端异步生成的，导致有消息也不能新建
  // 修复：监听当前会话 store 的消息数量，有消息则可新建对话
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
    const initialHasMessages = store.getState().messageOrder.length > 0;
    setCurrentSessionHasMessages(initialHasMessages);
    
    // 订阅 store 的消息数量变化
    const unsubscribe = store.subscribe((state, prevState) => {
      const hasMessages = state.messageOrder.length > 0;
      const prevHasMessages = prevState.messageOrder.length > 0;
      // 只在状态变化时更新
      if (hasMessages !== prevHasMessages) {
        console.log('[ChatV2Page] Message count changed, hasMessages:', hasMessages);
        setCurrentSessionHasMessages(hasMessages);
      }
    });
    
    return unsubscribe;
  }, [currentSessionId]);

  // ========== 移动端统一顶栏配置 ==========
  const currentSession = sessions.find(s => s.id === currentSessionId);

  // 🔧 默认展开当前会话所在的分组
  useEffect(() => {
    if (!currentSession) return;
    const groupId = currentSession.groupId || 'ungrouped';
    expandGroup(groupId);
  }, [currentSessionId, currentSession?.groupId, expandGroup]);

  // 空态判断：没有会话或当前会话没有消息，即为空态新对话
  // 有消息则可以新建对话，避免创建多个空对话
  const isEmptyNewChat = !currentSessionId || !currentSessionHasMessages;

  // 刷新状态（用于会话浏览模式）
  const [browserRefreshing, setBrowserRefreshing] = useState(false);
  const handleBrowserRefresh = useCallback(async () => {
    if (browserRefreshing) return;
    setBrowserRefreshing(true);
    try {
      await loadSessions();
    } finally {
      setTimeout(() => setBrowserRefreshing(false), 500);
    }
  }, [browserRefreshing, loadSessions]);

  // 根据视图模式配置顶栏
  const headerTitle = useMemo(() => {
    if (viewMode === 'browser') {
      return `${t('browser.title')} (${sessions.length})`;
    }
    return currentSession?.title || t('page.newChat');
  }, [viewMode, currentSession?.title, t, sessions.length]);

  const headerRightActions = useMemo(() => {
    if (viewMode === 'browser') {
      return (
        <div className="flex items-center gap-1">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={handleBrowserRefresh}
            disabled={browserRefreshing}
            aria-label={t('browser.refresh')}
            title={t('browser.refresh')}
          >
            <RefreshCw className={cn('w-5 h-5', browserRefreshing && 'animate-spin')} />
          </NotionButton>
          <NotionButton
            variant="primary"
            size="icon"
            iconOnly
            onClick={() => createSession()}
            disabled={isLoading}
            aria-label={t('page.newSession')}
            title={t('page.newSession')}
          >
            <Plus className="w-5 h-5" />
          </NotionButton>
        </div>
      );
    }
    return (
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={() => createSession()}
        disabled={isLoading || isEmptyNewChat}
        aria-label={t('page.newSession')}
        title={t('page.newSession')}
      >
        <Plus className="w-5 h-5" />
      </NotionButton>
    );
  }, [viewMode, browserRefreshing, handleBrowserRefresh, createSession, isLoading, isEmptyNewChat, t]);

  // 📱 移动端资源库面包屑导航回调
  const handleFinderBreadcrumbNavigate = useCallback((index: number) => {
    finderJumpToBreadcrumb(index);
  }, [finderJumpToBreadcrumb]);

  useMobileHeader('chat-v2', mobileResourcePanelOpen ? {
    // 📱 资源库打开时：顶栏显示面包屑导航
    titleNode: (
      <MobileBreadcrumb
        rootTitle={t('learningHub:title')}
        breadcrumbs={finderBreadcrumbs}
        onNavigate={handleFinderBreadcrumbNavigate}
      />
    ),
    showBackArrow: true,
    onMenuClick: () => setMobileResourcePanelOpen(false),
  } : {
    title: headerTitle,
    showMenu: viewMode !== 'browser',
    showBackArrow: viewMode === 'browser',
    onMenuClick: viewMode === 'browser'
      ? () => {
          setViewMode('sidebar');
          setSessionSheetOpen(true);
        }
      : () => setSessionSheetOpen(prev => !prev),
    rightActions: headerRightActions,
  }, [headerTitle, viewMode, headerRightActions, mobileResourcePanelOpen, finderBreadcrumbs, handleFinderBreadcrumbNavigate, t]);

  // P1-23: 软删除会话（移动到回收站）
  // 🔧 P1-005 修复：使用 ref 获取最新状态，避免闭包竞态条件
  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        // P1-23: 使用软删除代替硬删除
        await invoke('chat_v2_soft_delete_session', { sessionId });
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        setTotalSessionCount((prev) => (prev !== null ? prev - 1 : null));
        void loadUngroupedCount();

        // 🔧 P1-28: 如果删除的是 localStorage 中保存的会话，清理它
        try {
          const lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
          if (lastSessionId === sessionId) {
            localStorage.removeItem(LAST_SESSION_KEY);
          }
        } catch (e) {
          console.warn('[ChatV2Page] Failed to clear last session ID:', e);
        }

        // 如果删除的是当前会话，切换到下一个
        // 使用 sessionsRef.current 获取最新状态，避免闭包中使用过时的 sessions
        const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
        if (remaining.length === 0) {
          // 🔧 优化空态体验：删除最后一个会话时，自动创建新的空会话
          try {
            const newSession = await createSessionWithDefaults({
              mode: 'chat',
              title: null,
              metadata: null,
            });
            setSessions([newSession]);
            setTotalSessionCount(1);
            setCurrentSessionId(newSession.id);
            console.log('[ChatV2Page] Auto-created session after deleting last one:', newSession.id);
          } catch (e) {
            console.warn('[ChatV2Page] Failed to auto-create session:', e);
            setCurrentSessionId(null);
          }
        } else {
          setCurrentSessionId((prevId) => {
            if (prevId === sessionId) {
              return remaining[0].id;
            }
            return prevId;
          });
        }
      } catch (error) {
        console.error('[ChatV2Page] Failed to delete session:', getErrorMessage(error));
      }
    },
    [loadUngroupedCount] // 不再依赖 currentSessionId 和 sessions，使用 ref 和函数式更新
  );

  // 🔧 P1-29: 加载已删除会话（回收站）
  const loadDeletedSessions = useCallback(async () => {
    setIsLoadingTrash(true);
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'deleted',
        limit: 100,
        offset: 0,
      });
      setDeletedSessions(result);
    } catch (error) {
      console.error('[ChatV2Page] Failed to load deleted sessions:', getErrorMessage(error));
      showGlobalNotification('error', t('page.loadTrashFailed'));
    } finally {
      setIsLoadingTrash(false);
    }
  }, [t]);

  // 🔧 P1-29: 恢复已删除会话
  const restoreSession = useCallback(async (sessionId: string) => {
    try {
      const restoredSession = await invoke<ChatSession>('chat_v2_restore_session', { sessionId });
      // 从回收站移除
      setDeletedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      // 添加到活跃会话列表
      setSessions((prev) => [restoredSession, ...prev]);
      setTotalSessionCount((prev) => (prev !== null ? prev + 1 : null));
      void loadUngroupedCount();
      // 切换到恢复的会话
      setCurrentSessionId(restoredSession.id);
      // 退出回收站视图
      setShowTrash(false);
      console.log('[ChatV2Page] Restored session:', sessionId);
    } catch (error) {
      console.error('[ChatV2Page] Failed to restore session:', getErrorMessage(error));
      showGlobalNotification('error', t('page.restoreSessionFailed'));
    }
  }, [loadUngroupedCount, setCurrentSessionId, t]);

  // 🔧 P1-29: 永久删除会话
  const permanentlyDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_delete_session', { sessionId });
      setDeletedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      console.log('[ChatV2Page] Permanently deleted session:', sessionId);
    } catch (error) {
      console.error('[ChatV2Page] Failed to permanently delete session:', getErrorMessage(error));
      showGlobalNotification('error', t('page.deleteSessionFailed'));
    }
  }, [t]);

  // 🔧 P1-3: 清空回收站（使用后端批量删除，解决超过 100 条无法全部清空的问题）
  const emptyTrash = useCallback(async () => {
    if (deletedSessions.length === 0) return;
    try {
      const count = await invoke<number>('chat_v2_empty_deleted_sessions');
      setDeletedSessions([]);
      console.log('[ChatV2Page] Emptied trash, deleted', count, 'sessions');
    } catch (error) {
      console.error('[ChatV2Page] Failed to empty trash:', getErrorMessage(error));
      showGlobalNotification('error', t('page.emptyTrashFailed'));
    }
  }, [deletedSessions, t]);

  // 🔧 P1-29: 打开/关闭回收站
  const toggleTrash = useCallback(() => {
    setShowChatControl(false); // 关闭对话控制
    setShowTrash((prev) => {
      const newValue = !prev;
      if (newValue) {
        // 打开回收站时加载已删除会话
        loadDeletedSessions();
      }
      return newValue;
    });
  }, [loadDeletedSessions]);

  // 🆕 打开/关闭对话控制侧栏
  const toggleChatControl = useCallback(() => {
    setShowTrash(false); // 关闭回收站
    setShowChatControl((prev) => !prev);
  }, []);

  // 🆕 2026-01-20: 点击 Worker Agent 查看输出 - 切换到对应会话
  const handleViewAgentSession = useCallback((agentSessionId: string) => {
    console.log('[ChatV2Page] Switching to agent session:', agentSessionId);
    setCurrentSessionId(agentSessionId);
  }, [setCurrentSessionId]);

  // 初始化加载会话列表
  useEffect(() => {
    pageLifecycleTracker.log('chat-v2', 'ChatV2Page', 'data_load', 'loadSessions');
    const start = Date.now();
    loadSessions().then(() => {
      pageLifecycleTracker.log('chat-v2', 'ChatV2Page', 'data_ready', undefined, { duration: Date.now() - start });
    });
  }, [loadSessions]);

  // 🔧 保底：初始加载完成后如果仍然没有会话（如 loadSessions 中自动创建失败），再次尝试创建
  const hasTriedAutoCreate = useRef(false);
  useEffect(() => {
    if (!isInitialLoading && !currentSessionId && !hasTriedAutoCreate.current) {
      hasTriedAutoCreate.current = true;
      console.log('[ChatV2Page] No session after initial load, auto-creating...');
      createSession();
    }
  }, [isInitialLoading, currentSessionId, createSession]);

  // ★ 调试插件：允许程序化切换会话（附件流水线测试插件使用）
  useEffect(() => {
    const handler = (e: Event) => {
      const sid = (e as CustomEvent)?.detail?.sessionId;
      if (sid && typeof sid === 'string') {
        console.log('[ChatV2Page] PIPELINE_TEST_SWITCH_SESSION:', sid);
        setCurrentSessionId(sid);
      }
    };
    window.addEventListener('PIPELINE_TEST_SWITCH_SESSION', handler);
    return () => window.removeEventListener('PIPELINE_TEST_SWITCH_SESSION', handler);
  }, [setCurrentSessionId]);

  // ★ 注册 OpenResourceHandler，让 openResource() 可以在 Chat V2 中工作
  useEffect(() => {
    const handler = {
      openInPanel: (path: string, node: DstuNode, _mode: 'view' | 'edit') => {
        console.log('[ChatV2Page] OpenResourceHandler.openInPanel:', path, node);
        const resourceItem = mapDstuNodeToLearningHubItem(node);
        if (!resourceItem) {
          console.warn('[ChatV2Page] Unsupported openResource node type:', node.type, node);
          showGlobalNotification('warning', t('page.resourceUnsupported'));
          return;
        }
        // 打开 Learning Hub 侧边栏（如果还没打开）
        if (!canvasSidebarOpen) {
          toggleCanvasSidebar();
        }
        // 设置待打开的资源
        setPendingOpenResource(resourceItem);
      },
      openInPage: (path: string, node: DstuNode, mode: 'view' | 'edit') => {
        handler.openInPanel(path, node, mode);
      },
      openInFullscreen: (path: string, node: DstuNode, mode: 'view' | 'edit') => {
        handler.openInPanel(path, node, mode);
      },
      openInModal: (path: string, node: DstuNode, mode: 'view' | 'edit') => {
        handler.openInPanel(path, node, mode);
      },
    };

    // 🔧 P0-28 修复：使用命名空间注册，避免覆盖其他处理器
    const unregister = registerOpenResourceHandler(handler, 'chat-v2');
    return unregister;
  }, [canvasSidebarOpen, t, toggleCanvasSidebar]);

  // ★ 当 Learning Hub 侧边栏打开后，处理待打开的资源
  // 直接设置 openApp 状态，复用 UnifiedAppPanel 显示资源
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
    if (pendingOpenResource && canvasSidebarOpen) {
      // 侧边栏已打开，直接设置 openApp
      handleOpenApp(pendingOpenResource);
      setPendingOpenResource(null);
    }
  }, [pendingOpenResource, canvasSidebarOpen, handleOpenApp]);

  // ★ 监听附件预览事件，在右侧面板打开附件
  // 使用独立的附件预览状态，不依赖于 NotesContext
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  
  const handleAttachmentPreview = useCallback((event: Event) => {
    const customEvent = event as CustomEvent<{
      id: string;
      type: string;
      title: string;
    }>;

    const { id, type, title } = customEvent.detail;
    console.log('[ChatV2Page] CHAT_OPEN_ATTACHMENT_PREVIEW received:', customEvent.detail);

    setOpenApp({
      type: type as ResourceType,
      id,
      title,
    });

    if (isSmallScreen) {
      // 📱 移动端：向右滑动打开附件预览（MobileSlidingLayout rightPanel）
      setMobileResourcePanelOpen(true);
    } else {
      setAttachmentPreviewOpen(true);
    }
  }, [isSmallScreen]);

  useEventRegistry([
    {
      target: 'window',
      type: 'CHAT_OPEN_ATTACHMENT_PREVIEW',
      listener: handleAttachmentPreview as EventListener,
    },
  ], [handleAttachmentPreview]);

  // 🆕 监听上下文引用预览事件，处理跳转到 Learning Hub
  // ★ 2026-02-09 修复：使用各资源类型的专用导航事件，避免 openResource 处理器竞态
  const handleContextRefPreview = useCallback(async (event: Event) => {
    const customEvent = event as CustomEvent<{
      resourceId: string;
      hash: string;
      typeId: string;
      path?: string;
    }>;

    const { resourceId, typeId } = customEvent.detail;
    console.log('[ChatV2Page] context-ref:preview event received:', customEvent.detail);

    try {
      // 1. 获取资源的真实 sourceId（resourceId 是 chat_v2 的 res_xxx，不是 VFS sourceId）
      const resource = await invoke<{
        id: string;
        sourceId?: string;
        sourceTable?: string;
        resourceType: string;
        metadata?: { title?: string; name?: string };
      } | null>('vfs_get_resource', { resourceId });

      if (!resource) {
        console.warn('[ChatV2Page] Resource not found:', resourceId);
        return;
      }

      const sourceId = resource.sourceId;
      if (!sourceId) {
        console.warn('[ChatV2Page] Resource has no sourceId:', resourceId);
        return;
      }

      const displayName = resource.metadata?.title || resource.metadata?.name || '';
      console.log('[ChatV2Page] Navigating to resource:', { typeId, sourceId, displayName });

      // 2. 统一在右侧面板打开预览（不再跳转离开聊天页面）
      window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
        detail: {
          id: sourceId,
          type: typeId,
          title: displayName || sourceId,
        },
      }));
      console.log('[ChatV2Page] context-ref:preview -> opened in right panel:', { typeId, sourceId });
    } catch (error) {
      console.error('[ChatV2Page] Failed to handle context-ref:preview:', getErrorMessage(error));
    }
  }, []);

  useEventRegistry([
    {
      target: 'document',
      type: 'context-ref:preview',
      listener: handleContextRefPreview as EventListener,
    },
  ], [handleContextRefPreview]);

  // 🆕 监听 PDF 页面引用事件，打开 PDF 并跳转到指定页
  useEffect(() => {
    const isPdfByMeta = (name?: string, mimeType?: string) => {
      const safeName = (name || '').toLowerCase();
      const safeMime = (mimeType || '').toLowerCase();
      return safeMime.includes('pdf') || safeName.endsWith('.pdf');
    };

    const isKnownResourceId = (id?: string) => {
      if (!id) return false;
      return Object.keys(RESOURCE_ID_PREFIX_MAP).some((prefix) => id.startsWith(prefix));
    };

    const debugClick = (event: MouseEvent) => {
      const rawTarget = event.target as EventTarget | null;
      const elementTarget = (rawTarget instanceof Element ? rawTarget : null);
      const target = elementTarget?.closest?.('[data-pdf-ref="true"]') as HTMLElement | null;
      if (!target) return;
      console.log('[ChatV2Page] document click pdf-ref:', {
        sourceId: target.dataset.pdfSource,
        pageNumber: target.dataset.pdfPage,
      });
    };
    document.addEventListener('click', debugClick, true);
    const handlePdfRefOpen = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        sourceId?: string;
        pageNumber: number;
      }>;

      const { sourceId: rawSourceId, pageNumber } = customEvent.detail || {};
      console.log('[ChatV2Page] pdf-ref:open received:', customEvent.detail);
      if (!Number.isFinite(pageNumber) || pageNumber <= 0) return;

      const resolvePdfSourceId = async (requestedSourceId?: string): Promise<string | null> => {
        // 若已是可识别的资源 ID，直接使用（无需额外解析）
        if (requestedSourceId && isKnownResourceId(requestedSourceId)) {
          return requestedSourceId;
        }

        const sessionId = sessionManager.getCurrentSessionId();
        if (!sessionId) {
          console.log('[ChatV2Page] resolvePdfSourceId: no sessionId');
          return null;
        }
        const store = sessionManager.get(sessionId);
        if (!store) {
          console.log('[ChatV2Page] resolvePdfSourceId: no store');
          return null;
        }
        const state = store.getState();

        const candidates: Array<{ sourceId: string; score: number; origin: string }> = [];
        const pushCandidate = (sourceId?: string, score = 0, origin = '') => {
          if (!sourceId) return;
          candidates.push({ sourceId, score, origin });
        };

        // 遍历所有消息，查找 PDF 附件
        for (const messageId of state.messageOrder) {
          const message = state.messageMap.get(messageId);
          if (!message) continue;

          // 1. 先检查 message.attachments（用户上传的附件）
          const attachments = message.attachments || [];
          for (const att of attachments) {
            const name = att.name || '';
            const mimeType = att.mimeType || '';
            const isPdf = isPdfByMeta(name, mimeType);
            if (!isPdf) continue;

            if (requestedSourceId && att.sourceId === requestedSourceId) {
              console.log('[ChatV2Page] resolvePdfSourceId: matched attachment sourceId', att.sourceId);
              return att.sourceId;
            }
            pushCandidate(att.sourceId, 20, 'attachments');
          }

          // 2. 检查 contextSnapshot.userRefs
          const contextSnapshot = message._meta?.contextSnapshot;
          const userRefs = contextSnapshot?.userRefs || [];
          const fileRefs = userRefs.filter((r: any) => r.typeId === 'file');

          for (const ref of fileRefs) {
            // 若引用 id 与请求 id 一致（例如 [PDF@res_xxx]），优先解析
            if (requestedSourceId && ref.resourceId === requestedSourceId) {
              try {
                const resource = await invoke<{
                  id: string;
                  sourceId?: string;
                  resourceType: string;
                  metadata?: { mimeType?: string; name?: string };
                } | null>('vfs_get_resource', { resourceId: ref.resourceId });
                if (resource && isPdfByMeta(resource.metadata?.name, resource.metadata?.mimeType)) {
                  console.log('[ChatV2Page] resolvePdfSourceId: matched userRef resourceId -> sourceId', resource.sourceId);
                  pushCandidate(resource.sourceId, 90, 'userRefs:resourceId');
                }
              } catch {
                // ignore
              }
            }

            try {
              const resource = await invoke<{
                id: string;
                sourceId?: string;
                resourceType: string;
                metadata?: { mimeType?: string; name?: string };
              } | null>('vfs_get_resource', { resourceId: ref.resourceId });
              if (!resource) continue;

              const isPdf = isPdfByMeta(resource.metadata?.name, resource.metadata?.mimeType);
              if (!isPdf) continue;

              if (requestedSourceId && resource.sourceId === requestedSourceId) {
                console.log('[ChatV2Page] resolvePdfSourceId: matched userRef sourceId', resource.sourceId);
                pushCandidate(resource.sourceId, 95, 'userRefs:sourceId');
                continue;
              }

              pushCandidate(resource.sourceId, 10, 'userRefs');
            } catch {
              // ignore
            }
          }
        }

        const sorted = candidates.sort((a, b) => b.score - a.score);
        if (sorted.length > 0) {
          console.log('[ChatV2Page] resolvePdfSourceId: picked candidate', sorted[0]);
          return sorted[0].sourceId;
        }

        console.log('[ChatV2Page] resolvePdfSourceId: no PDF found');
        return null;
      };

      const sourceId = (await resolvePdfSourceId(rawSourceId)) || undefined;
      if (!sourceId) {
        showGlobalNotification(
          'warning',
          t('pdfRef.openFailedTitle'),
          t('pdfRef.openFailedDesc')
        );
        return;
      }

      try {
        const dstuPath = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;
        const isAttachmentLike = sourceId.startsWith('att_') || sourceId.startsWith('file_');

        // 多次派发 focus，兼容面板挂载较慢的情况
        const dispatchFocus = (delayMs: number) => {
          window.setTimeout(() => {
            document.dispatchEvent(new CustomEvent('pdf-ref:focus', {
              detail: {
                sourceId,
                pageNumber,
                path: dstuPath,
              },
            }));
          }, delayMs);
        };

        if (isAttachmentLike) {
          // 走附件预览通道（与“点击附件”一致）
          window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
            detail: {
              id: sourceId,
              type: 'file',
              title: 'PDF',
            },
          }));
          dispatchFocus(0);
          dispatchFocus(250);
          dispatchFocus(800);
          return;
        }

        const navEvent = new CustomEvent('NAVIGATE_TO_VIEW', {
          detail: { view: 'learning-hub', openResource: dstuPath },
        });
        window.dispatchEvent(navEvent);
        console.log('[ChatV2Page] Dispatched NAVIGATE_TO_VIEW to learning-hub (pdf-ref)');
        dispatchFocus(0);
        dispatchFocus(250);
        dispatchFocus(800);
      } catch (error) {
        console.error('[ChatV2Page] Failed to handle pdf-ref:open:', getErrorMessage(error));
      }
    };

    // TODO: migrate to centralized event registry
    document.addEventListener('pdf-ref:open', handlePdfRefOpen);
    return () => {
      document.removeEventListener('click', debugClick, true);
      document.removeEventListener('pdf-ref:open', handlePdfRefOpen);
    };
  }, []);

  // ========== P1-07: 命令面板 CHAT_* 事件监听 ==========
  // 使用 ref 保存 currentSessionId 以便事件处理器可以访问最新值
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // 获取当前会话 store 的辅助函数
  const getCurrentStore = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return null;
    return sessionManager.get(sessionId);
  }, []);

  // 注册命令面板事件监听
  useCommandEvents(
    {
      // 新建会话
      [COMMAND_EVENTS.CHAT_NEW_SESSION]: () => {
        console.log('[ChatV2Page] CHAT_NEW_SESSION triggered');
        createSession();
      },
      // P1-06: 新建分析会话
      [COMMAND_EVENTS.CHAT_NEW_ANALYSIS_SESSION]: () => {
        console.log('[ChatV2Page] CHAT_NEW_ANALYSIS_SESSION triggered');
        createAnalysisSession();
      },
      // 切换侧边栏
      [COMMAND_EVENTS.CHAT_TOGGLE_SIDEBAR]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_SIDEBAR triggered');
        handleSidebarCollapsedChange(!sidebarCollapsed);
      },
      // 切换功能面板（Learning Hub 侧边栏）
      [COMMAND_EVENTS.CHAT_TOGGLE_PANEL]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_PANEL triggered');
        if (isSmallScreen) {
          // 移动端：打开右侧滑屏资源库
          setMobileResourcePanelOpen(prev => !prev);
          // 打开资源库时关闭左侧栏
          setSessionSheetOpen(false);
        } else {
          toggleCanvasSidebar();
        }
      },
      // 停止生成
      [COMMAND_EVENTS.CHAT_STOP_GENERATION]: () => {
        console.log('[ChatV2Page] CHAT_STOP_GENERATION triggered');
        const store = getCurrentStore();
        if (store) {
          const state = store.getState();
          if (state.canAbort()) {
            state.abortStream().catch(console.error);
          }
        }
      },
      // 切换 RAG 模式
      // 🔧 P0 修复：feature key 与 buildSendOptions 读取端对齐（使用短 key）
      [COMMAND_EVENTS.CHAT_TOGGLE_RAG]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_RAG triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('rag');
        }
      },
      // 切换图谱模式（已废弃，保留命令但使用对齐的 key）
      [COMMAND_EVENTS.CHAT_TOGGLE_GRAPH]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_GRAPH triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('graphRag');
        }
      },
      // 切换联网搜索
      [COMMAND_EVENTS.CHAT_TOGGLE_WEB_SEARCH]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_WEB_SEARCH triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('webSearch');
        }
      },
      // 切换 MCP 工具
      [COMMAND_EVENTS.CHAT_TOGGLE_MCP]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_MCP triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('mcp');
        }
      },
      // 切换学习模式
      [COMMAND_EVENTS.CHAT_TOGGLE_LEARN_MODE]: () => {
        console.log('[ChatV2Page] CHAT_TOGGLE_LEARN_MODE triggered');
        const store = getCurrentStore();
        if (store) {
          store.getState().toggleFeature('learnMode');
        }
      },
      // 收藏当前对话
      [COMMAND_EVENTS.CHAT_BOOKMARK_SESSION]: async () => {
        console.log('[ChatV2Page] CHAT_BOOKMARK_SESSION triggered');
        const sessionId = currentSessionIdRef.current;
        if (sessionId) {
          try {
            await invoke('chat_v2_update_session_settings', {
              sessionId,
              settings: { is_favorite: true },
            });
            // 可选：显示成功提示
          } catch (error) {
            console.error('[ChatV2Page] Failed to bookmark session:', getErrorMessage(error));
          }
        }
      },
    },
    true // 始终启用监听
  );

  // 监听外部预填充输入框事件
  useEffect(() => {
    const handleSetInput = (evt: Event) => {
      const event = evt as CustomEvent<{ content: string; autoSend?: boolean }>;
      const { content } = event?.detail ?? {};
      if (!content) return;

      const store = getCurrentStore();
      if (store) {
        store.getState().setInputValue(content);
        console.log('[ChatV2Page] Input bar content pre-filled');
      }
    };

    // TODO: migrate to centralized event registry
    window.addEventListener('CHAT_V2_SET_INPUT', handleSetInput as EventListener);
    return () => {
      window.removeEventListener('CHAT_V2_SET_INPUT', handleSetInput as EventListener);
    };
  }, [getCurrentStore]);

  // 开始编辑会话名称
  const startEditSession = useCallback((session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingSessionId(null);
    setRenameError(null);
    setEditingSessionId(session.id);
    setEditingTitle(session.title?.trim() ?? '');
    resetDeleteConfirmation();
  }, [resetDeleteConfirmation]);

  // 保存会话名称
  const saveSessionTitle = useCallback(async (sessionId: string) => {
    const trimmedTitle = editingTitle.trim();
    if (!trimmedTitle) {
      setRenameError(t('page.renameEmptyError'));
      return;
    }

    const currentTitle = sessionsRef.current
      .find((s) => s.id === sessionId)
      ?.title?.trim();

    if (currentTitle === trimmedTitle) {
      setRenameError(null);
      setEditingSessionId(null);
      return;
    }

    try {
      setRenameError(null);
      setRenamingSessionId(sessionId);
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: trimmedTitle },
      });
      
      // 更新本地状态
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, title: trimmedTitle } : s
        )
      );
      setEditingSessionId(null);
      setEditingTitle('');
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('[ChatV2Page] Failed to rename session:', message);
      setRenameError(t('page.renameFailed'));
    } finally {
      setRenamingSessionId(null);
    }
  }, [editingTitle, t]);

  // 取消编辑
  const cancelEditSession = useCallback(() => {
    setRenamingSessionId(null);
    setRenameError(null);
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  // ===== 分组管理 =====
  const openCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setGroupEditorOpen(true);
    setShowTrash(false);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, []);

  const openEditGroup = useCallback((group: SessionGroup) => {
    setEditingGroup(group);
    setGroupEditorOpen(true);
    setShowTrash(false);
    setShowChatControl(false);
    setViewMode('sidebar');
    setSessionSheetOpen(false);
  }, []);

  const closeGroupEditor = useCallback(() => {
    setGroupEditorOpen(false);
    setEditingGroup(null);
  }, []);

  const handleSubmitGroup = useCallback(async (payload: CreateGroupRequest | UpdateGroupRequest) => {
    try {
      if (editingGroup) {
        await updateGroup(editingGroup.id, payload as UpdateGroupRequest);
      } else {
        await createGroup(payload as CreateGroupRequest);
      }
      closeGroupEditor();
    } catch (error) {
      console.error('[ChatV2Page] Failed to save group:', getErrorMessage(error));
    }
  }, [closeGroupEditor, createGroup, editingGroup, updateGroup]);

  const applySessionGroupUpdate = useCallback((sessionId: string, groupId: string | null) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, groupId: groupId ?? undefined } : s))
    );
    const store = sessionManager.get(sessionId);
    if (store) {
      // Update groupId in store
      const storeUpdate: Record<string, unknown> = { groupId: groupId ?? null };

      // P0-3 fix: Update groupSystemPromptSnapshot in metadata when moving between groups
      const currentMetadata = store.getState().sessionMetadata;
      if (groupId) {
        const group = groupCache.get(groupId);
        if (group?.systemPrompt) {
          storeUpdate.sessionMetadata = {
            ...(currentMetadata ?? {}),
            groupSystemPromptSnapshot: group.systemPrompt,
          };
        } else {
          // New group has no systemPrompt — remove stale snapshot
          if (currentMetadata?.groupSystemPromptSnapshot) {
            const { groupSystemPromptSnapshot: _, ...rest } = currentMetadata;
            storeUpdate.sessionMetadata = Object.keys(rest).length > 0 ? rest : null;
          }
        }
      } else {
        // Moved to ungrouped — remove stale snapshot
        if (currentMetadata?.groupSystemPromptSnapshot) {
          const { groupSystemPromptSnapshot: _, ...rest } = currentMetadata;
          storeUpdate.sessionMetadata = Object.keys(rest).length > 0 ? rest : null;
        }
      }

      store.setState(storeUpdate);
    }
  }, []);

  const removeGroupFromSessions = useCallback((groupId: string) => {
    // P1 fix: Move side-effects out of setSessions updater
    const affectedSessionIds: string[] = [];
    setSessions((prev) => {
      prev.forEach((s) => {
        if (s.groupId === groupId) {
          affectedSessionIds.push(s.id);
        }
      });
      return prev.map((s) => (s.groupId === groupId ? { ...s, groupId: undefined } : s));
    });
    // Apply store updates outside of setState updater
    for (const sid of affectedSessionIds) {
      const store = sessionManager.get(sid);
      if (store) {
        const meta = store.getState().sessionMetadata;
        const storeUpdate: Record<string, unknown> = { groupId: null };
        if (meta?.groupSystemPromptSnapshot) {
          const { groupSystemPromptSnapshot: _, ...rest } = meta;
          storeUpdate.sessionMetadata = Object.keys(rest).length > 0 ? rest : null;
        }
        store.setState(storeUpdate);
      }
    }
  }, []);

  const confirmDeleteGroup = useCallback(async () => {
    if (!pendingDeleteGroup) return;
    try {
      await deleteGroup(pendingDeleteGroup.id);
      removeGroupFromSessions(pendingDeleteGroup.id);
      void loadUngroupedCount();
      setPendingDeleteGroup(null);
    } catch (error) {
      console.error('[ChatV2Page] Failed to delete group:', getErrorMessage(error));
    }
  }, [deleteGroup, loadUngroupedCount, pendingDeleteGroup, removeGroupFromSessions]);

  const moveSessionToGroup = useCallback(async (sessionId: string, groupId?: string) => {
    try {
      await invoke('chat_v2_move_session_to_group', {
        sessionId,
        groupId: groupId ?? null,
      });
      applySessionGroupUpdate(sessionId, groupId ?? null);
      void loadUngroupedCount();
    } catch (error) {
      console.error('[ChatV2Page] Failed to move session to group:', getErrorMessage(error));
    }
  }, [applySessionGroupUpdate, loadUngroupedCount]);

  const handleDragEnd = useCallback((result: DropResult) => {
    const { destination, source, draggableId, type } = result;
    if (!destination) return;

    if (type === 'GROUP') {
      if (groupDragDisabled) return;
      if (destination.index === source.index) return;
      const reordered = [...visibleGroups];
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      reorderGroups(reordered.map((group) => group.id));
      return;
    }

    if (type === 'SESSION') {
      if (destination.droppableId === source.droppableId) return;
      const sessionId = draggableId.replace(/^session:/, '');
      if (destination.droppableId === 'session-ungrouped') {
        moveSessionToGroup(sessionId, undefined);
        return;
      }
      if (destination.droppableId.startsWith('session-group:')) {
        const destGroupId = destination.droppableId.replace('session-group:', '');
        moveSessionToGroup(sessionId, destGroupId);
      }
    }
  }, [groupDragDisabled, moveSessionToGroup, reorderGroups, visibleGroups]);

  // 格式化时间
  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('common.justNow');
    if (diffMins < 60) return t('common.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('common.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('common.daysAgo', { count: diffDays });
    return date.toLocaleDateString();
  };

  type SessionDragState = {
    provided: DraggableProvided;
    snapshot: DraggableStateSnapshot;
  };

  const resolveDragStyle = (
    style: React.CSSProperties | undefined,
    isDragging: boolean
  ) => (isDragging && style ? { ...style, left: 'auto', top: 'auto' } : style);

  // 渲染单个会话项 - Notion 风格
  const renderSessionItem = (session: ChatSession, drag?: SessionDragState) => {
    const showActionButtons = shouldShowSessionActionButtons({
      isEditing: editingSessionId === session.id,
      isHovered: hoveredSessionId === session.id,
      isSelected: currentSessionId === session.id,
    });

    return (
      <div
      ref={drag?.provided.innerRef}
      {...drag?.provided.draggableProps}
      {...drag?.provided.dragHandleProps}
      style={resolveDragStyle(drag?.provided.draggableProps.style, !!drag?.snapshot.isDragging)}
      onClick={() => {
        if (editingSessionId !== session.id) {
          resetDeleteConfirmation();
          setCurrentSessionId(session.id);
        }
      }}
      onMouseLeave={() => {
        setHoveredSessionId((prev) => (prev === session.id ? null : prev));
        if (pendingDeleteSessionId === session.id) {
          resetDeleteConfirmation();
        }
      }}
      onMouseEnter={() => {
        setHoveredSessionId(session.id);
      }}
      className={cn(
        'group flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded-md cursor-pointer transition-all duration-150',
        drag && 'cursor-grab active:cursor-grabbing',
        currentSessionId === session.id
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50',
        editingSessionId === session.id && 'ring-1 ring-primary/60 bg-accent/60',
        drag?.snapshot.isDragging && 'shadow-lg ring-1 ring-border bg-card z-50'
      )}
    >
      <div className="flex-1 min-w-0 overflow-hidden">
        {editingSessionId === session.id ? (
          <div className="flex flex-col gap-1.5 w-full">
            <input
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renamingSessionId !== session.id) {
                  e.preventDefault();
                  saveSessionTitle(session.id);
                } else if (e.key === 'Escape') {
                  cancelEditSession();
                }
              }}
              autoFocus
              disabled={renamingSessionId === session.id}
              className="w-full bg-transparent text-sm px-2 py-1.5 rounded-md border border-primary/60 bg-card/60 shadow-sm ring-1 ring-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground disabled:opacity-60"
              placeholder={t('page.sessionNamePlaceholder')}
            />
            <div className="flex items-center justify-end gap-1.5">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelEditSession();
                }}
                disabled={renamingSessionId === session.id}
                title={t('page.cancelEdit')}
              >
                <X className="w-3.5 h-3.5" />
                <span>{t('page.cancelEdit')}</span>
              </NotionButton>
              <NotionButton
                variant="primary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  saveSessionTitle(session.id);
                }}
                disabled={renamingSessionId === session.id}
                title={t('page.saveSessionName')}
              >
                {renamingSessionId === session.id ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{t('page.renameSaving')}</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>{t('page.saveSessionName')}</span>
                  </>
                )}
              </NotionButton>
            </div>
            <div className="flex items-center justify-between text-[11px] leading-none">
              <span className="text-muted-foreground/80">
                {t('page.renameShortcutHint')}
              </span>
              {renameError && editingSessionId === session.id && (
                <span className="text-destructive">
                  {renameError}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className={cn(
            'text-sm transition-colors',
            currentSessionId === session.id
              ? 'text-foreground font-bold line-clamp-2 break-words'
              : 'text-foreground/80 font-semibold truncate'
          )}>
            {session.title || t('page.untitled')}
          </div>
        )}
      </div>
      {showActionButtons && (
        <div className="flex gap-1 transition-opacity">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={(e) => startEditSession(session, e)}
            aria-label={t('page.renameSession')}
            title={t('page.renameSession')}
            className="!h-6 !w-6"
          >
            <Edit2 className="w-3 h-3" />
          </NotionButton>
          <Popover>
            <PopoverTrigger asChild>
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={(e) => e.stopPropagation()}
                aria-label={t('page.moveToGroup')}
                title={t('page.moveToGroup')}
                className="!h-6 !w-6"
              >
                <Folder className="w-3 h-3" />
              </NotionButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  moveSessionToGroup(session.id, undefined);
                }}
                className={cn(
                  'w-full justify-between',
                  !session.groupId && 'text-primary'
                )}
              >
                <span>{t('page.ungrouped')}</span>
                {!session.groupId && <Check className="w-3 h-3" />}
              </NotionButton>
              <div className="my-1 border-t border-border/60" />
              {groups.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('page.noGroups')}
                </div>
              ) : (
                groups.map((group) => {
                  const active = session.groupId === group.id;
                  // 判断 icon 是预设图标名称还是 emoji，只有 emoji 才添加到标签前面
                  const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
                  const label = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
                  return (
                    <NotionButton
                      key={group.id}
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        moveSessionToGroup(session.id, group.id);
                      }}
                      className={cn(
                        'w-full justify-between',
                        active && 'text-primary'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {active && <Check className="w-3 h-3" />}
                    </NotionButton>
                  );
                })
              )}
            </PopoverContent>
          </Popover>
          {/* 🔧 全局最后一个会话不允许删除 */}
          {(totalSessionCount ?? sessions.length) > 1 && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              if (pendingDeleteSessionId === session.id) {
                resetDeleteConfirmation();
                deleteSession(session.id);
                return;
              }

              setPendingDeleteSessionId(session.id);
              clearDeleteConfirmTimeout();
              deleteConfirmTimeoutRef.current = setTimeout(() => {
                resetDeleteConfirmation();
              }, 2500);
            }}
            className={cn(
              '!h-6 !w-6 hover:bg-destructive/20 text-muted-foreground hover:text-destructive',
              pendingDeleteSessionId === session.id && 'text-destructive'
            )}
            aria-label={
              pendingDeleteSessionId === session.id
                ? t('common:confirm_delete')
                : t('page.deleteSession')
            }
            title={
              pendingDeleteSessionId === session.id
                ? t('common:confirm_delete')
                : t('page.deleteSession')
            }
          >
            {pendingDeleteSessionId === session.id ? (
              <Trash2 className="w-3 h-3" />
            ) : (
              <X className="w-3 h-3" />
            )}
          </NotionButton>
          )}
        </div>
      )}
    </div>
    );
  };

  // 处理从浏览器视图选择会话
  const handleBrowserSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    setViewMode('sidebar');
  }, []);

  // 处理从浏览器视图重命名会话
  const handleBrowserRenameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: newTitle },
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
    } catch (error) {
      console.error('[ChatV2Page] Failed to rename session:', getErrorMessage(error));
    }
  }, []);

  // 渲染会话侧边栏内容（复用于移动端推拉布局和桌面端面板）
  const renderSessionSidebarContent = () => (
    <>
      {/* 搜索框 */}
      <div className="px-3 py-2 shrink-0">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('page.searchPlaceholder')}
            className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background
                       placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* 浏览所有对话入口 + 回收站入口 */}
      <div className="px-3 py-2 shrink-0 space-y-1">
        <NotionButton
          variant="ghost"
          size="md"
          onClick={() => {
            setShowTrash(false);
            setViewMode(viewMode === 'browser' ? 'sidebar' : 'browser');
            setSessionSheetOpen(false);
          }}
          className="w-full justify-between px-3 py-2.5 bg-muted/50 hover:bg-muted group"
        >
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
            <span className="text-sm font-semibold">{t('browser.allSessions')}</span>
            <span className="text-xs text-muted-foreground">{totalSessionCount ?? sessions.length}</span>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
        </NotionButton>

        {/* 🔧 P1-29: 回收站入口（移动端）- 与桌面端一致，不关闭侧边栏 */}
        <NotionButton
          variant="ghost"
          size="md"
          onClick={toggleTrash}
          className={cn(
            'w-full justify-between px-3 py-2 group',
            showTrash ? 'bg-muted' : 'hover:bg-muted/50'
          )}
        >
          <div className="flex items-center gap-2">
            <Trash2 className={cn(
              'w-4 h-4',
              showTrash ? 'text-destructive' : 'text-muted-foreground group-hover:text-foreground'
            )} />
            <span className="text-sm font-semibold">
              {t('page.trash')}
            </span>
            {deletedSessions.length > 0 && (
              <span className="text-xs text-muted-foreground">{deletedSessions.length}</span>
            )}
          </div>
          <ChevronRight className={cn(
            'w-4 h-4 transition-transform',
            showTrash ? 'rotate-90 text-foreground' : 'text-muted-foreground group-hover:text-foreground'
          )} />
        </NotionButton>

        {/* 🆕 对话控制入口（移动端） */}
        <NotionButton
          variant="ghost"
          size="md"
          onClick={toggleChatControl}
          className={cn(
            'w-full justify-between px-3 py-2 group',
            showChatControl ? 'bg-muted' : 'hover:bg-muted/50'
          )}
        >
          <div className="flex items-center gap-2">
            <SlidersHorizontal className={cn(
              'w-4 h-4',
              showChatControl ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
            )} />
            <span className="text-sm font-semibold">
              {t('common:chat_controls')}
            </span>
          </div>
          <ChevronRight className={cn(
            'w-4 h-4 transition-transform',
            showChatControl ? 'rotate-90 text-foreground' : 'text-muted-foreground group-hover:text-foreground'
          )} />
        </NotionButton>

      </div>

      {/* 会话列表或回收站或对话控制内容 */}
      <CustomScrollArea className="flex-1">
        {showChatControl ? (
          /* 🆕 对话控制视图（移动端） */
          <div className="px-2 py-2 h-full">
            {currentSessionId && sessionManager.get(currentSessionId) ? (
              <AdvancedPanel
                store={sessionManager.get(currentSessionId)!}
                onClose={() => setShowChatControl(false)}
                sidebarMode
              />
            ) : (
              <div className="text-sm text-muted-foreground text-center py-4">
                {t('page.selectSessionFirst')}
              </div>
            )}
          </div>
        ) : showTrash ? (
          /* 🔧 P1-29: 回收站视图（移动端） */
          <>
            {/* 回收站标题和清空按钮 */}
            <div className="px-3 py-2 flex items-center justify-between border-b border-border mb-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t('page.trashTitle')}
              </span>
              {deletedSessions.length > 0 && (
                <NotionButton
                  variant="danger"
                  size="sm"
                  onClick={() => setShowEmptyTrashConfirm(true)}
                  title={t('page.emptyTrash')}
                >
                  {t('page.emptyTrash')}
                </NotionButton>
              )}
            </div>

            {/* 已删除会话列表 */}
            {isLoadingTrash ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : deletedSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <Trash2 className="w-10 h-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {t('page.trashEmpty')}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {deletedSessions.map((session) => (
                  <div
                    key={session.id}
                    className="group flex items-center gap-2.5 px-3 py-2 mx-1 rounded-md hover:bg-accent/50 transition-all duration-150"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground/80 line-clamp-1">
                        {session.title || t('page.untitled')}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* 恢复按钮 */}
                      <NotionButton
                        variant="success"
                        size="icon"
                        iconOnly
                        onClick={() => restoreSession(session.id)}
                        aria-label={t('page.restoreSession')}
                        title={t('page.restoreSession')}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </NotionButton>
                      {/* 永久删除按钮 */}
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        onClick={() => {
                          if (pendingDeleteSessionId === session.id) {
                            resetDeleteConfirmation();
                            permanentlyDeleteSession(session.id);
                          } else {
                            setPendingDeleteSessionId(session.id);
                            clearDeleteConfirmTimeout();
                            deleteConfirmTimeoutRef.current = setTimeout(() => {
                              resetDeleteConfirmation();
                            }, 2500);
                          }
                        }}
                        className={cn(
                          'hover:bg-destructive/20 text-muted-foreground hover:text-destructive',
                          pendingDeleteSessionId === session.id && 'text-destructive bg-destructive/10'
                        )}
                        aria-label={
                          pendingDeleteSessionId === session.id
                            ? t('common:confirm_delete')
                            : t('page.permanentDelete')
                        }
                        title={
                          pendingDeleteSessionId === session.id
                            ? t('common:confirm_delete')
                            : t('page.permanentDelete')
                        }
                      >
                        {pendingDeleteSessionId === session.id ? (
                          <Trash2 className="w-4 h-4" />
                        ) : (
                          <X className="w-4 h-4" />
                        )}
                      </NotionButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (!isInitialLoading && sessions.length === 0 && groups.length === 0) ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <MessageSquare className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground mb-3">
              {t('page.noSessions')}
            </p>
            <NotionButton
              variant="primary"
              size="sm"
              onClick={() => createSession()}
            >
              {t('page.createFirst')}
            </NotionButton>
          </div>
        ) : (
          <div className="py-1 space-y-2">
            {/* 分组区域 */}
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                {t('page.groups')}
              </span>
              <NotionButton
                variant="ghost"
                size="sm"
                iconOnly
                onClick={openCreateGroup}
                title={t('page.createGroup')}
              >
                <Plus className="w-3.5 h-3.5" />
              </NotionButton>
            </div>

            {isGroupsLoading ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('common:loading')}
              </div>
            ) : (
              <DragDropContext onDragEnd={handleDragEnd}>
                <Droppable droppableId="group-list" type="GROUP">
                  {(groupProvided) => (
                    <div
                      ref={groupProvided.innerRef}
                      {...groupProvided.droppableProps}
                      className="space-y-2"
                    >
                      {visibleGroups.map((group, index) => {
                        const groupSessions = sessionsByGroup.get(group.id) || [];
                        const isCollapsed = collapsedMap[group.id] ?? false;
                        // 判断 icon 是预设图标名称还是 emoji
                        const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
                        // 只有 emoji 才添加到标题前面，预设图标不添加
                        const title = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
                        // 预设图标使用对应组件，否则使用默认 Folder
                        const IconComponent = presetIcon?.Icon ?? Folder;
                        return (
                          <Draggable
                            key={`group:${group.id}`}
                            draggableId={`group:${group.id}`}
                            index={index}
                            isDragDisabled={groupDragDisabled}
                          >
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                style={resolveDragStyle(provided.draggableProps.style, snapshot.isDragging)}
                                className={cn(
                                  !groupDragDisabled && 'cursor-grab active:cursor-grabbing',
                                  snapshot.isDragging && 'shadow-lg ring-1 ring-border bg-card/80 rounded-md'
                                )}
                              >
                                <Droppable droppableId={`session-group:${group.id}`} type="SESSION">
                                  {(sessionProvided, sessionSnapshot) => (
                                    <div
                                      ref={sessionProvided.innerRef}
                                      {...sessionProvided.droppableProps}
                                      className={cn(
                                        sessionSnapshot.isDraggingOver && 'bg-accent/30 rounded-md'
                                      )}
                                    >
                              <UnifiedSidebarSection
                                id={group.id}
                                title={title}
                                icon={IconComponent}
                                count={groupSessions.length}
                                open={!isCollapsed}
                                onOpenChange={() => toggleGroupCollapse(group.id)}
                                twoLineLayout
                                dragHandleProps={provided.dragHandleProps ?? undefined}
                                quickAction={
                                  <>
                                    <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); openEditGroup(group); }} aria-label={t('page.editGroup')} title={t('page.editGroup')} className="!h-6 !w-6">
                                      <Settings className="w-3.5 h-3.5" />
                                    </NotionButton>
                                    <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); createSession(group.id); }} aria-label={t('page.newSession')} title={t('page.newSession')} className="!h-6 !w-6">
                                      <Plus className="w-3.5 h-3.5" />
                                    </NotionButton>
                                  </>
                                }
                              >
                                        {groupSessions.length === 0 ? (
                                          <div className="px-3 py-2 text-xs text-muted-foreground">
                                            {t('page.noGroupSessions')}
                                          </div>
                                        ) : (
                                          groupSessions.map((session, sessionIndex) => (
                                            <Draggable
                                              key={`session:${session.id}`}
                                              draggableId={`session:${session.id}`}
                                              index={sessionIndex}
                                            >
                                              {(sessionProvided, sessionSnapshot) =>
                                                renderSessionItem(session, {
                                                  provided: sessionProvided,
                                                  snapshot: sessionSnapshot,
                                                })
                                              }
                                            </Draggable>
                                          ))
                                        )}
                                      </UnifiedSidebarSection>
                                      {sessionProvided.placeholder}
                                    </div>
                                  )}
                                </Droppable>
                              </div>
                            )}
                          </Draggable>
                        );
                      })}
                      {groupProvided.placeholder}
                    </div>
                  )}
                </Droppable>

                {/* 未分组区域 */}
                <Droppable droppableId="session-ungrouped" type="SESSION">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={cn(snapshot.isDraggingOver && 'bg-accent/30 rounded-md')}
                    >
                      <UnifiedSidebarSection
                        id="ungrouped"
                        title={t('page.ungrouped')}
                        icon={Folder}
                        count={ungroupedSessionCount ?? ungroupedSessions.length}
                        open={!(collapsedMap.ungrouped ?? false)}
                        onOpenChange={() => toggleGroupCollapse('ungrouped')}
                        twoLineLayout
                        quickAction={
                          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); createSession(); }} aria-label={t('page.newSession')} title={t('page.newSession')} className="!h-6 !w-6">
                            <Plus className="w-3.5 h-3.5" />
                          </NotionButton>
                        }
                      >
                      {(ungroupedSessionCount ?? ungroupedSessions.length) === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            {t('page.noUngroupedSessions')}
                          </div>
                        ) : (
                          (() => {
                            let ungroupedIndex = 0;
                            return (['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'] as TimeGroup[]).map((timeGroup) => {
                              const groupSessions = groupedSessions.get(timeGroup) || [];
                              if (groupSessions.length === 0) return null;

                              return (
                                <div key={timeGroup} className="mb-1">
                                  <div className="px-3 py-1.5">
                                    <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                      {timeGroupLabels[timeGroup]}
                                    </span>
                                  </div>
                                  <div className="space-y-0.5">
                                    {groupSessions.map((session) => {
                                      const index = ungroupedIndex;
                                      ungroupedIndex += 1;
                                      return (
                                        <Draggable
                                          key={`session:${session.id}`}
                                          draggableId={`session:${session.id}`}
                                          index={index}
                                        >
                                          {(sessionProvided, sessionSnapshot) =>
                                            renderSessionItem(session, {
                                              provided: sessionProvided,
                                              snapshot: sessionSnapshot,
                                            })
                                          }
                                        </Draggable>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            });
                          })()
                        )}
                      </UnifiedSidebarSection>
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            )}

            {/* P1-22: 加载更多按钮（移动端 - 列表内滚动） */}
            {hasMoreSessions && sessions.length > 0 && (
              <div className="px-3 py-2">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={loadMoreSessions}
                  disabled={isLoadingMore}
                  className="w-full"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('page.loading')}
                    </>
                  ) : (
                    t('page.loadMore')
                  )}
                </NotionButton>
              </div>
            )}
          </div>
        )}
      </CustomScrollArea>

    </>
  );

  // 渲染主聊天区域
  const renderMainContent = () => (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* 🚀 会话切换加载指示器（防闪动：只有超过 500ms 才显示） */}
      {showSwitchingIndicator && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/50 backdrop-blur-[1px] transition-opacity duration-150"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-card shadow-lg border">
            <Loader2 className="w-4 h-4 animate-spin text-primary" aria-hidden="true" />
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
          isLoading={isLoading}
          onSelectSession={handleBrowserSelectSession}
          onDeleteSession={deleteSession}
          onCreateSession={() => createSession()}
          onRefresh={loadSessions}
          onRenameSession={handleBrowserRenameSession}
          onBack={() => setViewMode('sidebar')}
          className="h-full flex-1"
        />
      ) : groupEditorOpen ? (
        <GroupEditorPanel
          mode={editingGroup ? 'edit' : 'create'}
          initial={editingGroup}
          onSubmit={handleSubmitGroup}
          onClose={closeGroupEditor}
          onDelete={editingGroup ? () => {
            setPendingDeleteGroup(editingGroup);
            closeGroupEditor();
          } : undefined}
        />
      ) : currentSessionId ? (
        <ChatContainer
          sessionId={deferredSessionId ?? currentSessionId}
          className="flex-1 h-full"
          onViewAgentSession={handleViewAgentSession}
        />
      ) : (
        /* 🔧 防闪烁：加载中或正在自动创建会话，显示空白 */
        <div className="flex-1" />
      )}
    </div>
  );

  return (
    <div className={cn(
      "chat-v2 absolute inset-0 flex overflow-hidden bg-background",
      isSmallScreen && "flex-col"
    )}>
      {/* ===== 移动端布局：DeepSeek 风格推拉式侧边栏 ===== */}
      {isSmallScreen ? (
        <MobileSlidingLayout
          sidebar={
            <div 
              className="h-full flex flex-col bg-background"
              style={{
                // 使用统一常量计算底部间距：安全区域 + 底部导航栏高度
                paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
              }}
            >
              {renderSessionSidebarContent()}
            </div>
          }
          rightPanel={
            <div
              className="h-full flex flex-col bg-background"
              style={{
                paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
              }}
            >
              {openApp ? (
                <div className="h-full flex flex-col">
                  {/* 附件/资源预览标题栏 */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background/95 backdrop-blur-lg shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const AppIcon = getAppIcon(openApp.type);
                        return <AppIcon className="w-4 h-4 text-muted-foreground shrink-0" />;
                      })()}
                      <span className="text-sm font-medium truncate">
                        {openApp.title || t('common:untitled')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenInLearningHub} aria-label="在学习中心打开" title="在学习中心打开" className="!h-7 !w-7">
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </NotionButton>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={() => { handleCloseApp(); setMobileResourcePanelOpen(false); }} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                        <X className="w-4 h-4 text-muted-foreground" />
                      </NotionButton>
                    </div>
                  </div>
                  {/* 应用内容 */}
                  <div className="flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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
                  onOpenApp={handleOpenApp}
                  className="h-full"
                  hideToolbarAndNav
                />
              )}
            </div>
          }
          screenPosition={
            mobileResourcePanelOpen ? 'right' :
            sessionSheetOpen ? 'left' : 'center'
          }
          onScreenPositionChange={(pos: ScreenPosition) => {
            setSessionSheetOpen(pos === 'left');
            setMobileResourcePanelOpen(pos === 'right');
          }}
          rightPanelEnabled={true}
          enableGesture={true}
          edgeWidth={20}
          threshold={0.3}
          className="flex-1"
        >
          {/* 移动端：会话浏览作为主内容区域的一部分，直接切换 */}
          {viewMode === 'browser' ? (
            <SessionBrowser
              sessions={sessionsForBrowser}
              isLoading={isLoading}
              onSelectSession={handleBrowserSelectSession}
              onDeleteSession={deleteSession}
              onCreateSession={() => createSession()}
              onRefresh={loadSessions}
              onRenameSession={handleBrowserRenameSession}
              onBack={() => {
                setViewMode('sidebar');
                setSessionSheetOpen(true); // 退出时打开侧栏，有滑动动画
              }}
              className="h-full"
              embeddedMode={true}
            />
          ) : (
            renderMainContent()
          )}
        </MobileSlidingLayout>
      ) : (
        /* ===== 桌面端布局：传统侧边栏 + 面板 ===== */
        <>
          <UnifiedSidebar
            collapsed={sidebarCollapsed}
            onCollapsedChange={handleSidebarCollapsedChange}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            showMacSafeZone={false}
            displayMode="panel"
            autoResponsive={false}
          >
            <UnifiedSidebarHeader
              title={t('page.sessions')}
              icon={MessageSquare}
              showSearch
              searchPlaceholder={t('page.searchPlaceholder')}
              showCreate
              createTitle={t('page.newSession')}
              onCreateClick={() => createSession()}
              collapseTitle={t('page.collapseSidebar')}
              expandTitle={t('page.expandSidebar')}
            />

            {/* 浏览所有对话入口 */}
            {!sidebarCollapsed && (
              <div className="px-3 py-2 shrink-0 space-y-1">
                <NotionButton
                  variant="ghost"
                  size="md"
                  onClick={() => { setShowTrash(false); setViewMode(viewMode === 'browser' ? 'sidebar' : 'browser'); }}
                  className={cn(
                    'w-full justify-between px-3 py-2.5 group',
                    viewMode === 'browser' ? 'bg-muted' : 'bg-muted/50 hover:bg-muted'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
                    <span className="text-sm font-semibold">{t('browser.allSessions')}</span>
                    <span className="text-xs text-muted-foreground">{totalSessionCount ?? sessions.length}</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
                </NotionButton>

                {/* 🔧 P1-29: 回收站入口 */}
                <NotionButton
                  variant="ghost"
                  size="md"
                  onClick={toggleTrash}
                  className={cn(
                    'w-full justify-between px-3 py-2 group',
                    showTrash ? 'bg-muted' : 'hover:bg-muted/50'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Trash2 className={cn(
                      'w-4 h-4',
                      showTrash ? 'text-destructive' : 'text-muted-foreground group-hover:text-foreground'
                    )} />
                    <span className="text-sm font-semibold">
                      {t('page.trash')}
                    </span>
                    {deletedSessions.length > 0 && (
                      <span className="text-xs text-muted-foreground">{deletedSessions.length}</span>
                    )}
                  </div>
                  <ChevronRight className={cn(
                    'w-4 h-4 transition-transform',
                    showTrash ? 'rotate-90 text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                  )} />
                </NotionButton>

                {/* 🆕 对话控制入口 */}
                <NotionButton
                  variant="ghost"
                  size="md"
                  onClick={toggleChatControl}
                  className={cn(
                    'w-full justify-between px-3 py-2 group',
                    showChatControl ? 'bg-muted' : 'hover:bg-muted/50'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className={cn(
                      'w-4 h-4',
                      showChatControl ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                    )} />
                    <span className="text-sm font-semibold">
                      {t('common:chat_controls')}
                    </span>
                  </div>
                  <ChevronRight className={cn(
                    'w-4 h-4 transition-transform',
                    showChatControl ? 'rotate-90 text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                  )} />
                </NotionButton>

              </div>
            )}

            <UnifiedSidebarContent
              isEmpty={isInitialLoading ? false : showTrash ? deletedSessions.length === 0 : showChatControl ? false : sessions.length === 0}
              emptyIcon={showTrash ? Trash2 : showChatControl ? SlidersHorizontal : MessageSquare}
              emptyTitle={showTrash ? t('page.trashEmpty') : showChatControl ? '' : t('page.noSessions')}
              emptyActionText={showTrash || showChatControl ? undefined : t('page.createFirst')}
              onEmptyAction={showTrash || showChatControl ? undefined : createSession}
            >
              {/* 🆕 对话控制视图 */}
              {showChatControl ? (
                <div className="px-2 py-2 h-full">
                  {/* 对话控制面板内容 - 使用侧栏模式（单列布局，无头部） */}
                  {currentSessionId && sessionManager.get(currentSessionId) ? (
                    <AdvancedPanel
                      store={sessionManager.get(currentSessionId)!}
                      onClose={() => setShowChatControl(false)}
                      sidebarMode
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      {t('page.selectSessionFirst')}
                    </div>
                  )}
                </div>
              ) : showTrash ? (
                <>
                  {/* 回收站标题和清空按钮 */}
                  <div className="px-3 py-2 flex items-center justify-between border-b border-border mb-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      {t('page.trashTitle')}
                    </span>
                    {deletedSessions.length > 0 && (
                      <NotionButton
                        variant="danger"
                        size="sm"
                        onClick={() => setShowEmptyTrashConfirm(true)}
                        title={t('page.emptyTrash')}
                      >
                        {t('page.emptyTrash')}
                      </NotionButton>
                    )}
                  </div>

                  {/* 已删除会话列表 */}
                  {isLoadingTrash ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {deletedSessions.map((session) => (
                        <div
                          key={session.id}
                          onMouseLeave={() => {
                            if (pendingDeleteSessionId === session.id) {
                              resetDeleteConfirmation();
                            }
                          }}
                          className="group flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded-md hover:bg-accent/50 transition-all duration-150"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-foreground/80 line-clamp-1">
                              {session.title || t('page.untitled')}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {/* 恢复按钮 */}
                            <NotionButton variant="success" size="icon" iconOnly onClick={() => restoreSession(session.id)} aria-label={t('page.restoreSession')} title={t('page.restoreSession')} className="!h-6 !w-6">
                              <RefreshCw className="w-3.5 h-3.5" />
                            </NotionButton>
                            {/* 永久删除按钮 - 二次确认 */}
                            <NotionButton
                              variant="ghost"
                              size="icon"
                              iconOnly
                              onClick={(e) => {
                                e.stopPropagation();
                                if (pendingDeleteSessionId === session.id) {
                                  resetDeleteConfirmation();
                                  permanentlyDeleteSession(session.id);
                                  return;
                                }
                                setPendingDeleteSessionId(session.id);
                                clearDeleteConfirmTimeout();
                                deleteConfirmTimeoutRef.current = setTimeout(() => {
                                  resetDeleteConfirmation();
                                }, 2500);
                              }}
                              className={cn(
                                '!h-6 !w-6 hover:bg-destructive/20 text-muted-foreground hover:text-destructive',
                                pendingDeleteSessionId === session.id && 'text-destructive'
                              )}
                              aria-label={
                                pendingDeleteSessionId === session.id
                                  ? t('common:confirm_delete')
                                  : t('page.permanentDelete')
                              }
                              title={
                                pendingDeleteSessionId === session.id
                                  ? t('common:confirm_delete')
                                  : t('page.permanentDelete')
                              }
                            >
                              {pendingDeleteSessionId === session.id ? (
                                <Trash2 className="w-3.5 h-3.5" />
                              ) : (
                                <X className="w-3.5 h-3.5" />
                              )}
                            </NotionButton>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="py-1 space-y-2">
                    {/* 分组区域 */}
                    <div className="flex items-center justify-between px-3 py-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                        {t('page.groups')}
                      </span>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        iconOnly
                        onClick={openCreateGroup}
                        title={t('page.createGroup')}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </NotionButton>
                    </div>

                    {isGroupsLoading ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        {t('common:loading')}
                      </div>
                    ) : (
                      <DragDropContext onDragEnd={handleDragEnd}>
                        <Droppable droppableId="group-list" type="GROUP">
                          {(groupProvided) => (
                            <div
                              ref={groupProvided.innerRef}
                              {...groupProvided.droppableProps}
                              className="space-y-2"
                            >
                              {visibleGroups.map((group, index) => {
                                const groupSessions = sessionsByGroup.get(group.id) || [];
                                const isCollapsed = collapsedMap[group.id] ?? false;
                                // 判断 icon 是预设图标名称还是 emoji
                                const presetIcon = group.icon ? PRESET_ICONS.find(p => p.name === group.icon) : null;
                                // 只有 emoji 才添加到标题前面，预设图标不添加
                                const title = (group.icon && !presetIcon) ? `${group.icon} ${group.name}` : group.name;
                                // 预设图标使用对应组件，否则使用默认 Folder
                                const IconComponent = presetIcon?.Icon ?? Folder;
                                return (
                                  <Draggable
                                    key={`group:${group.id}`}
                                    draggableId={`group:${group.id}`}
                                    index={index}
                                    isDragDisabled={groupDragDisabled}
                                  >
                                    {(provided, snapshot) => (
                                      <div
                                        ref={provided.innerRef}
                                        {...provided.draggableProps}
                                        style={resolveDragStyle(provided.draggableProps.style, snapshot.isDragging)}
                                        className={cn(
                                          !groupDragDisabled && 'cursor-grab active:cursor-grabbing',
                                          snapshot.isDragging && 'shadow-lg ring-1 ring-border bg-card/80 rounded-md'
                                        )}
                                      >
                                        <Droppable droppableId={`session-group:${group.id}`} type="SESSION">
                                          {(sessionProvided, sessionSnapshot) => (
                                            <div
                                              ref={sessionProvided.innerRef}
                                              {...sessionProvided.droppableProps}
                                              className={cn(
                                                sessionSnapshot.isDraggingOver && 'bg-accent/30 rounded-md'
                                              )}
                                            >
                                              <UnifiedSidebarSection
                                                id={group.id}
                                                title={title}
                                                icon={IconComponent}
                                                count={groupSessions.length}
                                                open={!isCollapsed}
                                                onOpenChange={() => toggleGroupCollapse(group.id)}
                                                twoLineLayout
                                                dragHandleProps={provided.dragHandleProps ?? undefined}
                                                quickAction={
                                                  <>
                                                    <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); openEditGroup(group); }} aria-label={t('page.editGroup')} title={t('page.editGroup')} className="!h-6 !w-6">
                                                      <Settings className="w-3.5 h-3.5" />
                                                    </NotionButton>
                                                    <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); createSession(group.id); }} aria-label={t('page.newSession')} title={t('page.newSession')} className="!h-6 !w-6">
                                                      <Plus className="w-3.5 h-3.5" />
                                                    </NotionButton>
                                                  </>
                                                }
                                              >
                                                {groupSessions.length === 0 ? (
                                                  <div className="px-3 py-2 text-xs text-muted-foreground">
                                                    {t('page.noGroupSessions')}
                                                  </div>
                                                ) : (
                                                  groupSessions.map((session, sessionIndex) => (
                                                    <Draggable
                                                      key={`session:${session.id}`}
                                                      draggableId={`session:${session.id}`}
                                                      index={sessionIndex}
                                                    >
                                                      {(sessionProvided, sessionSnapshot) =>
                                                        renderSessionItem(session, {
                                                          provided: sessionProvided,
                                                          snapshot: sessionSnapshot,
                                                        })
                                                      }
                                                    </Draggable>
                                                  ))
                                                )}
                                              </UnifiedSidebarSection>
                                              {sessionProvided.placeholder}
                                            </div>
                                          )}
                                        </Droppable>
                                      </div>
                                    )}
                                  </Draggable>
                                );
                              })}
                              {groupProvided.placeholder}
                            </div>
                          )}
                        </Droppable>

                        {/* 未分组区域 */}
                        <Droppable droppableId="session-ungrouped" type="SESSION">
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.droppableProps}
                              className={cn(snapshot.isDraggingOver && 'bg-accent/30 rounded-md')}
                            >
                              <UnifiedSidebarSection
                                id="ungrouped"
                                title={t('page.ungrouped')}
                                icon={Folder}
                                count={ungroupedSessionCount ?? ungroupedSessions.length}
                                open={!(collapsedMap.ungrouped ?? false)}
                                onOpenChange={() => toggleGroupCollapse('ungrouped')}
                                twoLineLayout
                                quickAction={
                                  <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); createSession(); }} aria-label={t('page.newSession')} title={t('page.newSession')} className="!h-6 !w-6">
                                    <Plus className="w-3.5 h-3.5" />
                                  </NotionButton>
                                }
                              >
                                {(ungroupedSessionCount ?? ungroupedSessions.length) === 0 ? (
                                  <div className="px-3 py-2 text-xs text-muted-foreground">
                                    {t('page.noUngroupedSessions')}
                                  </div>
                                ) : (
                                  (() => {
                                    let ungroupedIndex = 0;
                                    return (['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'] as TimeGroup[]).map((timeGroup) => {
                                      const groupSessions = groupedSessions.get(timeGroup) || [];
                                      if (groupSessions.length === 0) return null;

                                      return (
                                        <div key={timeGroup} className="mb-1">
                                          <div className="px-3 py-1.5">
                                            <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                              {timeGroupLabels[timeGroup]}
                                            </span>
                                          </div>
                                          <div className="space-y-0.5">
                                            {groupSessions.map((session) => {
                                              const index = ungroupedIndex;
                                              ungroupedIndex += 1;
                                              return (
                                                <Draggable
                                                  key={`session:${session.id}`}
                                                  draggableId={`session:${session.id}`}
                                                  index={index}
                                                >
                                                  {(sessionProvided, sessionSnapshot) =>
                                                    renderSessionItem(session, {
                                                      provided: sessionProvided,
                                                      snapshot: sessionSnapshot,
                                                    })
                                                  }
                                                </Draggable>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    });
                                  })()
                                )}
                              </UnifiedSidebarSection>
                              {provided.placeholder}
                            </div>
                          )}
                        </Droppable>
                      </DragDropContext>
                    )}
                  </div>

                  {/* P1-22: 加载更多按钮（无限滚动分页） */}
                  {hasMoreSessions && sessions.length > 0 && (
                    <div className="px-3 py-2">
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={loadMoreSessions}
                        disabled={isLoadingMore}
                        className="w-full"
                      >
                        {isLoadingMore ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {t('page.loading')}
                          </>
                        ) : (
                          t('page.loadMore')
                        )}
                      </NotionButton>
                    </div>
                  )}
                </>
              )}
            </UnifiedSidebarContent>


            {/* 折叠状态下的新建按钮 */}
            {sidebarCollapsed && (
              <div className="p-2 flex flex-col items-center gap-1 border-t border-border">
                <NotionButton variant="ghost" size="icon" iconOnly onClick={() => createSession()} disabled={isLoading} aria-label={t('page.newSession')} title={t('page.newSession')}>
                  <Plus className="w-4 h-4" />
                </NotionButton>
              </div>
            )}
          </UnifiedSidebar>
        </>
      )}

      {/* 桌面端：主聊天区域 + Canvas 侧边栏 */}
      {!isSmallScreen && (
        <PanelGroup
          direction="horizontal"
          autoSaveId="chat-v2-canvas-layout"
          className="flex-1 min-w-0 h-full"
        >
          {/* 聊天区域 */}
          <Panel
            defaultSize={(canvasSidebarOpen || attachmentPreviewOpen) ? 60 : 100}
            minSize={30}
            className="h-full"
          >
            {renderMainContent()}
          </Panel>

          {/* Learning Hub 学习资源面板 - 包含侧边栏和应用面板 */}
          {/* ★ 支持两种打开方式：1) canvasSidebarOpen（从侧边栏打开）2) attachmentPreviewOpen（从附件点击） */}
          {(canvasSidebarOpen || attachmentPreviewOpen) && (
          <>
            <PanelResizeHandle
              className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary transition-colors cursor-col-resize"
              title={t('learningHub:toolbar.resize')}
            />
            <Panel
              defaultSize={openApp ? 50 : 30}
              minSize={20}
              maxSize={70}
              className="h-full"
            >
              {/* 内部使用 PanelGroup 实现侧边栏和应用面板的布局 */}
              {/* ★ 如果只有附件预览（attachmentPreviewOpen && !canvasSidebarOpen），直接显示应用面板 */}
              {attachmentPreviewOpen && !canvasSidebarOpen && openApp ? (
                <div className="h-full flex flex-col bg-background">
                  {/* 应用标题栏 */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const AppIcon = getAppIcon(openApp.type);
                        return <AppIcon className="w-4 h-4 text-muted-foreground shrink-0" />;
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
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </NotionButton>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCloseApp} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                        <X className="w-4 h-4 text-muted-foreground" />
                      </NotionButton>
                    </div>
                  </div>

                  {/* 应用内容 - 复用 UnifiedAppPanel */}
                  <div className="flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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
                        <GripVertical className="w-3 h-3 text-muted-foreground/50" />
                      </PanelResizeHandle>
                      <Panel
                        defaultSize={65}
                        minSize={40}
                        className="h-full"
                      >
                        <div className="h-full flex flex-col bg-background border-l border-border">
                          {/* 应用标题栏 */}
                          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
                            <div className="flex items-center gap-2 min-w-0">
                              {(() => {
                                const AppIcon = getAppIcon(openApp.type);
                                return <AppIcon className="w-4 h-4 text-muted-foreground shrink-0" />;
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
                                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                              </NotionButton>
                              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCloseApp} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                                <X className="w-4 h-4 text-muted-foreground" />
                              </NotionButton>
                            </div>
                          </div>

                          {/* 应用内容 - 复用 UnifiedAppPanel */}
                          <div className="flex-1 overflow-hidden">
                            <Suspense
                              fallback={
                                <div className="flex items-center justify-center h-full">
                                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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
              )}
            </Panel>
          </>
        )}
        </PanelGroup>
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
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30 shrink-0">
              <span className="font-medium">{t('learningHub:title')}</span>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setLearningHubSheetOpen(false)} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                <X className="w-4 h-4 text-muted-foreground" />
              </NotionButton>
            </div>
            <div className="flex-1 overflow-hidden">
              {openApp ? (
                <div className="h-full flex flex-col">
                  {/* 应用标题栏 */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const AppIcon = getAppIcon(openApp.type);
                        return <AppIcon className="w-4 h-4 text-muted-foreground shrink-0" />;
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
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </NotionButton>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCloseApp} aria-label={t('common:close')} title={t('common:close')} className="!h-7 !w-7">
                        <X className="w-4 h-4 text-muted-foreground" />
                      </NotionButton>
                    </div>
                  </div>

                  {/* 应用内容 */}
                  <div className="flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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

      {/* 删除分组确认对话框 */}
      <AlertDialog open={!!pendingDeleteGroup} onOpenChange={(open) => !open && setPendingDeleteGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('page.deleteGroupTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('page.deleteGroupDesc', { name: pendingDeleteGroup?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmDeleteGroup();
              }}
            >
              {t('page.deleteGroupConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清空回收站确认对话框 */}
      <AlertDialog open={showEmptyTrashConfirm} onOpenChange={setShowEmptyTrashConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('page.emptyTrashConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('page.emptyTrashConfirmDesc', { count: deletedSessions.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                emptyTrash();
                setShowEmptyTrashConfirm(false);
              }}
            >
              {t('page.emptyTrashConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ChatV2Page;
