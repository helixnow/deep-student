import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { CurrentView } from '@/types/navigation';
import type { SlotEntry } from '@/ui-kernel/slots';
import type { ShellViewContribution } from '@/ui-kernel/contracts/shell';
import {
  APP_EVENTS,
  addAppEventListener,
  dispatchAppEvent,
  toAppEventListener,
  useAppEvent,
} from '@/events';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useCommandEvents, COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import { useUnifiedNavigation } from '@/app/hooks/useUnifiedNavigation';
import { useShellNavigationEvents } from '@/app/hooks/useShellNavigationEvents';
import { useCrossFeatureHandoffs } from '@/app/hooks/useCrossFeatureHandoffs';
import { useViewScrollRestoration } from '@/app/hooks/useViewScrollRestoration';
import { ensureKeyboardTracking, shouldBlockMobileNavigation } from '@/hooks/useKeyboardHeight';
import { BACK_PRIORITY, installAndroidBackBridge, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { resolveShellView } from '@/ui-plugins/official/shell/navigation';
import { requestLearningHubIntent } from '@/features/learning-hub/navigation/pendingLearningHubIntent';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';

interface AppNavigationOptions {
  workbenchActive: boolean;
  currentView: CurrentView;
  setCurrentView: (view: CurrentView | ((prev: CurrentView) => CurrentView)) => void;
  currentViewRef: React.RefObject<CurrentView>;
  viewEntriesRef: React.MutableRefObject<readonly SlotEntry<ShellViewContribution>[]>;
  isSmallScreenRef: React.RefObject<boolean>;
  /** `mobileBackToHome` 决定移动顶栏是否恒显示返回入口 */
  activeShell: { mobileBackToHome?: boolean } | undefined;
  t: TFunction;
}

/**
 * 经典壳的导航接线：媒体时间戳引用、通用导航事件、统一前进/后退、Android 返回键、
 * 移动顶栏返回兜底、命令事件与跨功能交接。
 *
 * W38：从 App.tsx 原样搬出。事件名、优先级与守卫判定不变；`handleViewChange` 仍是
 * 传给侧栏的稳定回调（因此 `modern sidebar` 不会因 App 重渲染而重挂）。
 */
export function useAppNavigation({
  workbenchActive,
  currentView,
  setCurrentView,
  currentViewRef,
  viewEntriesRef,
  isSmallScreenRef,
  activeShell,
  t,
}: AppNavigationOptions) {
  const [previousView, setPreviousView] = useState<CurrentView>('chat-v2');
  const [textbookReturnContext, setTextbookReturnContext] = useState<{ view: CurrentView; payload?: any } | null>(null);
  const textbookReturnContextRef = useRef<typeof textbookReturnContext>(null);
  useEffect(() => {
    textbookReturnContextRef.current = textbookReturnContext;
  }, [textbookReturnContext]);

  // Milkdown / Notes / 新建桥接 / Crepe demo 壳层导航监听；跨页「在学习资源中打开 X」
  const { openInLearningHub } = useShellNavigationEvents(setCurrentView, workbenchActive);

  // 媒体时间戳引用（`[媒体@id:mm:ss]`，闪卡来源按钮、笔记锚点等）：经典壳下除聊天页外
  // 一律在「音视频」学习页打开并跳转（docs/dev/media-learning §0.5）。聊天页自己处理（右侧
  // 附件面板，见 useChatPageEvents）；这里不依赖聊天页挂载——触屏 LRU 可能已淘汰它，否则从
  // 其它页面点击会无响应或在隐藏的聊天面板里出声。跳转只投给子应用学习页的播放器
  // （targetScopeId），资源库保活标签里同一媒体不会抢走 seek；学习页就绪晚于重发窗口时
  // 由媒体视图领取待兑现意图兜底（mediaRefEvents）。
  const handleMediaRefOpen = useCallback((event: Event) => {
    if (workbenchActive || currentViewRef.current === 'chat-v2') return;
    const { resourceId, seconds } = (event as CustomEvent<{ resourceId?: string; seconds?: number }>).detail ?? {};
    if (!resourceId || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return;
    void Promise.all([
      import('@/features/media-studio/mediaStudioNavigation'),
      import('@/features/learning-hub/apps/views/media/mediaRefEvents'),
    ]).then(([{ openMediaStudio, MEDIA_STUDIO_FOCUS_SCOPE }, { requestMediaFocusUntilHandled }]) => {
      openMediaStudio(resourceId);
      requestMediaFocusUntilHandled({ resourceId, seconds, targetScopeId: MEDIA_STUDIO_FOCUS_SCOPE });
    });
  }, [workbenchActive, currentViewRef]);
  useEventRegistry([
    { target: 'document', type: 'media-ref:open', listener: handleMediaRefOpen },
  ], [handleMediaRefOpen]);

  // ★ 2026-01 清理：知识库导航统一跳转到 Learning Hub
  useAppEvent(APP_EVENTS.NAVIGATE_TO_KNOWLEDGE_BASE, (detail) => {
    openInLearningHub(APP_EVENTS.LEARNING_HUB_NAVIGATE_TO_KNOWLEDGE, detail ?? {});
  }, [openInLearningHub]);

  // Chat V2 Integration Test: 集成测试页面入口（仅开发模式）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openChatV2Test = () => setCurrentView('chat-v2-test');
    const dispose = addAppEventListener(APP_EVENTS.OPEN_CHAT_V2_TEST, openChatV2Test);
    (window as unknown as { openChatV2Test?: () => void }).openChatV2Test = openChatV2Test;
    return () => {
      dispose();
      delete (window as unknown as { openChatV2Test?: () => void }).openChatV2Test;
    };
  }, [setCurrentView]);

  // 通用导航事件：支持从任意组件跳转到指定视图
  const handleNavigateToView = useCallback((detail: {
    view?: string;
    returnTo?: string;
    returnPayload?: unknown;
    openResource?: string;
  }) => {
    if (!detail.view) return;

    const targetView = resolveShellView(detail.view, viewEntriesRef.current);
    setTextbookReturnContext(null);

    if (targetView !== currentViewRef.current) {
      setCurrentView(targetView);
    }

    if (detail.openResource && targetView === 'learning-hub' && !workbenchActive) {
      requestLearningHubIntent(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, { dstuPath: detail.openResource });
    }
  }, [currentViewRef, setCurrentView, viewEntriesRef, workbenchActive]);

  useEventRegistry([
    {
      target: 'window',
      type: APP_EVENTS.NAVIGATE_TO_VIEW,
      listener: toAppEventListener(handleNavigateToView),
    },
  ], [handleNavigateToView]);

  // ⚙️ 统一前进 / 后退：页面级历史 + Learning Hub / workbench files 的 finder 历史，含键鼠快捷键
  const {
    navigationHistory,
    unifiedCanGoBack,
    unifiedCanGoForward,
    unifiedGoBack,
    unifiedGoForward,
  } = useUnifiedNavigation(currentView, setCurrentView, workbenchActive);

  // 🤖 Android 系统返回键接管（A-5）：
  // overlay 由协调器内部 handler/Escape 兜底处理；这里注册最低优先级的导航 fallback。
  useEffect(() => {
    installAndroidBackBridge();
    // ⌨️ 键盘 inset 追踪全局启动（残留#4）：不依赖首个 hook 订阅者（InputBarUI
    // 在 chat-v2 内，冷启动直达其他视图时可能尚未挂载），在壳层建立视口基线，
    // 保证 --keyboard-inset 在任何视图聚焦输入前就有定义且基线正确。
    ensureKeyboardTracking();
  }, []);
  const unifiedGoBackRef = useRef({ canGoBack: unifiedCanGoBack, goBack: unifiedGoBack });
  unifiedGoBackRef.current = { canGoBack: unifiedCanGoBack, goBack: unifiedGoBack };
  useEffect(() => {
    return registerBackHandler(() => {
      if (unifiedGoBackRef.current.canGoBack) {
        unifiedGoBackRef.current.goBack();
        return true;
      }
      // F1（移动端审计）：无历史但不在主视图时（如 dashboard / pdf-reader 等
      // 无抽屉入口的页面成为栈底），返回键先回 chat-v2 主视图而非直接退后台，
      // 保证"任何页面进得去就出得来"。
      if (isSmallScreenRef.current && currentViewRef.current !== 'chat-v2') {
        setCurrentView('chat-v2');
        return true;
      }
      return false;
    }, BACK_PRIORITY.navigation);
  }, [currentViewRef, isSmallScreenRef, setCurrentView]);

  // F1（移动端审计）：移动端统一顶栏的返回兜底。
  // dashboard / data-management / pdf-reader / sandbox-workbench
  // 等视图没有 ☰ 抽屉入口，左上角只有全局历史返回按钮；
  // 历史为空时按钮会消失，页面失去唯一出口。这里保证非 chat-v2 视图始终
  // 显示返回按钮：有历史走历史后退，无历史回 chat-v2 主视图。
  // （注册了 showMenu/showBackArrow 的页面优先级更高，不受影响。）
  const mobileHeaderCanGoBack = unifiedCanGoBack || (activeShell?.mobileBackToHome ?? true);
  const handleMobileHeaderBack = useCallback(() => {
    if (unifiedGoBackRef.current.canGoBack) {
      unifiedGoBackRef.current.goBack();
      return;
    }
    setCurrentView('chat-v2');
  }, [setCurrentView]);

  // F12（移动端审计）：DEV FAB「重置导航」/ UI 自动化桥派发的全局恢复事件。
  // 事件名与 src/dev/DevMobileRecoveryFab.tsx 的 MOBILE_VIEW_RESET_EVENT 保持
  // 一致；刻意使用字面量，避免把 dev-only 模块静态引入主 bundle。
  const handleMobileViewReset = useCallback(() => {
    navigationHistory.clear();
    setCurrentView('chat-v2');
  }, [navigationHistory, setCurrentView]);

  useEventRegistry([
    { target: 'window', type: 'deep-student:mobile-view-reset', listener: handleMobileViewReset },
  ], [handleMobileViewReset]);

  // 🎯 P0-01 修复: 监听命令面板导航事件
  // 🎯 P1-04 修复: 监听 GLOBAL_SHORTCUT_SETTINGS 等事件
  const handleShortcutSettings = useCallback(() => {
    setCurrentView('settings');
    // 触发设置页面跳转到快捷键 tab
    setTimeout(() => {
      dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'shortcuts' });
    }, 100);
  }, [setCurrentView]);

  useCommandEvents(
    {
      [COMMAND_EVENTS.NAV_BACK]: unifiedGoBack,
      [COMMAND_EVENTS.NAV_FORWARD]: unifiedGoForward,
      [COMMAND_EVENTS.GLOBAL_SHORTCUT_SETTINGS]: handleShortcutSettings,
    },
    true
  );

  // Same commit-time effect ordering as App before the split: commands → scroll → debug bridge.
  useViewScrollRestoration(currentView);

  // 🔍 调试：暴露加载错题的全局函数供调试插件使用
  useEffect(() => {
    (window as any).debugLoadMistakeChat = async (businessId: string) => {
      try {
        setCurrentView('chat-v2');
        showGlobalNotification('info', t('common:debug.navigation_title'), t('common:debug.navigation_description', { id: businessId }));
        return { id: businessId };
      } catch (err) {
        console.error('[Debug] 加载错题失败:', err);
        throw err;
      }
    };

    return () => {
      delete (window as any).debugLoadMistakeChat;
    };
  }, [setCurrentView, t]);

  // 跨功能交接：试卷 / 翻译 / 作文 / 笔记 → 学习资源页，DSTU_OPEN_NOTE（经典壳），预填聊天输入
  useCrossFeatureHandoffs(openInLearningHub, setCurrentView, workbenchActive);

  // 模板选择：从模板管理进入时保持状态，其它入口进入前清空
  const [isSelectingTemplate, setIsSelectingTemplate] = useState(false);
  const [templateSelectionCallback, setTemplateSelectionCallback] = useState<((template: any) => void) | null>(null);

  // 处理模板选择请求
  const handleTemplateSelectionRequest = useCallback((callback: (template: any) => void) => {
    setPreviousView(currentView);
    setTemplateSelectionCallback(() => callback);
    setIsSelectingTemplate(true);
    setCurrentView('template-management');
  }, [currentView, setCurrentView]);

  // 处理模板选择完成
  const handleTemplateSelected = useCallback((template: any) => {
    if (templateSelectionCallback) {
      templateSelectionCallback(template);
    }
    setIsSelectingTemplate(false);
    setTemplateSelectionCallback(null);
    setCurrentView(previousView);
  }, [templateSelectionCallback, previousView, setCurrentView]);

  // 取消模板选择
  const handleTemplateSelectionCancel = useCallback(() => {
    setIsSelectingTemplate(false);
    setTemplateSelectionCallback(null);
    setCurrentView(previousView);
  }, [previousView, setCurrentView]);


  // 处理页面切换（useCallback 稳定引用，避免 ModernSidebar 每次重渲染）
  const handleViewChange = useCallback((newView: CurrentView) => {
    // 如果切换到模板管理页面，且不是从 Anki 制卡页面进入的，清除选择模板状态
    if (newView === 'template-management' && currentViewRef.current !== 'task-dashboard') {
      setIsSelectingTemplate(false);
      setTemplateSelectionCallback(null);
    }

    setCurrentView(newView);
  }, [currentViewRef, setCurrentView]);

  // 监听调试面板的导航请求（deps 含 handleViewChange，避免 stale closure）
  useAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, (detail) => {
    const tabName = detail?.tabName;

    const tabToViewMap: Record<string, CurrentView> = {
      'anki': 'task-dashboard',
      'settings': 'settings',
      'chat-v2': 'chat-v2',
      'learning-hub': 'learning-hub',
    };

    const targetView = tabName ? tabToViewMap[tabName] : undefined;
    if (targetView) {
      console.log(`[App] 导航请求: ${tabName} -> ${targetView}`);
      handleViewChange(targetView);
    } else {
      console.warn(`[App] 未知的 tabName: ${tabName}`);
    }
  }, [handleViewChange]);

  // P1-7: 移动抽屉导航回调。Android 键盘弹出/输入框聚焦期间屏蔽导航，防止
  // 键盘引发的 resize/blur 连锁误触发输入中被跳转（社区 issue 113 bug 1/3）。
  // 经 MobileAppNavigationProvider 直连注入 MobileSidebarNavigation；下方的
  // 全局事件监听仅作为无 Provider 场景的兼容回退，两条路径共用同一守卫。
  // 返回 false 表示导航被拦截（抽屉侧据此保持展开，不产生点了没反应还关菜单）
  const handleMobileAppNavigate = useCallback((view: CurrentView): boolean => {
    if (shouldBlockMobileNavigation()) return false;
    handleViewChange(view);
    return true;
  }, [handleViewChange]);

  useAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, (detail) => {
    const view = detail?.view;
    if (!view) return;
    handleMobileAppNavigate(view);
  }, [handleMobileAppNavigate]);

  return {
    unifiedCanGoBack,
    unifiedCanGoForward,
    unifiedGoBack,
    unifiedGoForward,
    mobileHeaderCanGoBack,
    handleMobileHeaderBack,
    handleMediaRefOpen,
    isSelectingTemplate,
    setIsSelectingTemplate,
    handleTemplateSelectionRequest,
    handleTemplateSelected,
    handleTemplateSelectionCancel,
    handleViewChange,
    handleMobileAppNavigate,
  };
}
