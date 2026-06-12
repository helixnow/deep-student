/**
 * Learning Hub 全屏页面
 *
 * 统一的资源访达 + 应用启动器。
 *
 * 设计原则：
 * - Learning Hub 负责管理所有类型资源的文件层级
 * - 点击资源时，打开对应的“原生应用”（笔记编辑器、教材查看器、题目集识别等）
 * - 原生应用只包含编辑/查看功能，不包含自己的文件管理侧边栏
 * - 侧边栏与应用面板之间支持拖拽调整大小
 *
 * 移动端适配：
 * - ★ 三屏滑动布局：左侧应用入口 ← 中间文件视图 → 右侧应用内容
 * - 手势滑动切换三屏，支持轴向锁定防止与竖直滚动冲突
 * - 打开资源时自动切换到右侧应用视图
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelGroup, Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { registerOpenResourceHandler, type OpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode } from '@/dstu/types';
import { createEmpty, dstu, type CreatableResourceType } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { setPendingMemoryLocate } from '@/utils/pendingMemoryLocate';
import { getMemoryConfig } from '@/api/memoryApi';
import { LearningHubSidebar } from './LearningHubSidebar';
import type { ResourceListItem, ResourceType } from './types';
import { cn } from '@/lib/utils';
import { DotsSixVertical, SquaresFour, Gear } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useDesktopShellSidebarPortal } from '@/app/shell/DesktopShellSidebarPortal';
import { useUIStore } from '@/stores/uiStore';
import { useMobileHeader, MobileSlidingLayout, type ScreenPosition } from '@/components/layout';
import { MobileBreadcrumb } from './components/MobileBreadcrumb';
import { useVfsContextInject, useLearningHubEvents } from './hooks';
import type {
  OpenExamEventDetail,
  OpenTranslationEventDetail,
  OpenEssayEventDetail,
  OpenNoteEventDetail,
  OpenResourceEventDetail,
  NavigateToKnowledgeEventDetail,
} from './hooks';
import type { VfsResourceType } from '@/features/chat/context/types';
import { usePageMount } from '@/debug-panel/hooks/usePageLifecycle';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFinderStore } from './stores/finderStore';
import { DstuAppLauncher } from './components/DstuAppLauncher';
import { type OpenTab, type SplitViewState, MAX_TABS, createTab } from './types/tabs';
import { TabBar } from './components/TabBar';
import { TabPanelContainer } from './apps/TabPanelContainer';
import { setActiveTabForExternal } from './activeTabAccessor';
import { COMMAND_EVENTS, useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import { getCreatableFolderId } from './viewGuards';
import { getQuickAccessTypeFromLauncherType, getViewCapabilities } from './learningHubContracts';

/**
 * 根据文件名推断资源类型
 */
const inferResourceTypeFromFileName = (fileName: string): ResourceType => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  // 图片类型
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif'].includes(ext)) {
    return 'image';
  }
  
  // 文档类型（PDF 等作为教材处理）
  if (['pdf'].includes(ext)) {
    return 'textbook';
  }
  
  // 文本/Markdown 作为笔记处理
  if (['md', 'txt', 'markdown'].includes(ext)) {
    return 'note';
  }
  
  // 其他文件类型
  if (['docx', 'xls', 'xlsx', 'xlsb', 'ods', 'pptx'].includes(ext)) {
    return 'file';
  }
  
  // 默认作为文件处理
  return 'file';
};

// ============================================================================
// ★ I10 修复：标签页持久化（localStorage）
// ============================================================================

const TABS_STORAGE_KEY = 'learning-hub-tabs-v1';

interface PersistedTabsState {
  tabs: OpenTab[];
  activeTabId: string | null;
}

let persistedTabsCache: PersistedTabsState | null = null;

/** 读取持久化的标签页状态（模块级缓存，避免 useState 初始化重复解析） */
const loadPersistedTabs = (): PersistedTabsState => {
  if (persistedTabsCache) return persistedTabsCache;
  const fallback: PersistedTabsState = { tabs: [], activeTabId: null };
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) {
      persistedTabsCache = fallback;
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedTabsState>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter(
          (t): t is OpenTab =>
            !!t && typeof t.tabId === 'string' && typeof t.resourceId === 'string' && typeof t.dstuPath === 'string'
        )
      : [];
    const activeTabId =
      typeof parsed.activeTabId === 'string' && tabs.some(t => t.tabId === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[tabs.length - 1]?.tabId ?? null;
    persistedTabsCache = { tabs, activeTabId };
    return persistedTabsCache;
  } catch {
    persistedTabsCache = fallback;
    return fallback;
  }
};

