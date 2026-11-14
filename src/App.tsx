import React, { Suspense } from 'react';
import { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import './i18n';
import { useTranslation } from 'react-i18next';
// getCurrentWebviewWindow 已无使用（2026-02 清理）
import { useDesktopWindowMaximizeToggle } from './app/hooks/useDesktopWindowMaximizeToggle';
// 🚀 性能优化：Settings, Dashboard, SOTADashboard 改为懒加载
import { CaretLeft, CaretRight, CircleNotch, Terminal, Warning, X } from '@phosphor-icons/react';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { TextSwap } from '@/components/ui/TextSwap';
import { useUIStore } from '@/stores/uiStore';
import { useSyncSuperAgentEnabled } from '@/stores/superAgentEnabledStore';

import { DsDialog, DsDialogBody } from './components/ui/DsDialog';
import { useWindowDrag } from './hooks/useWindowDrag';
// 🚀 性能优化：ImageViewer 改为懒加载
import { useDesktopSidebarElements } from './app/hooks/useDesktopSidebarElements';
import { DesktopShellSidebarLayers } from './app/shell/DesktopShellSidebarLayers';
import { StudyComposeIcon } from './components/icons/StudySidebarIcons';
import { WindowControls } from './components/WindowControls';
import { DesktopShellTitleEditor } from './components/DesktopShellTitleEditor';
import { MobileLayoutProvider, MobileHeaderProvider, MobileHeaderNavProvider, MobileHeaderActiveViewSync, MobileAppNavigationProvider } from '@/components/layout';
import { GlobalPomodoroWidget } from '@/features/pomodoro/components/GlobalPomodoroWidget';
import { DueMistakesReviewHost } from '@/features/learning-today/DueMistakesReviewHost';
import { useAutomationRunNotifications } from '@/features/todo/hooks/useAutomationRunNotifications';
// 🚀 性能优化：IrecServiceSwitcher, IrecGraphFlow, IrecGraphFlowDemo, CrepeDemoPage, ChatV2IntegrationTest, BridgeToIrec 改为懒加载
import { TauriAPI } from './utils/tauriApi';
// ★ MistakeItem 类型导入已废弃（2026-01 清理）
import { isWindows, isMacOS, isMobilePlatform } from './utils/platform';
import {
  syncNativeWindowAppearance,
} from './utils/sidebarTranslucency';
// 🚀 性能优化：ChatV2Page 改为懒加载，见 lazyComponents.tsx
// NT-1: NoteEditorPortal（白板远程桌面模式遗留，恒 return null）已随死渲染路径移除
// 🚀 性能优化：TreeDragTest, PdfReader, LearningHubPage 改为懒加载
import { LearningHubNavigationProvider } from './features/learning-hub';
import { setActiveOpenResourceHandler } from './dstu/openResource';
import { pageLifecycleTracker } from './debug-panel/services/pageLifecycleTracker';
import 'overlayscrollbars/overlayscrollbars.css';
import './styles/tailwind.css'; // Tailwind (should be first to provide base/utility layers)
import './styles/shadcn-variables.css'; // 设计令牌：支持亮/暗色变量（必须优先）
import './styles/theme-colors.css';
import './shared/styles/index.css';

import './styles/ios-safe-area.css'; // iOS安全区域适配
import './styles/responsive-utilities.css'; // 响应式工具类
// 🚀 性能优化：页面组件改为懒加载
import { NotificationContainer } from './components/NotificationContainer';
import { showGlobalNotification } from './components/UnifiedNotification';
import { getErrorMessage } from './utils/errorUtils';
import { useAppInitialization } from './hooks/useAppInitialization';
import { useShellScrollGuard } from './hooks/useShellScrollGuard';
import { useAppUpdater } from './hooks/useAppUpdater';
import { UserAgreementDialog, useUserAgreement } from './components/legal/UserAgreementDialog';
import { WelcomeOnboardingDialog, useWelcomeOnboarding } from './components/onboarding/WelcomeOnboardingDialog';
import { useMigrationStatusListener } from './hooks/useMigrationStatusListener';
import { useQbankGenerationTasks } from './hooks/useQbankGenerationTasks';
import useTheme from './hooks/useTheme';
import { useDialogControl } from './contexts/DialogControlContext';
import './styles/typography.css'; // 全局排版（字体/字号/行高）
import './styles/shadcn-overrides.css'; // 修复图标尺寸被覆盖的问题
import { MigrationStatusBanner } from './components/system-status/MigrationStatusBanner';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from './app/shell/DesktopShellIcons';
import { setPendingSettingsTab, setPendingSettingsRoute } from './utils/pendingSettingsTab';
import { useBreakpoint } from './hooks/useBreakpoint';
import { shouldBlockMobileNavigation, ensureKeyboardTracking } from './hooks/useKeyboardHeight';
import { installAndroidBackBridge, registerBackHandler, BACK_PRIORITY } from './app/navigation/androidBackCoordinator';
import { useDesktopTitlebarInteractions } from './app/hooks/useDesktopTitlebarInteractions';
import type { CurrentView as NavigationCurrentView } from './types/navigation';
import { usePreventScroll } from './hooks/usePreventScroll';
// ★ 刻意深路径导入：经 command-palette/index.ts barrel 会把 ShortcutSettings
//   → @/features/settings barrel → 全部设置页签（含 recharts 等重组件）拖进主 bundle；
//   ShortcutSettings 在 Settings.tsx 中本就是 React.lazy 加载（设计 §9.3 同法）。
import { CommandPaletteProvider, useCommandPalette } from './command-palette/CommandPaletteProvider';
import { CommandPalette } from './command-palette/CommandPalette';
import { useAppBackgroundServices } from './app/hooks/useAppBackgroundServices';
import { TextContextMenuProvider } from './components/context-menu/TextContextMenu';
import { useMenuEventBridge } from './menu/menuEventBridge';
import { useCommandEvents, COMMAND_EVENTS } from './command-palette/hooks/useCommandEvents';
import { useEventRegistry } from './hooks/useEventRegistry';
import {
  APP_EVENTS,
  addAppEventListener,
  dispatchAppEvent,
  toAppEventListener,
  useAppEvent,
} from '@/events';
import { useViewStore } from './stores/viewStore';
import { debugLog } from './debug-panel/debugMasterSwitch';
import { GoalStatusChip } from './features/chat/components/GoalStatusChip';
import { useSessionSidebarContextSync } from './app/hooks/useSessionSidebarContextSync';
import { useDesktopSidebarLayout } from './app/shell/useDesktopSidebarLayout';
import { useChatHeaderSession } from './app/shell/useChatHeaderSession';

import { useSlot } from './ui-kernel/react';
import type { ShellView } from './ui-kernel/contracts/shell';
import { RegisteredViewLayer } from './ui-plugins/official/shell/RegisteredViewLayer';
import { resolveShellView } from './ui-plugins/official/shell/navigation';
import { rememberCardsHubView } from './app/navigation/cardsHub';
import { CardsHubTabs } from './app/shell/CardsHubTabs';
import { advanceViewNavStack, computeNextVisitedViews } from './app/navigation/viewRouting';
import {
  DESKTOP_SHELL,
  getShellSidebarMaxWidth,
} from './app/shell/desktopShell';
import { DesktopSidebarResizeHandle } from './app/shell/DesktopSidebarResizeHandle';
import { DesktopShellSidebarPortalProvider } from './app/shell/DesktopShellSidebarPortal';
import { DesktopShellHeaderPortalProvider } from './app/shell/DesktopShellHeaderPortal';
import {
  handleDesktopToolbarButtonClick,
  handleDesktopToolbarButtonMouseDown,
  handleHeaderHotzoneClick,
  handleHeaderHotzoneKeyDown,
} from './app/shell/desktopHeaderHotzone';
import { Z_INDEX } from './config/zIndex';
import { useSystemStatusSync } from './app/hooks/useSystemStatusSync';
import { useDebugPanelRequests } from './app/hooks/useDebugPanelRequests';
import { usePlatformSettingsSync } from './app/hooks/usePlatformSettingsSync';
import { useViewRedirects } from './app/hooks/useViewRedirects';
import { useFrontendErrorCapture } from './app/hooks/useFrontendErrorCapture';
import { useShellNavigationEvents } from './app/hooks/useShellNavigationEvents';
import { useUnifiedNavigation } from './app/hooks/useUnifiedNavigation';
import { useCrossFeatureHandoffs } from './app/hooks/useCrossFeatureHandoffs';
import { useDevtoolsShortcut } from './app/hooks/useDevtoolsShortcut';
import { useWebviewSettingsPersistence } from './app/hooks/useWebviewSettingsPersistence';

// 🚀 性能优化：懒加载页面组件
import { PageLoadingFallback } from './lazyComponents';
import { useViewLayer } from './app/shell/useViewLayer';

// ★ Workbench（学习 OS 桌面，实验功能）：刻意深路径导入轻量模块，
//   避免经 workbench/index.ts 把应用群 re-export 拖进主 bundle；
//   桌面本体为独立 lazy chunk，开关关闭时不加载（设计 §9.3）。
//   W38：移动端构建不包含 features/workbench —— AgentBridge / 宿主桥都经
//   平台门控的 dynamic import 载入（见 src/app/workbench/load.ts）。
import { useWorkbenchMode } from './app/hooks/useWorkbenchMode';
import { loadWorkbenchHost } from './app/workbench/load';
import { prewarmWorkbenchDesktop } from './app/workbench/lazyDesktop';
import { AppShellChrome } from './app/shell/AppShellChrome';
import { useAppViewState } from './app/shell/useAppViewState';
import { useAppNavigation } from './app/shell/useAppNavigation';
import { useClassicToWorkbenchHandoff } from './app/hooks/useClassicToWorkbenchHandoff';
import { requestLearningHubIntent } from '@/features/learning-hub/navigation/pendingLearningHubIntent';

void loadWorkbenchHost();
prewarmWorkbenchDesktop();

// ★ debugLog 别名：将本文件中的 console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
// Web 演示壳（demo.html/hero.html iframe）标记：由 src/demo/main.tsx 在加载 App 前置位。
// 演示环境不渲染任何开发版悬浮件（调试面板球、移动端恢复 FAB）。
const isDemoShell =
  typeof window !== 'undefined' && Boolean((window as unknown as { __DS_DEMO_SHELL__?: boolean }).__DS_DEMO_SHELL__);

type CurrentView = NavigationCurrentView;

const BRIDGE_COMPLETION_REASONS = new Set([
  'stream-complete',
  'manual-stop',
  'manual-stop-empty',
  'manual-save',
  'auto-complete-temp-session',
  'edit',
  'retry',
  'delete',
]);


function App() {
  // 全面接入新引擎统一管理（在 App 级别避免再手绑流事件）
  const USE_STABLE_STREAM_ENGINE = true;
  // 🚀 应用初始化
  useAppInitialization();
  // Super-agent 会话：启动后以后端状态（开关 + 会话 id）校正本地镜像，并订阅 super_session_changed
  useSyncSuperAgentEnabled();

  // 🛡️ 外壳滚动保护：focus/scrollIntoView/拖拽自动滚动等把 overflow:hidden
  // 的壳层容器滚出偏移时（表现为整页滚走、渲染断成两半）立即复位
  useShellScrollGuard();

  // 🍎 macOS 原生菜单栏 → 命令系统桥接（其他平台为 no-op）
  useMenuEventBridge();
  
  // 🆕 监听数据治理迁移状态（启动时显示警告/错误通知）
  useMigrationStatusListener();
  useAutomationRunNotifications();
  // 🆕 AI 出题后台任务：常驻监听全局任务事件 + 轮询兜底（2026-09-09 后台化）
  useQbankGenerationTasks();

  // 🆕 用户协议同意检查（合规要求）
  const { needsAgreement, checkAgreement, acceptAgreement } = useUserAgreement();
  useEffect(() => { checkAgreement(); }, [checkAgreement]);

  // 🆕 首启欢迎引导：协议同意后、且未配置任何 AI 服务时展示一次
  const { open: welcomeOnboardingOpen, dismiss: dismissWelcomeOnboarding } =
    useWelcomeOnboarding(needsAgreement === false);

  // 🌍 国际化支持（提前至此处，后续 useEffect 依赖 t）
  const { t, i18n } = useTranslation(['common', 'analysis', 'sidebar', 'command_palette', 'settings']);
  const updater = useAppUpdater();

  // 🆕 维护模式：从 store 读取全局状态
  const maintenanceMode = useSystemStatusStore((s) => s.maintenanceMode);
  const maintenanceReason = useSystemStatusStore((s) => s.maintenanceReason);
  const maintenanceRequiresRestart = useSystemStatusStore((s) => s.maintenanceRequiresRestart);
  const chatV2Blocked = useSystemStatusStore((s) =>
    s.componentHealth.some((entry) => entry.component === 'chat_v2' && entry.status === 'blocked'),
  );

  // 🆕 任务3 + 🌐 全局网络状态：后端维护模式同步、网络上下线通知
  useSystemStatusSync(t);

  // P1修复：暗色主题初始化
  const { isDarkMode, toggleDarkMode } = useTheme(); // 自动初始化主题系统

  useEffect(() => {
    void syncNativeWindowAppearance(isDarkMode);
  }, [isDarkMode]);
  

  // 对话控制（MCP 工具与搜索引擎选择）
  const { selectedMcpTools, selectedSearchEngines } = useDialogControl();
  
  // 响应式检测：移动端布局调整
  const { isSmallScreen } = useBreakpoint();
  const { debugPanelRequested, debugPanelOpenRequest } = useDebugPanelRequests();

  // 防止 content-body 被编程方式滚动
  const contentBodyRef = useRef<HTMLDivElement>(null);
  usePreventScroll(contentBodyRef);

  // 平台 / 外观设置：Android 沉浸式、顶栏边距、macOS 字体平滑、侧栏半透明、指针光标
  const { topbarTopMargin } = usePlatformSettingsSync(isSmallScreen);
  
  // 🎯 应用级后台服务：内置命令注册（随语言重注册）、待办提醒、云同步进度与自动同步、制卡完成通知
  useAppBackgroundServices(i18n);

  // 🎯 命令面板：语言切换回调
  const switchLanguage = useCallback((lang: 'zh-CN' | 'en-US') => {
    i18n.changeLanguage(lang);
  }, [i18n]);

  // 🎯 命令面板：导航回调（包装 setCurrentView）
  const commandPaletteNavigate = useCallback((view: CurrentView, params?: Record<string, unknown>) => {
    setCurrentView(view);
    // 如果有参数，可以通过事件或其他方式传递
    void params;
  }, []);

  // ★ Workbench 产品默认身份 + 平台护栏 + 应用退出护栏（见 useWorkbenchMode）
  const { workbenchActive } = useWorkbenchMode(i18n);

  const {
    viewEntries,
    viewEntriesRef,
    currentView,
    setCurrentView,
    activeView,
    activeShell,
    visitedViews,
    viewNavDirection,
    currentViewRef,
    isSmallScreenRef,
    uiLabEnabled,
  } = useAppViewState({ isSmallScreen, isDemoShell });
  const layout = useDesktopSidebarLayout({ isSmallScreen, workbenchActive, topbarTopMargin, t });
  const { leftPanelCollapsed, leftPanelWidth } = layout;
  const { toggleDesktopWindowMaximize } = useDesktopWindowMaximizeToggle();
  const [templateManagementRefreshTick, setTemplateManagementRefreshTick] = useState(0);
  const [desktopPageSidebarTarget, setDesktopPageSidebarTarget] = useState<HTMLDivElement | null>(null);
  const [desktopPageHeaderTarget, setDesktopPageHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [desktopChatHeaderTarget, setDesktopChatHeaderTarget] = useState<HTMLDivElement | null>(null);
  // ★ 移动端顶栏活跃视图同步已移至 MobileHeaderActiveViewSync 组件

  const textbookMaxPages = 12;
  const textbookExportScale = 2.0;
  const textbookExportConcurrency = 2;

  // 🎯 监听导入对话事件（owner: App shell）
  useAppEvent(APP_EVENTS.OPEN_IMPORT_CONVERSATION, () => {
    setShowImportConversation(true);
  }, []);

  // 🎯 监听云存储设置事件
  // 移动端不弹全局配置弹窗（移动端设计契约：表单类流程禁用模态框），
  // 改为导航到 设置 → 数据治理 → 同步 的内联编辑器，可经统一顶栏/系统返回键闭环返回
  useAppEvent(APP_EVENTS.OPEN_CLOUD_STORAGE_SETTINGS, () => {
    if (isSmallScreenRef.current) {
      const route = { tab: 'data-governance' as const, dataGovernanceTab: 'sync' };
      setPendingSettingsRoute(route);
      dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, route);
      setCurrentView('settings');
      return;
    }
    setShowCloudStorageSettings(true);
  }, [setCurrentView]);

  // 统一架构：selectedMistake 已移除，由 ChatSessionStore 统一管理
  const [showImportConversation, setShowImportConversation] = useState(false);
  const [showCloudStorageSettings, setShowCloudStorageSettings] = useState(false);

  // 导入对话成功后的处理
  const handleImportConversationSuccess = useCallback(async (mistakeId: string) => {
    try {
      // 旧错题会话自动打开链路已移除，改为引导用户在 Chat V2 中继续操作
      setCurrentView('chat-v2');
      showGlobalNotification('info', t('common:conversation.import_success'), t('common:conversation.import_success_description', { id: mistakeId }));
    } catch (err) {
      console.error('获取导入的错题失败:', err);
      showGlobalNotification('error', t('common:conversation.import_open_error'), getErrorMessage(err));
    }
  }, [t]);

  // 前端错误采集：记录到事件模式（channel='error', eventName='frontend_error'）
  useFrontendErrorCapture();

  const {
    unifiedCanGoBack,
    unifiedCanGoForward,
    unifiedGoBack,
    unifiedGoForward,
    mobileHeaderCanGoBack,
    handleMobileHeaderBack,
    isSelectingTemplate,
    setIsSelectingTemplate,
    handleTemplateSelectionRequest,
    handleTemplateSelected,
    handleTemplateSelectionCancel,
    handleViewChange,
    handleMobileAppNavigate,
  } = useAppNavigation({
    workbenchActive,
    currentView,
    setCurrentView,
    currentViewRef,
    viewEntriesRef,
    isSmallScreenRef,
    activeShell,
    t,
  });

  // 开发者工具快捷键支持 (仅生产模式，仅 Ctrl+Shift+I / Cmd+Alt+I)
  useDevtoolsShortcut();

  // 开发功能设置状态
  // 移除：Gemini 适配器测试开关

  // App组件状态变化（已禁用日志）
  const { startDragging } = useWindowDrag();
  
  
  // 🔧 定期持久化 WebView 设置，确保自动备份可获取
  useWebviewSettingsPersistence();

  // 键盘快捷键：视图导航已迁移到命令系统（navigation.commands.ts）
  // Cmd+1→chat-v2, Cmd+5→dashboard, Cmd+,→settings, Cmd+E→data-management
  // Cmd+S→按视图保存（chat.save / notes.save）, Cmd+R→按视图重试（chat.retry / anki.regenerate）

  // 管理题目图片URL的生命周期

  // 渲染侧边栏导航 - 现代化风格（主 ModernSidebar + 设置 / 待办壳侧栏）
  const {
    sidebarElement,
    settingsShellSidebarElement,
    todoShellSidebarElement,
  } = useDesktopSidebarElements(updater, currentView, handleViewChange, leftPanelCollapsed, setCurrentView);

  const handleDesktopPageSidebarTarget = useCallback((node: HTMLDivElement | null) => {
    setDesktopPageSidebarTarget(node);
  }, []);
  // 模板管理并入闪卡中心后沿用主侧栏（页内顶部导航），桌面页壳侧栏仅资源库使用
  const shouldShowDesktopPageBackButton = activeShell?.pageBackButton ?? false;
  const desktopPageShellSidebarElement = useMemo(() => (
    <div className="sidebar-shell-surface font-sidebar-study-ui flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      {shouldShowDesktopPageBackButton ? (
        // 顶栏让位与内边距对齐主页侧栏（WorkbenchSidebarSurface 的 paddingTop
        // + WorkbenchSidebarFixed 的 px-2/pb-2/pt-0.5），否则「返回主页」行
        // 与主页首个导航行不在同一基线上（此前硬编码 65px，比主页低 11px）。
        <div
          className="flex shrink-0 items-center px-2 pb-2 pt-0.5"
          style={{ paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' }}
        >
          <DsButton
            variant="nav"
            size="md"
            onClick={() => setCurrentView('chat-v2')}
            className="desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left"
          >
            <span className="flex w-4 shrink-0 items-center justify-center">
              <CaretLeft size={18} className="h-[18px] w-[18px]" />
            </span>
            <span className="desktop-shell-sidebar-row-title block min-w-0 flex-1 truncate leading-4">
              {t('common:actions.backToHome')}
            </span>
          </DsButton>
        </div>
      ) : null}
      <div ref={handleDesktopPageSidebarTarget} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  ), [handleDesktopPageSidebarTarget, setCurrentView, shouldShowDesktopPageBackButton, t]);
  const desktopShellSidebarPortalValue = useMemo(() => ({
    target: desktopPageSidebarTarget,
    currentView,
  }), [currentView, desktopPageSidebarTarget]);
  const desktopShellHeaderPortalValue = useMemo(() => ({
    target: desktopPageHeaderTarget,
    chatHeaderTarget: desktopChatHeaderTarget,
    currentView,
  }), [currentView, desktopChatHeaderTarget, desktopPageHeaderTarget]);

  // 侧栏内容类型：各类侧栏首次访问后保持挂载，切换时只改变可见性。
  // 主 ModernSidebar 因此不会在 settings/todo/desktop-page 往返时重建并重复拉取会话。
  const desktopShellSidebarKind = activeShell?.sidebarKind ?? 'main';
  const desktopShellSidebarLayers = useMemo(() => [
    ['main', sidebarElement],
    ['settings', settingsShellSidebarElement],
    ['todo', todoShellSidebarElement],
    ['desktop-page', desktopPageShellSidebarElement],
  ] as const, [sidebarElement, settingsShellSidebarElement, todoShellSidebarElement, desktopPageShellSidebarElement]);

  // 会话侧栏指示器上下文：当前视图 / 活跃会话 / 窗口可见性
  useSessionSidebarContextSync(currentView);

  // ★ 分析模式已废弃（旧错题系统已移除）- handleCoreStateUpdate, handleSaveRequest, analysisHostProps 已移除
  // const renderAnalysisView = () => null; // 已废弃

  // 桌面标题栏：拖拽 / 双击最大化、热区按下-拖动-点击、新建会话、打开命令面板
  const interactions = useDesktopTitlebarInteractions(startDragging, toggleDesktopWindowMaximize, currentView, setCurrentView);
  const {
    currentChatHeaderTitle,
    currentChatHeaderGroupName,
    currentChatHeaderSessionId,
    saveCurrentChatHeaderTitle,
  } = useChatHeaderSession(t);
  // ★ P3 handoff · 经典壳 → Workbench 消费侧（会话内 workbenchActive false→true 时在桌面重开同一资源）
  useClassicToWorkbenchHandoff(workbenchActive, currentView, currentChatHeaderSessionId);
  // 壳层标题（桌面标题栏 / 移动端兜底标题）与闪卡中心移动端分区条
  const activeViewOwner = useMemo(
    () => viewEntries.find(entry => entry.key === currentView)?.owner,
    [viewEntries, currentView],
  );
  const desktopShellViewLabel = useMemo(() => {
    if (activeShell?.chatHeader) return currentChatHeaderTitle;
    const rawKey = activeView?.titleKey ?? 'common:app.default_header';
    const resolvedKey = activeViewOwner && !rawKey.includes(':') && typeof i18n?.exists === 'function'
      ? (i18n.exists(`${activeViewOwner}:${rawKey}`)
          ? `${activeViewOwner}:${rawKey}`
          : (i18n.exists(`${activeViewOwner}:title`) ? `${activeViewOwner}:title` : rawKey))
      : rawKey;
    return t(resolvedKey);
  }, [activeShell?.chatHeader, activeView?.titleKey, activeViewOwner, currentChatHeaderTitle, i18n, t]);
  const cardsHubMobileTabs = useMemo(() => (
    isSmallScreen && activeShell?.cardsHubTabs ? (
      <CardsHubTabs variant="mobile" currentView={currentView} onNavigate={handleMobileAppNavigate} />
    ) : undefined
  ), [activeShell?.cardsHubTabs, currentView, handleMobileAppNavigate, isSmallScreen]);

  // 经典壳视图层：contentKey → 内容元素 → 保活层（原 useViewLayerContents + App 内的组装）
  const registeredViewLayers = useViewLayer({
    currentView,
    isSmallScreen,
    setCurrentView,
    setIsSelectingTemplate,
    chatV2Blocked,
    t,
    isSelectingTemplate,
    handleTemplateSelected,
    handleTemplateSelectionCancel,
    templateManagementRefreshTick,
    showImportConversation,
    setShowImportConversation,
    handleImportConversationSuccess,
    uiLabEnabled,
    viewEntries,
    visitedViews,
    viewNavDirection,
  });

  // 保留初始化逻辑，但不阻塞渲染，不再显示覆盖式载入页

  // 🆕 用户协议检查中 —— 等待数据库查询完成
  // needsAgreement: null=检查中, true=需同意, false=已同意
  // 🔧 时序修复：数据库迁移期间检查可能需要重试，显示轻量加载状态替代白屏
  if (needsAgreement === null) {
    return <PageLoadingFallback fullScreen />;
  }
  if (needsAgreement === true) {
    return <UserAgreementDialog onAccept={acceptAgreement} />;
  }

  return (
    <AppShellChrome
      t={t}
      isSmallScreen={isSmallScreen}
      workbenchActive={workbenchActive}
      leftPanelCollapsed={leftPanelCollapsed}
      currentView={currentView}
      isDemoShell={isDemoShell}
      commandPaletteNavigate={commandPaletteNavigate}
      toggleDarkMode={toggleDarkMode}
      isDarkMode={isDarkMode}
      switchLanguage={switchLanguage}
      handleMobileAppNavigate={handleMobileAppNavigate}
      mobileHeaderCanGoBack={mobileHeaderCanGoBack}
      handleMobileHeaderBack={handleMobileHeaderBack}
      unifiedCanGoBack={unifiedCanGoBack}
      unifiedCanGoForward={unifiedCanGoForward}
      unifiedGoBack={unifiedGoBack}
      unifiedGoForward={unifiedGoForward}
      desktopShellViewLabel={desktopShellViewLabel}
      cardsHubMobileTabs={cardsHubMobileTabs}
      handleViewChange={handleViewChange}
      setCurrentView={setCurrentView}
      layout={layout}
      interactions={interactions}
      toggleDesktopWindowMaximize={toggleDesktopWindowMaximize}
      activeShell={activeShell}
      currentChatHeaderTitle={currentChatHeaderTitle}
      currentChatHeaderGroupName={currentChatHeaderGroupName}
      currentChatHeaderSessionId={currentChatHeaderSessionId}
      saveCurrentChatHeaderTitle={saveCurrentChatHeaderTitle}
      setDesktopPageHeaderTarget={setDesktopPageHeaderTarget}
      setDesktopChatHeaderTarget={setDesktopChatHeaderTarget}
      desktopShellSidebarPortalValue={desktopShellSidebarPortalValue}
      desktopShellHeaderPortalValue={desktopShellHeaderPortalValue}
      desktopShellSidebarKind={desktopShellSidebarKind}
      desktopShellSidebarLayers={desktopShellSidebarLayers}
      registeredViewLayers={registeredViewLayers}
      contentBodyRef={contentBodyRef}
      maintenanceMode={maintenanceMode}
      maintenanceReason={maintenanceReason}
      maintenanceRequiresRestart={maintenanceRequiresRestart}
      showCloudStorageSettings={showCloudStorageSettings}
      setShowCloudStorageSettings={setShowCloudStorageSettings}
      debugPanelRequested={debugPanelRequested}
      debugPanelOpenRequest={debugPanelOpenRequest}
      welcomeOnboardingOpen={welcomeOnboardingOpen}
      dismissWelcomeOnboarding={dismissWelcomeOnboarding}
    />
  );
}

export default App;
