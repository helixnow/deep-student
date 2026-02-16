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

import React, { useState, useCallback, useEffect, lazy, Suspense, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelGroup, Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { registerOpenResourceHandler, type OpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import { createEmpty, type CreatableResourceType } from '@/dstu';
import { dstuNodeToResourceListItem } from './types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { setPendingMemoryLocate } from '@/utils/pendingMemoryLocate';
import { LearningHubSidebar } from './LearningHubSidebar';
import type { ResourceListItem, ResourceType } from './types';
import { cn } from '@/lib/utils';
import { FileText, BookOpen, ClipboardList, Loader2, GripVertical, LayoutGrid, Settings } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useUIStore } from '@/stores/uiStore';
import { useMobileHeader } from '@/components/layout';
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
import type { VfsResourceType } from '@/chat-v2/context/types';
import { usePageMount } from '@/debug-panel/hooks/usePageLifecycle';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useLearningHubNavigation } from './LearningHubNavigationContext';
import { useFinderStore } from './stores/finderStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { DstuAppLauncher } from './components/DstuAppLauncher';

// 懒加载统一应用面板
const UnifiedAppPanel = lazy(() => import('./apps/UnifiedAppPanel'));

// ============================================================================
// 三屏滑动布局类型和常量
// ============================================================================

/** 三屏位置枚举 */
type ScreenPosition = 'left' | 'center' | 'right';

/**
 * 当前打开的应用信息
 */
interface OpenApp {
  /** 应用类型 */
  type: ResourceType;
  /** 资源 ID */
  id: string;
  /** 资源标题 */
  title: string;
  /** DSTU 真实路径（用户在 Learning Hub 中看到的文件夹路径，如 /1111/abc.pdf） */
  dstuPath: string;
}

/**
 * 获取应用类型对应的图标
 */