const savePersistedTabs = (tabs: OpenTab[], activeTabId: string | null) => {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {
    // localStorage 不可用时静默忽略
  }
};

/**
 * Learning Hub 全屏页面组件
 *
 * 从应用侧边栏进入时显示的全屏版学习资源管理器。
 * 点击资源时，在右侧打开对应的原生应用面板。
 */
export const LearningHubPage: React.FC = () => {
  const { t } = useTranslation(['learningHub', 'common']);

  // ========== 页面生命周期监控 ==========
  usePageMount('learning-hub', 'LearningHubPage');

  // ========== 响应式布局 ==========
  const { isSmallScreen } = useBreakpoint();
  const desktopShellSidebarTarget = useDesktopShellSidebarPortal('learning-hub');

  // ========== ★ 标签页状态 ==========
  // ★ I10 修复：标签页持久化——重启后恢复上次打开的标签页
  const [tabs, setTabs] = useState<OpenTab[]>(() => loadPersistedTabs().tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => loadPersistedTabs().activeTabId);
  const [splitView, setSplitView] = useState<SplitViewState | null>(null);

  // 派生状态
  const activeTab = tabs.find(t => t.tabId === activeTabId) ?? null;
  const hasOpenApp = tabs.length > 0;

  // ========== 标签页操作函数 ==========
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // ★ I10 修复：标签页变化时持久化
  useEffect(() => {
    savePersistedTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // ★ I10 修复：恢复后后台校验资源有效性，关闭已删除/已移动资源的失效标签页
  const restoredValidationDone = useRef(false);
  useEffect(() => {
    if (restoredValidationDone.current) return;
    restoredValidationDone.current = true;
    const restored = tabsRef.current;
    if (restored.length === 0) return;

    let cancelled = false;
    void (async () => {
      const invalidIds: string[] = [];
      for (const tab of restored) {
        const result = await dstu.get(tab.dstuPath);
        if (!result.ok) {
          invalidIds.push(tab.tabId);
        }
        if (cancelled) return;
      }
      if (invalidIds.length === 0) return;
      setTabs(prev => {
        const next = prev.filter(t => !invalidIds.includes(t.tabId));
        if (next.length === prev.length) return prev;
        setActiveTabId(currentId => {
          if (currentId && next.some(t => t.tabId === currentId)) return currentId;
          return next[next.length - 1]?.tabId ?? null;
        });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, []);

  const openTab = useCallback((app: Omit<OpenTab, 'tabId' | 'openedAt'>) => {
    setTabs(prev => {
      // 1. 已存在同 resourceId 的 tab → 激活并更新 openedAt（LRU）
      const existing = prev.find(t => t.resourceId === app.resourceId);
      if (existing) {
        setActiveTabId(existing.tabId);
        return prev.map(t => t.tabId === existing.tabId ? { ...t, openedAt: Date.now() } : t);
      }
      // 2. 超出上限时 LRU 淘汰最旧的非固定、非活跃 tab
      let next = [...prev];
      if (next.length >= MAX_TABS) {
        const currentActiveId = activeTabIdRef.current;
        const toEvict = [...next]
          .filter(t => !t.isPinned && t.tabId !== currentActiveId)
          .sort((a, b) => a.openedAt - b.openedAt)[0];
        if (toEvict) {
          next = next.filter(t => t.tabId !== toEvict.tabId);
        }
      }
      // 3. 新建 tab
      const newTab = createTab(app);
      setActiveTabId(newTab.tabId);
      return [...next, newTab];
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.tabId === tabId);
      if (idx === -1) return prev;
      const next = prev.filter(t => t.tabId !== tabId);
      // 激活相邻 tab
      setActiveTabId(currentId => {
        if (currentId !== tabId) return currentId;
        const newActive = next[idx] ?? next[idx - 1] ?? null;
        return newActive?.tabId ?? null;
      });
      return next;
    });
  }, []);

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setTabs(prev => prev.map(t => t.tabId === tabId ? { ...t, title } : t));
  }, []);

  // ★ 标签页切换（同时更新 openedAt 以确保 LRU 正确性）
  const switchTab = useCallback((tabId: string) => {
    // 如果点击的是右侧分屏的 tab，则退出分屏，并将其作为主视图（符合用户直觉）
    setSplitView(prev => {
      if (prev?.rightTabId === tabId) return null;
      return prev;
    });
    setActiveTabId(tabId);
    setTabs(prev => prev.map(t => t.tabId === tabId ? { ...t, openedAt: Date.now() } : t));
  }, []);

  // ★ 分屏操作
  const openSplitView = useCallback((tabId: string) => {
    // 将指定 tab 放到右侧分屏
    setSplitView({ rightTabId: tabId });
    // 如果右侧 tab 恰好是当前活跃 tab，则切换左侧到其他 tab
    setActiveTabId(currentId => {
      if (currentId === tabId) {
        // 找一个非当前 tab 作为左侧
        const other = tabs.find(t => t.tabId !== tabId);
        return other?.tabId ?? currentId;
      }
      return currentId;
    });
  }, [tabs]);

  const closeSplitView = useCallback(() => {
    setSplitView(null);
  }, []);

  // ★ 关闭 tab 时自动清理分屏状态
  const closeTabWithSplit = useCallback((tabId: string) => {
    // 如果关闭的是右侧分屏 tab，先退出分屏
    setSplitView(prev => {
      if (prev?.rightTabId === tabId) return null;
      return prev;
    });
    closeTab(tabId);
  }, [closeTab]);

  useEffect(() => {
    const unwatch = dstu.watch('*', (event) => {
      if (event.type !== 'deleted' && event.type !== 'purged') {
        return;
      }

      const affectedPath = event.path || event.oldPath;
      if (!affectedPath) return;

      const affectedResourceId = affectedPath.split('/').filter(Boolean).pop();
      if (!affectedResourceId) return;
      const wasActiveTabAffected = tabsRef.current.some(
        tab => tab.resourceId === affectedResourceId && tab.tabId === activeTabIdRef.current
      );

      setTabs(prev => {
        const next = prev.filter(tab => tab.resourceId !== affectedResourceId);
        if (next.length === prev.length) {
          return prev;
        }

        setActiveTabId(currentId => {
          if (!currentId) return currentId;
          if (next.some(tab => tab.tabId === currentId)) {
            return currentId;
          }
          return next[next.length - 1]?.tabId ?? null;
        });

        setSplitView(prevSplit => {
          if (prevSplit?.rightTabId && next.some(tab => tab.tabId === prevSplit.rightTabId)) {
            return prevSplit;
          }
          return null;
        });

        return next;
      });

      if (wasActiveTabAffected) {
        showGlobalNotification(
          'warning',
          t('learningHub:errors.resourceDeletedOrMoved', '资源已删除或已移动，已关闭失效标签页')
        );
      }
    });

    return () => {
      unwatch();
    };
  }, [t]);

  // ========== 三屏滑动布局状态（移动端） ==========
  // A-8 归一：手势/动画/返回键统一由 MobileSlidingLayout 承载，本页只管理屏幕位置状态
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  const [activeAppType, setActiveAppType] = useState<string>('all');

  // ★ 使用 finderStore 获取实际的文件夹导航状态（而非 NavigationContext）
  // finderStore 是实际控制文件列表显示的状态，NavigationContext 只是同步层
  const finderCurrentPath = useFinderStore(state => state.currentPath);
  const finderGoUp = useFinderStore(state => state.goUp);
  const finderJumpToBreadcrumb = useFinderStore(state => state.jumpToBreadcrumb);
  const finderRefresh = useFinderStore(state => state.refresh);
  const finderQuickAccessNavigate = useFinderStore(state => state.quickAccessNavigate);
  const finderEnterFolder = useFinderStore(state => state.enterFolder);
  const finderBreadcrumbs = finderCurrentPath.breadcrumbs;
  const finderViewCapabilities = getViewCapabilities(finderCurrentPath.viewKind);

  // ★ 记忆系统改造：导航到记忆文件夹（优先 enterFolder，回退 MemoryView）
  const navigateToMemory = useCallback(async () => {
    try {
      const config = await getMemoryConfig();
      if (config.memoryRootFolderId) {
        finderEnterFolder(config.memoryRootFolderId, config.memoryRootFolderTitle || '记忆');
        return;
      }
    } catch (e) {
      console.warn('[LearningHubPage] Failed to get memory config:', e);
    }
    finderQuickAccessNavigate('memory');
  }, [finderEnterFolder, finderQuickAccessNavigate]);

  // ========== VFS 引用模式注入 ==========
  const { injectToChat, canInject, isInjecting } = useVfsContextInject();

  // 函数引用，用于 useMobileHeader
  const handleInjectToChatRef = useRef<() => void>(() => {});
  const handleCloseAppRef = useRef<() => void>(() => {});
  const canInjectCurrentResourceRef = useRef<() => boolean>(() => false);

  /** 自带手势的内容（PDF/思维导图/富文本编辑器）内不启动三屏布局手势 */
  const mobileGestureIgnoreSelector =
    '[data-no-screen-swipe], .react-pdf__Page, .ds-pdf__viewer, .mindmap-canvas, .ProseMirror';

  // ========== 📱 移动端顶栏导航逻辑 ==========
  // 判断是否在子文件夹中（不在根目录）
  const isInSubfolder = finderBreadcrumbs.length > 0;

  // 面包屑导航回调
  const handleBreadcrumbNavigate = useCallback((index: number) => {
    if (index === -1) {
      // 点击根目录：返回到根目录（调用 goBack 直到根目录，或直接跳转）
      finderJumpToBreadcrumb(-1);
    } else {
      // 点击中间层级：跳转到对应层级
      finderJumpToBreadcrumb(index);
    }
  }, [finderJumpToBreadcrumb]);

  // 根目录标题
  const rootTitle = t('learningHub:title');

  // 移动端统一顶栏配置 - 根据屏幕位置、activeTab 和文件夹层级动态变化
  useMobileHeader('learning-hub', {
    title: screenPosition === 'left'
      ? t('learningHub:apps.title')
      : screenPosition === 'right' && activeTab
        ? (activeTab.title || t('common:untitled'))
        : undefined,
    titleNode: screenPosition === 'center' ? (
      <MobileBreadcrumb
        rootTitle={rootTitle}
        breadcrumbs={finderBreadcrumbs}
        onNavigate={handleBreadcrumbNavigate}
      />
    ) : undefined,
    showMenu: true,
    onMenuClick: screenPosition === 'right'
      ? () => setScreenPosition('center')
      : screenPosition === 'center' && isInSubfolder
        ? () => finderGoUp()
        : () => setScreenPosition(prev => prev === 'left' ? 'center' : 'left'),
    showBackArrow: screenPosition === 'right' || (screenPosition === 'center' && isInSubfolder),
    rightActions: screenPosition === 'right' && (activeTab?.type === 'translation' || activeTab?.type === 'essay' || activeTab?.type === 'exam') ? (
      <NotionButton
        variant="ghost"
        size="icon"
        onClick={() => {
          const eventName = activeTab?.type === 'translation' 
            ? 'translation:openSettings' 
            : activeTab?.type === 'essay'
              ? 'essay:openSettings'
              : 'exam:openSettings';
          // ★ 标签页修复：统一使用带 targetResourceId 的事件派发，
          //   确保只影响当前活跃标签页（而非通过全局 store 影响所有实例）
          window.dispatchEvent(new CustomEvent(eventName, {
            detail: { targetResourceId: activeTab?.resourceId },
          }));
        }}
        className="h-9 w-9"
      >
        <Gear size={20} />
      </NotionButton>
    ) : undefined,
  }, [screenPosition, activeTab, t, isInSubfolder, finderBreadcrumbs, finderGoUp, rootTitle, handleBreadcrumbNavigate]);

  // ========== 侧边栏收缩状态 ==========
  const globalLeftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);
  const [localSidebarCollapsed, setLocalSidebarCollapsed] = useState(false);
  const sidebarCollapsed = globalLeftPanelCollapsed || localSidebarCollapsed;

  // ★ 当 Topbar 按钮将 globalLeftPanelCollapsed 切换为 false（展开）时，
  // 同步重置 localSidebarCollapsed，否则 OR 条件会导致侧边栏无法展开
  useEffect(() => {
    if (!globalLeftPanelCollapsed) {
      setLocalSidebarCollapsed(false);
    }
  }, [globalLeftPanelCollapsed]);

  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    setLocalSidebarCollapsed(collapsed);
    if (!collapsed && globalLeftPanelCollapsed) {
      useUIStore.getState().setLeftPanelCollapsed(false);
    }
  }, [globalLeftPanelCollapsed]);

  // 侧边栏面板引用
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);

  // ========== 注册 OpenResourceHandler（供 DSTU openResource 使用） ==========
  useEffect(() => {
    const handler: OpenResourceHandler = {
      openInPanel: (path, node, mode) => {
        openTab({
          type: node.type as ResourceType,
          resourceId: node.id,
          title: node.name,
          dstuPath: path,
        });
        if (isSmallScreen) {
          setScreenPosition('right');
        }
      },
      openInPage: (path, node, mode) => {
        handler.openInPanel(path, node, mode);
      },
      openInFullscreen: (path, node, mode) => {
        handler.openInPanel(path, node, mode);
      },
      openInModal: (path, node, mode) => {
        handler.openInPanel(path, node, mode);
      },
    };

    // 🔧 P0-28 修复：使用命名空间注册，避免覆盖其他处理器
    const unregister = registerOpenResourceHandler(handler, 'learning-hub');
    return unregister;
  }, [isSmallScreen, openTab]);

  // ========== 统一事件监听（使用 useLearningHubEvents hook） ==========
  // 定义事件处理回调
  const handleOpenExamEvent = useCallback((detail: OpenExamEventDetail) => {
    const { sessionId } = detail;
    if (!sessionId) return;

    openTab({
      type: 'exam',
      resourceId: sessionId,
      title: t('learningHub:examSheet'),
      dstuPath: `/${sessionId}`,
    });
    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen, openTab]);

  const handleOpenTranslationEvent = useCallback((detail: OpenTranslationEventDetail) => {
    const { translationId, title } = detail;
    if (!translationId) return;

    openTab({
      type: 'translation',
      resourceId: translationId,
      title: title || t('learningHub:translation'),
      dstuPath: `/${translationId}`,
    });

    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen, openTab]);

  const handleOpenEssayEvent = useCallback((detail: OpenEssayEventDetail) => {
    const { essayId, title } = detail;
    if (!essayId) return;

    openTab({
      type: 'essay',
      resourceId: essayId,
      title: title || t('learningHub:essay'),
      dstuPath: `/${essayId}`,
    });

    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen, openTab]);

  const handleOpenNoteEvent = useCallback((detail: OpenNoteEventDetail) => {
    const { noteId } = detail;
    if (!noteId) return;

    openTab({
      type: 'note',
      resourceId: noteId,
      title: t('learningHub:note'),
      dstuPath: `/${noteId}`,
    });

    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen, openTab]);

  const handleOpenResourceEvent = useCallback(async (detail: OpenResourceEventDetail) => {
    const { dstuPath } = detail;
    if (!dstuPath) return;

    debugLog.log('[LearningHubPage] learningHubOpenResource:', dstuPath);

    try {
      // 动态导入以避免循环依赖
      const { openResource } = await import('@/dstu/openResource');
      const result = await openResource(dstuPath, { mode: 'view', targetView: 'learning-hub' });
      if (!result.ok) {
        debugLog.error('[LearningHubPage] Open resource failed:', result.error.toUserMessage());
        showGlobalNotification('error', t('learningHub:errors.openResourceFailed', '打开资源失败'));
      }
    } catch (err: unknown) {
      debugLog.error('[LearningHubPage] Open resource error:', err);
      showGlobalNotification('error', t('learningHub:errors.openResourceFailed', '打开资源失败'));
    }
  }, [t]);

  const handleNavigateToKnowledgeEvent = useCallback(async (detail: NavigateToKnowledgeEventDetail) => {
    const { preferTab, locator } = detail;

    // 根据 preferTab 导航到对应视图
    if (preferTab === 'memory') {
      // 用户记忆视图
      await navigateToMemory();
      const memoryId = locator?.sourceId || locator?.resourceId;
      if (memoryId) {
        setPendingMemoryLocate(memoryId);
      }
      // 移动端：切换到中间视图显示内容
      if (isSmallScreen) {
        setScreenPosition('center');
      }
    } else if (locator && (locator.sourceId || locator.resourceId || locator.path)) {
      // ★ 2026-01-22: 处理 VFS 资源 ID (res_xxx)，需要查询正确的 DSTU 资源 ID
      let finalDocumentId = locator.sourceId || locator.resourceId || '';

      if (!finalDocumentId && locator.path) {
        finalDocumentId = locator.path.replace(/^\//, '');
      }

      if (finalDocumentId.startsWith('res_')) {
        try {
          // 通过 VFS API 查询资源的 source_id
          const { invoke } = await import('@tauri-apps/api/core');
          const resource = await invoke<{ sourceId?: string } | null>('vfs_get_resource', { resourceId: finalDocumentId });
          if (resource?.sourceId) {
            finalDocumentId = resource.sourceId;
            debugLog.log('[LearningHub] Resolved VFS resource ID:', locator.resourceId, '→', finalDocumentId);
          } else {
            debugLog.warn('[LearningHub] VFS resource has no sourceId:', locator.resourceId);
            showGlobalNotification('error', t('learningHub:errors.resourceNotFound', '找不到对应资源'));
            return;
          }
        } catch (error: unknown) {
          debugLog.error('[LearningHub] Failed to resolve VFS resource:', error);
          showGlobalNotification('error', t('learningHub:errors.resourceNotFound', '找不到对应资源'));
          return;
        }
      }

      if (!finalDocumentId) {
        showGlobalNotification('error', t('learningHub:errors.resourceNotFound', '找不到对应资源'));
        return;
      }

      const verifyResult = await dstu.get(`/${finalDocumentId}`);
      if (!verifyResult.ok || !verifyResult.value) {
        showGlobalNotification('error', t('learningHub:errors.resourceNotFound', '找不到对应资源'));
        return;
      }

      // RAG 文档 - 直接打开文档预览器
      // 优先使用后端返回的 resourceType，回退到从文件名推断
      const appType = (locator.resourceType as ResourceType) || inferResourceTypeFromFileName(locator.title || '');
      openTab({
        type: appType,
        resourceId: finalDocumentId,
        title: locator.title || t('learningHub:document'),
        dstuPath: `/${finalDocumentId}`,
      });
      if (isSmallScreen) {
        setScreenPosition('right');
      }
    } else {
      navigateToMemory();
      if (isSmallScreen) {
        setScreenPosition('center');
      }
    }
  }, [navigateToMemory, isSmallScreen, t, openTab]);

  // ========== 打开应用（从 ResourceListItem） ==========
  const handleOpenApp = useCallback((item: ResourceListItem) => {
    openTab({
      type: item.type,
      resourceId: item.id,
      title: item.title,
      dstuPath: item.path || `/${item.id}`,
    });
    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [isSmallScreen, openTab]);

  // ========== 关闭应用（关闭当前活跃标签页） ==========
  const handleCloseApp = useCallback(() => {
    if (activeTabId) {
      closeTab(activeTabId);
    }
    // 当所有 tab 关闭后展开侧边栏（由 useEffect[tabs.length] 处理）
  }, [activeTabId, closeTab]);

  // ========== 快捷创建并打开资源 ==========
  const handleCreateAndOpen = useCallback(async (type: 'exam' | 'essay' | 'translation' | 'note' | 'mindmap') => {
    if (!finderViewCapabilities.canCreate) {
      showGlobalNotification('warning', t('learningHub:errors.createNotAllowed', '当前视图不支持新建资源'));
      return;
    }

    // 获取当前文件夹 ID
    const currentFolderId = getCreatableFolderId(finderCurrentPath);

    // 调用 createEmpty 创建新资源
    const result = await createEmpty({
      type: type as CreatableResourceType,
      folderId: currentFolderId,
    });

    if (result.ok) {
      const newNode = result.value;
      // 刷新文件列表
      finderRefresh();
      openTab({
        type: type,
        resourceId: newNode.id,
        title: newNode.name,
        dstuPath: newNode.path || `/${newNode.id}`,
      });
      if (isSmallScreen) {
        setScreenPosition('right');
      }
      showGlobalNotification('success', t('learningHub:quickCreate.success'));
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [finderCurrentPath, finderRefresh, finderViewCapabilities.canCreate, isSmallScreen, t, openTab]);

  // ========== 统一注册所有 window 事件监听器 ==========
  useLearningHubEvents({
    onOpenExam: handleOpenExamEvent,
    onOpenTranslation: handleOpenTranslationEvent,
    onOpenEssay: handleOpenEssayEvent,
    onOpenNote: handleOpenNoteEvent,
    onOpenResource: handleOpenResourceEvent,
    onCommandOpenTranslate: () => handleCreateAndOpen('translation'),
    onCommandOpenEssayGrading: () => handleCreateAndOpen('essay'),
    onNavigateToKnowledge: handleNavigateToKnowledgeEvent,
  });

  // ========== 笔记命令兼容层（NotesHome 已下线） ==========
  useCommandEvents(
    {
      [COMMAND_EVENTS.NOTES_CREATE_NEW]: () => {
        void handleCreateAndOpen('note');
      },
      [COMMAND_EVENTS.NOTES_CREATE_FOLDER]: () => {
        window.dispatchEvent(new CustomEvent('learningHub:create-folder'));
      },
      [COMMAND_EVENTS.NOTES_FOCUS_SEARCH]: () => {
        window.dispatchEvent(new CustomEvent('learningHub:focus-search'));
      },
      [COMMAND_EVENTS.NOTES_TOGGLE_SIDEBAR]: () => {
        handleSidebarCollapsedChange(!sidebarCollapsed);
      },
      [COMMAND_EVENTS.NOTES_EXPORT_CURRENT]: () => {
        showGlobalNotification(
          'info',
          t('notes:export.not_available_current', '当前版本暂未接入“导出当前笔记”快捷命令，请使用导出面板。')
        );
      },
      [COMMAND_EVENTS.NOTES_EXPORT_ALL]: () => {
        showGlobalNotification(
          'info',
          t('notes:export.not_available_all', '当前版本暂未接入“导出全部笔记”快捷命令，请使用导出面板。')
        );
      },
    },
    true
  );

  // ========== ★ 同步活跃标签页到全局访问器（供 CommandPalette 等使用） ==========
  useEffect(() => {
    setActiveTabForExternal(activeTab);
    return () => setActiveTabForExternal(null);
  }, [activeTab]);

  // ========== 添加到对话（引用模式） ==========
  const handleInjectToChat = useCallback(async () => {
    if (!activeTab) return;
    
    const typeMapping: Partial<Record<ResourceType, VfsResourceType>> = {
      note: 'note',
      textbook: 'textbook',
      exam: 'exam',
      translation: 'translation',
      essay: 'essay',
      image: 'image',
      file: 'file',
      mindmap: 'mindmap',
    };
    
    const sourceType = typeMapping[activeTab.type];
    if (!sourceType) {
      debugLog.warn('[LearningHubPage] Unsupported resource type for injection:', activeTab.type);
      return;
    }
    
    await injectToChat({
      sourceId: activeTab.resourceId,
      sourceType,
      name: activeTab.title || t('common:untitled'),
      metadata: {
        title: activeTab.title,
      },
    });
  }, [activeTab, injectToChat, t]);

  const canInjectCurrentResource = useCallback(() => {
    if (!activeTab) return false;
    const supportedTypes: ResourceType[] = ['note', 'textbook', 'exam', 'translation', 'essay'];
    return supportedTypes.includes(activeTab.type);
  }, [activeTab]);

  // 更新 ref 引用以便 useMobileHeader 中调用
  handleInjectToChatRef.current = handleInjectToChat;
  handleCloseAppRef.current = handleCloseApp;
  canInjectCurrentResourceRef.current = canInjectCurrentResource;

  // 应用面板引用，用于控制展开/折叠
  const appPanelRef = useRef<ImperativePanelHandle>(null);
  
  // ★ 当标签页打开/全部关闭时控制面板展开/折叠
  useEffect(() => {
    const appPanel = appPanelRef.current;

    if (tabs.length > 0) {
      if (appPanel) {
        appPanel.expand();
        requestAnimationFrame(() => {
          setLocalSidebarCollapsed(true);
        });
      }
    } else {
      if (appPanel) {
        appPanel.collapse();
      }
      setLocalSidebarCollapsed(false);
      // 移动端：所有 tab 关闭后返回中间屏
      if (isSmallScreen) {
        setScreenPosition('center');
      }
    }
  }, [tabs.length, isSmallScreen]);

  // ========== 移动端：三屏滑动布局 ==========
  // A-8 归一：复用 MobileSlidingLayout，统一获得轴向锁定、横向滚动/选区让行（C-9）、
  // Android 返回键收回（A-5）与抽屉底部应用导航
  if (isSmallScreen) {
    return (
      <div
        className="study-shell-page absolute inset-0 flex flex-col overflow-hidden"
        style={{
          bottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
        }}
      >
        <MobileSlidingLayout
          className="flex-1"
          sidebarWidth={0.575}
          screenPosition={screenPosition}
          onScreenPositionChange={setScreenPosition}
          rightPanelEnabled={!!activeTab}
          gestureIgnoreSelector={mobileGestureIgnoreSelector}
          sidebar={
            <div className="study-shell-pane h-full">
              <DstuAppLauncher
                activeType={activeAppType}
                onSelectApp={(type) => {
                  setActiveAppType(type);
                  // ★ 2026-01-19: 调用 finderStore 进行实际导航
                  // 映射 DstuAppLauncher 的类型到 finderStore 的 QuickAccessType
                  finderQuickAccessNavigate(getQuickAccessTypeFromLauncherType(type));
                  setScreenPosition('center');
                }}
                onCreateAndOpen={handleCreateAndOpen}
                onClose={() => setScreenPosition('center')}
                createDisabled={!finderViewCapabilities.canCreate}
                searchDisabled={!finderViewCapabilities.canSearch}
              />
            </div>
          }
          rightPanel={
            <div className="study-shell-panel h-full overflow-hidden">
              {tabs.length > 0 ? (
                <div className="h-full flex flex-col safe-area-bottom">
                  {/* ★ 移动端标签页栏：多 tab 可见、可切换、可关闭（修复"标签黑洞"） */}
                  <TabBar
                    tabs={tabs}
                    setTabs={setTabs}
                    activeTabId={activeTabId}
                    onSwitch={switchTab}
                    onClose={closeTab}
                  />
                  <div className="flex-1 overflow-hidden">
                    <TabPanelContainer
                      tabs={tabs}
                      activeTabId={activeTabId}
                      onClose={closeTab}
                      onTitleChange={updateTabTitle}
                      className="h-full"
                    />
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <div className="text-center p-8">
                    <SquaresFour size={48} className="mx-auto mb-4 opacity-50" />
                    <p className="text-sm">{t('learningHub:selectResource')}</p>
                  </div>
                </div>
              )}
            </div>
          }
        >
          {/* 中间：文件视图 */}
          <div className="study-shell-pane h-full overflow-hidden">
            <LearningHubSidebar
              mode="fullscreen"
              onOpenPreview={handleOpenApp}
              onOpenApp={handleOpenApp}
              className="h-full overflow-hidden"
              isCollapsed={false}
              activeFileId={activeTab?.resourceId}
            />
          </div>
        </MobileSlidingLayout>
      </div>
    );
  }

  // ========== 桌面端：分栏布局 ==========
  return (
    <div className="study-shell-page w-full h-full">
      <PanelGroup
        direction="horizontal"
        className="h-full"
        autoSaveId="learning-hub-layout"
      >
        {/* 左侧：资源访达（文件管理） */}
        <Panel
          ref={sidebarPanelRef}
          defaultSize={25}
          minSize={15}
          id="learning-hub-sidebar"
          order={1}
          className="h-full"
        >
          <div className={cn("study-shell-pane h-full", hasOpenApp && "border-r border-[color:var(--shell-workspace-border)]")}>
            <LearningHubSidebar
              mode="fullscreen"
              onOpenPreview={handleOpenApp}
              onOpenApp={handleOpenApp}
              className="w-full h-full"
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => handleSidebarCollapsedChange(!sidebarCollapsed)}
              activeFileId={activeTab?.resourceId}
              hasOpenApp={hasOpenApp}
              onCloseApp={handleCloseApp}
              quickAccessPortalTarget={desktopShellSidebarTarget}
            />
          </div>
        </Panel>

        {/* 分隔条：仅在右侧面板可见时渲染，避免隐藏态仍占宽度 */}
        {hasOpenApp && (
          <PanelResizeHandle className="w-1.5 transition-colors flex items-center justify-center group bg-border hover:bg-primary/30 active:bg-primary/50">
            <DotsSixVertical size={12} className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
          </PanelResizeHandle>
        )}

        {/* 右侧：原生应用面板（始终渲染，通过 collapsible 控制显示） */}
        <Panel
          ref={appPanelRef}
          defaultSize={75}
          minSize={40}
          collapsible={true}
          collapsedSize={0}
          id="learning-hub-app"
          order={2}
          className="h-full"
        >
          {tabs.length > 0 && (
            <div className="study-shell-panel h-full flex flex-col min-w-0">
              {/* ★ 标签页栏 */}
              <TabBar
                tabs={tabs}
                setTabs={setTabs}
                activeTabId={activeTabId}
                onSwitch={switchTab}
                onClose={closeTabWithSplit}
                splitView={splitView}
                onSplitView={openSplitView}
                onCloseSplitView={closeSplitView}
              />
              <div className="flex-1 overflow-hidden">
                <TabPanelContainer
                  tabs={tabs}
                  activeTabId={activeTabId}
                  splitView={splitView}
                  onClose={closeTabWithSplit}
                  onTitleChange={updateTabTitle}
                  onCloseSplitView={closeSplitView}
                  className="h-full"
                />
              </div>
            </div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
};

export default LearningHubPage;