const getAppIcon = (type: ResourceType) => {
  switch (type) {
    case 'note':
      return FileText;
    case 'textbook':
      return BookOpen;
    case 'exam':
      return ClipboardList;
    default:
      return FileText;
  }
};

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

  // ========== 当前打开的应用 ==========
  const [openApp, setOpenApp] = useState<OpenApp | null>(null);

  // ========== 三屏滑动布局状态（移动端） ==========
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  const [activeAppType, setActiveAppType] = useState<string>('all');

  // 拖拽状态
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    currentTranslate: 0,
    axisLocked: null as 'horizontal' | 'vertical' | null,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  // 监听容器宽度
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(container);
    return () => ro.disconnect();
  }, [isSmallScreen]);

  // 计算侧边栏宽度（移动端不再保留左侧露出，避免文件网格横向偏移）
  const sidebarWidth = Math.max(containerWidth, 280);

  // ========== 📱 导航上下文（用于移动端返回按钮） ==========
  const { setHasOpenApp, registerCloseAppCallback } = useLearningHubNavigation();

  // ★ 使用 finderStore 获取实际的文件夹导航状态（而非 NavigationContext）
  // finderStore 是实际控制文件列表显示的状态，NavigationContext 只是同步层
  const finderCurrentPath = useFinderStore(state => state.currentPath);
  const finderGoBack = useFinderStore(state => state.goBack);
  const finderJumpToBreadcrumb = useFinderStore(state => state.jumpToBreadcrumb);
  const finderRefresh = useFinderStore(state => state.refresh);
  const finderQuickAccessNavigate = useFinderStore(state => state.quickAccessNavigate);
  const finderBreadcrumbs = finderCurrentPath.breadcrumbs;

  // ========== VFS 引用模式注入 ==========
  const { injectToChat, canInject, isInjecting } = useVfsContextInject();

  // 函数引用，用于 useMobileHeader
  const handleInjectToChatRef = useRef<() => void>(() => {});
  const handleCloseAppRef = useRef<() => void>(() => {});
  const canInjectCurrentResourceRef = useRef<() => boolean>(() => false);

  // ========== 三屏滑动：计算基础偏移量 ==========
  // 布局：左侧(sidebarWidth) + 中间(containerWidth) + 右侧(containerWidth)
  const getBaseTranslate = useCallback(() => {
    switch (screenPosition) {
      case 'left': return 0; // 显示左侧应用入口
      case 'center': return -sidebarWidth; // 显示中间文件视图
      case 'right': return -(sidebarWidth + containerWidth); // 显示右侧应用内容（整宽）
      default: return -sidebarWidth;
    }
  }, [screenPosition, sidebarWidth, containerWidth]);

  // ========== 三屏滑动：拖拽处理 ==========
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    stateRef.current = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      currentTranslate: getBaseTranslate(),
      axisLocked: null,
    };
    setIsDragging(true);
    setDragOffset(0);
  }, [getBaseTranslate]);

  const handleDragMove = useCallback((clientX: number, clientY: number, preventDefault: () => void) => {
    if (!stateRef.current.isDragging) return;

    const deltaX = clientX - stateRef.current.startX;
    const deltaY = clientY - stateRef.current.startY;

    // 确定轴向（轴向锁定，防止与竖直滚动冲突）
    if (stateRef.current.axisLocked === null && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        stateRef.current.axisLocked = 'horizontal';
      } else {
        stateRef.current.axisLocked = 'vertical';
        stateRef.current.isDragging = false;
        setIsDragging(false);
        return;
      }
    }

    if (stateRef.current.axisLocked === 'vertical') return;
    if (stateRef.current.axisLocked === 'horizontal') preventDefault();

    // 限制范围：最大偏移 = 左侧宽度 + 中间宽度
    const minTranslate = -(sidebarWidth + containerWidth);
    const maxTranslate = 0;
    let newTranslate = stateRef.current.currentTranslate + deltaX;
    newTranslate = Math.max(minTranslate, Math.min(maxTranslate, newTranslate));

    setDragOffset(newTranslate - getBaseTranslate());
  }, [sidebarWidth, containerWidth, getBaseTranslate]);

  const handleDragEnd = useCallback(() => {
    if (!stateRef.current.isDragging) {
      stateRef.current.axisLocked = null;
      return;
    }

    const threshold = sidebarWidth * 0.3; // 30% 阈值
    const offset = dragOffset;

    // 根据拖拽方向和距离决定目标屏幕
    if (Math.abs(offset) > threshold) {
      if (offset > 0) {
        // 向右滑动
        if (screenPosition === 'center') setScreenPosition('left');
        else if (screenPosition === 'right') setScreenPosition('center');
      } else {
        // 向左滑动
        if (screenPosition === 'center') {
          // 只有在有打开的应用时才能滑动到右侧
          if (openApp) {
            setScreenPosition('right');
          }
        } else if (screenPosition === 'left') {
          setScreenPosition('center');
        }
      }
    }

    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
    setDragOffset(0);
  }, [dragOffset, screenPosition, sidebarWidth, openApp]);

  // ========== 三屏滑动：绑定触摸事件 ==========
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleDragStart(touch.clientX, touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY, () => e.preventDefault());
    };

    const onTouchEnd = () => handleDragEnd();

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isSmallScreen, handleDragStart, handleDragMove, handleDragEnd]);

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

  // 移动端统一顶栏配置 - 根据屏幕位置、openApp 和文件夹层级动态变化
  useMobileHeader('learning-hub', {
    // 左侧应用入口界面：显示 "应用" 标题
    // 右侧应用面板界面：显示应用标题
    // 中间文件视图界面：显示面包屑导航（使用 titleNode）
    title: screenPosition === 'left'
      ? t('learningHub:apps.title')
      : screenPosition === 'right' && openApp
        ? (openApp.title || t('common:untitled'))
        : undefined,
    // 文件视图界面：使用响应式面包屑组件
    titleNode: screenPosition === 'center' ? (
      <MobileBreadcrumb
        rootTitle={rootTitle}
        breadcrumbs={finderBreadcrumbs}
        onNavigate={handleBreadcrumbNavigate}
      />
    ) : undefined,
    showMenu: true,
    // 左上角按钮逻辑：
    // 1. 应用面板界面 → 返回文件视图
    // 2. 文件视图且在子文件夹 → 返回上级文件夹
    // 3. 文件视图且在根目录 → 切换左侧栏
    onMenuClick: screenPosition === 'right'
      ? () => setScreenPosition('center')
      : screenPosition === 'center' && isInSubfolder
        ? () => finderGoBack()
        : () => setScreenPosition(prev => prev === 'left' ? 'center' : 'left'),
    // 显示返回箭头的条件：应用面板界面 或 在子文件夹中
    showBackArrow: screenPosition === 'right' || (screenPosition === 'center' && isInSubfolder),
    // 翻译/作文/题目集应用：右侧显示设置按钮
    rightActions: screenPosition === 'right' && (openApp?.type === 'translation' || openApp?.type === 'essay' || openApp?.type === 'exam') ? (
      <NotionButton
        variant="ghost"
        size="icon"
        onClick={() => {
          const eventName = openApp?.type === 'translation' 
            ? 'translation:openSettings' 
            : openApp?.type === 'essay'
              ? 'essay:openSettings'
              : 'exam:openSettings';
          if (eventName === 'exam:openSettings') {
            // 使用 Store 而非 window event（规范化跨模块事件）
            const { toggleSettingsPanel } = useQuestionBankStore.getState();
            toggleSettingsPanel();
          } else {
            window.dispatchEvent(new CustomEvent(eventName));
          }
        }}
        className="h-9 w-9"
      >
        <Settings className="h-5 w-5" />
      </NotionButton>
    ) : undefined,
  }, [screenPosition, openApp, t, isInSubfolder, finderBreadcrumbs, finderGoBack, rootTitle, handleBreadcrumbNavigate]);

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
        // 从 DSTU node 创建 OpenApp（支持所有资源类型）
        const appType = node.type as ResourceType;
        setOpenApp({
          type: appType,
          id: node.id,
          title: node.name,
          dstuPath: path, // 使用传入的真实路径
        });
        if (isSmallScreen) {
          setScreenPosition('right');
        }
      },
      openInPage: (path, node, mode) => {
        // 当前默认使用面板
        handler.openInPanel(path, node, mode);
      },
      openInFullscreen: (path, node, mode) => {
        // 当前默认使用面板
        handler.openInPanel(path, node, mode);
      },
      openInModal: (path, node, mode) => {
        // 当前默认使用面板
        handler.openInPanel(path, node, mode);
      },
    };

    // 🔧 P0-28 修复：使用命名空间注册，避免覆盖其他处理器
    const unregister = registerOpenResourceHandler(handler, 'learning-hub');
    return unregister;
  }, [isSmallScreen]);

  // ========== 统一事件监听（使用 useLearningHubEvents hook） ==========
  // 定义事件处理回调
  const handleOpenExamEvent = useCallback((detail: OpenExamEventDetail) => {
    const { sessionId } = detail;
    if (!sessionId) return;

    setOpenApp({
      type: 'exam',
      id: sessionId,
      title: t('learningHub:examSheet'),
      dstuPath: `/${sessionId}`,
    });
    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen]);

  const handleOpenTranslationEvent = useCallback((detail: OpenTranslationEventDetail) => {
    const { translationId, title } = detail;
    if (!translationId) return;

    setOpenApp({
      type: 'translation',
      id: translationId,
      title: title || t('learningHub:translation'),
      dstuPath: `/${translationId}`,
    });

    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen]);

  const handleOpenEssayEvent = useCallback((detail: OpenEssayEventDetail) => {
    const { essayId, title } = detail;
    if (!essayId) return;

    setOpenApp({
      type: 'essay',
      id: essayId,
      title: title || t('learningHub:essay'),
      dstuPath: `/${essayId}`,
    });

    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen]);

  const handleOpenNoteEvent = useCallback((detail: OpenNoteEventDetail) => {
    const { noteId } = detail;
    if (!noteId) return;

    setOpenApp({
      type: 'note',
      id: noteId,
      title: t('learningHub:note'),
      dstuPath: `/${noteId}`,
    });

    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [t, isSmallScreen]);

  const handleOpenResourceEvent = useCallback(async (detail: OpenResourceEventDetail) => {
    const { dstuPath } = detail;
    if (!dstuPath) return;

    debugLog.log('[LearningHubPage] learningHubOpenResource:', dstuPath);

    try {
      // 动态导入以避免循环依赖
      const { openResource } = await import('@/dstu/openResource');
      const result = await openResource(dstuPath, { mode: 'view' });
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
    const { preferTab, documentId, fileName, resourceType, memoryId } = detail;

    // 根据 preferTab 导航到对应视图
    if (preferTab === 'memory' || memoryId) {
      // 用户记忆视图
      finderQuickAccessNavigate('memory');
      // 如果有 memoryId，写入缓冲区供 MemoryView 消费
      if (memoryId) {
        setPendingMemoryLocate(memoryId);
      }
      // 移动端：切换到中间视图显示内容
      if (isSmallScreen) {
        setScreenPosition('center');
      }
    } else if (documentId) {
      // ★ 2026-01-22: 处理 VFS 资源 ID (res_xxx)，需要查询正确的 DSTU 资源 ID
      let finalDocumentId = documentId;

      if (documentId.startsWith('res_')) {
        try {
          // 通过 VFS API 查询资源的 source_id
          const { invoke } = await import('@tauri-apps/api/core');
          const resource = await invoke<{ sourceId?: string } | null>('vfs_get_resource', { resourceId: documentId });
          if (resource?.sourceId) {
            finalDocumentId = resource.sourceId;
            debugLog.log('[LearningHub] Resolved VFS resource ID:', documentId, '→', finalDocumentId);
          } else {
            debugLog.warn('[LearningHub] VFS resource has no sourceId:', documentId);
          }
        } catch (error: unknown) {
          debugLog.error('[LearningHub] Failed to resolve VFS resource:', error);
        }
      }

      // RAG 文档 - 直接打开文档预览器
      // 优先使用后端返回的 resourceType，回退到从文件名推断
      const appType = (resourceType as ResourceType) || inferResourceTypeFromFileName(fileName || '');
      setOpenApp({
        type: appType,
        id: finalDocumentId,
        title: fileName || t('learningHub:document'),
        dstuPath: `/${finalDocumentId}`,
      });
      // 移动端：切换到右侧应用视图
      if (isSmallScreen) {
        setScreenPosition('right');
      }
    } else {
      // 默认导航到记忆视图
      finderQuickAccessNavigate('memory');
      if (isSmallScreen) {
        setScreenPosition('center');
      }
    }
  }, [finderQuickAccessNavigate, isSmallScreen, t]);

  // ========== 打开应用（从 ResourceListItem） ==========
  const handleOpenApp = useCallback((item: ResourceListItem) => {
    // item.path 是用户在 Learning Hub 中看到的文件夹路径，如 /1111/abc.pdf
    setOpenApp({
      type: item.type,
      id: item.id,
      title: item.title,
      dstuPath: item.path || `/${item.id}`, // 真实路径，如果没有则使用 ID
    });
    // 移动端：自动切换到右侧应用视图
    if (isSmallScreen) {
      setScreenPosition('right');
    }
  }, [isSmallScreen]);

  // ========== 标题更新回调（统一面板加载资源后更新标题） ==========
  const handleTitleChange = useCallback((title: string) => {
    setOpenApp(prev => prev ? { ...prev, title } : null);
  }, []);

  // ========== 关闭应用 ==========
  const handleCloseApp = useCallback(() => {
    setOpenApp(null);
    setLocalSidebarCollapsed(false);
  }, []);

  // ========== 快捷创建并打开资源 ==========
  const handleCreateAndOpen = useCallback(async (type: 'exam' | 'essay' | 'translation' | 'note') => {
    // 获取当前文件夹 ID
    const currentFolderId = finderCurrentPath.folderId;

    // 调用 createEmpty 创建新资源
    const result = await createEmpty({
      type: type as CreatableResourceType,
      folderId: currentFolderId,
    });

    if (result.ok) {
      const newNode = result.value;
      // 刷新文件列表
      finderRefresh();
      // 打开新创建的资源
      setOpenApp({
        type: type,
        id: newNode.id,
        title: newNode.name,
        dstuPath: newNode.path || `/${newNode.id}`,
      });
      // 移动端：自动切换到右侧应用视图
      if (isSmallScreen) {
        setScreenPosition('right');
      }
      showGlobalNotification('success', t('learningHub:quickCreate.success'));
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [finderCurrentPath.folderId, finderRefresh, isSmallScreen, t]);

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

  // ========== 📱 同步应用状态到导航上下文 ==========
  useEffect(() => {
    const hasApp = openApp !== null;
    setHasOpenApp(hasApp);

    // 注册关闭回调
    if (hasApp) {
      registerCloseAppCallback(handleCloseApp);
    } else {
      registerCloseAppCallback(null);
    }
  }, [openApp, setHasOpenApp, registerCloseAppCallback, handleCloseApp]);

  // ========== 添加到对话（引用模式） ==========
  const handleInjectToChat = useCallback(async () => {
    if (!openApp) return;
    
    // ResourceType → VfsResourceType 映射（只有支持的类型可以注入）
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
    
    const sourceType = typeMapping[openApp.type];
    if (!sourceType) {
      debugLog.warn('[LearningHubPage] Unsupported resource type for injection:', openApp.type);
      return;
    }
    
    await injectToChat({
      sourceId: openApp.id,
      sourceType,
      name: openApp.title || t('common:untitled'),
      metadata: {
        title: openApp.title,
      },
    });
  }, [openApp, injectToChat, t]);

  // 检查当前资源类型是否支持添加到对话
  const canInjectCurrentResource = useCallback(() => {
    if (!openApp) return false;
    const supportedTypes: ResourceType[] = ['note', 'textbook', 'exam', 'translation', 'essay'];
    return supportedTypes.includes(openApp.type);
  }, [openApp]);

  // 更新 ref 引用以便 useMobileHeader 中调用
  handleInjectToChatRef.current = handleInjectToChat;
  handleCloseAppRef.current = handleCloseApp;
  canInjectCurrentResourceRef.current = canInjectCurrentResource;

  const hasOpenApp = openApp !== null;
  const AppIcon = openApp ? getAppIcon(openApp.type) : FileText;
  
  // 应用面板引用，用于控制展开/折叠
  const appPanelRef = useRef<ImperativePanelHandle>(null);
  
  // 当应用打开/关闭时控制面板展开/折叠
  useEffect(() => {
    const appPanel = appPanelRef.current;
    if (!appPanel) return;

    if (hasOpenApp) {
      // 打开应用时展开应用面板，收缩侧边栏
      appPanel.expand();
      // 延迟一帧后收缩侧边栏，让动画更流畅
      requestAnimationFrame(() => {
        setLocalSidebarCollapsed(true);
      });
    } else {
      // 关闭应用时折叠应用面板
      appPanel.collapse();
    }
  }, [hasOpenApp]);

  // ========== 移动端：三屏滑动布局 ==========
  if (isSmallScreen) {
    const translateX = getBaseTranslate() + dragOffset;

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 flex flex-col overflow-hidden bg-background select-none"
        style={{
          touchAction: 'pan-y pinch-zoom',
          // 给底部导航栏留空间 - 使用 CSS 变量作为 Android fallback
          // BottomTabBar 高度为 56px（见 MOBILE_LAYOUT.bottomTabBar.defaultHeight）
          bottom: 'calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 56px)',
        }}
      >
        {/* 三屏内容容器：左侧(sidebarWidth) + 中间(100%) + 右侧(100%) */}
        <div
          className="flex flex-1 min-h-0"
          style={{
            width: `calc(200% + ${sidebarWidth}px)`,
            transform: `translateX(${translateX}px)`,
            transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* 左侧：DSTU 应用入口 */}
          <div
            className="h-full flex-shrink-0 bg-background"
            style={{ width: sidebarWidth }}
          >
            <DstuAppLauncher
              activeType={activeAppType}
              onSelectApp={(type) => {
                setActiveAppType(type);
                // ★ 2026-01-19: 调用 finderStore 进行实际导航
                // 映射 DstuAppLauncher 的类型到 finderStore 的 QuickAccessType
                const typeMapping: Record<string, string> = {
                  'desktop': 'desktop',
                  'all': 'allFiles',
                  'note': 'notes',
                  'textbook': 'textbooks',
                  'exam': 'exams',
                  'translation': 'translations',
                  'essay': 'essays',
                  'mindmap': 'mindmaps',
                  'image': 'images',
                  'file': 'files',
                  'recent': 'recent',
                  'favorites': 'favorites',
                  'trash': 'trash',
                  'indexStatus': 'indexStatus',
                  'memory': 'memory',
                };
                const quickAccessType = typeMapping[type] || 'allFiles';
                finderQuickAccessNavigate(quickAccessType as any);
                setScreenPosition('center');
              }}
              onCreateAndOpen={handleCreateAndOpen}
              onClose={() => setScreenPosition('center')}
            />
          </div>

          {/* 中间：文件视图 */}
          <div
            className="h-full flex-shrink-0 bg-background overflow-hidden"
            style={{ width: containerWidth || '100vw' }}
          >
            <LearningHubSidebar
              mode="fullscreen"
              onOpenPreview={handleOpenApp}
              onOpenApp={handleOpenApp}
              className="h-full overflow-hidden"
              isCollapsed={false}
              activeFileId={openApp?.id}
            />
          </div>

          {/* 右侧：DSTU 应用内容（整宽） */}
          <div
            className="h-full flex-shrink-0 bg-background overflow-hidden"
            style={{ width: containerWidth || '100vw' }}
          >
            {openApp ? (
              <div className="h-full flex flex-col safe-area-bottom">
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
                    dstuPath={openApp.dstuPath}
                    onClose={() => {
                      handleCloseApp();
                      setScreenPosition('center');
                    }}
                    onTitleChange={handleTitleChange}
                    className="h-full"
                  />
                </Suspense>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                <div className="text-center p-8">
                  <LayoutGrid className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p className="text-sm">{t('learningHub:selectResource')}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ========== 桌面端：分栏布局 ==========
  return (
    <div className="w-full h-full bg-background">
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
          <div className={cn("h-full", hasOpenApp && "border-r border-border")}>
            <LearningHubSidebar
              mode="fullscreen"
              onOpenPreview={handleOpenApp}
              onOpenApp={handleOpenApp}
              className="w-full h-full"
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => handleSidebarCollapsedChange(!sidebarCollapsed)}
              activeFileId={openApp?.id}
              hasOpenApp={hasOpenApp}
              onCloseApp={handleCloseApp}
            />
          </div>
        </Panel>

        {/* 分隔条 */}
        <PanelResizeHandle
          className={cn(
            "w-1.5 transition-colors flex items-center justify-center group",
            hasOpenApp
              ? "bg-border hover:bg-primary/30 active:bg-primary/50"
              : "w-0 opacity-0 pointer-events-none"
          )}
        >
          <GripVertical className="w-3 h-3 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
        </PanelResizeHandle>

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
          {openApp && (
            <div className="h-full flex flex-col bg-background min-w-0">
              {/* 应用内容区域 - 直接显示内容，不显示标题栏 */}
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
                    dstuPath={openApp.dstuPath}
                    onClose={handleCloseApp}
                    onTitleChange={handleTitleChange}
                    className="h-full"
                  />
                </Suspense>
              </div>
            </div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
};

export default LearningHubPage;
