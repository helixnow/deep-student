import React, { Suspense } from 'react';
import { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import './i18n';
import { useTranslation } from 'react-i18next';
// getCurrentWebviewWindow 已无使用（2026-02 清理）
import { invoke } from '@tauri-apps/api/core';
import { useDesktopWindowMaximizeToggle } from './app/hooks/useDesktopWindowMaximizeToggle';
// 🚀 性能优化：Settings, Dashboard, SOTADashboard 改为懒加载
import { CaretLeft, CaretRight, CircleNotch, Terminal, Warning, X } from '@phosphor-icons/react';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { TextSwap } from '@/components/ui/TextSwap';
import { useUIStore } from '@/stores/uiStore';

// 🚀 性能优化：DataImportExport, ImportConversationDialog 改为懒加载
// ★ 2026-07-08（审计 30-P1-4）：CloudStorageSection（≈1300 行，仅云存储弹窗使用）与
// 制卡任务应用改为 React.lazy，静态导入会把它们及其依赖树拖进首屏 chunk
const CloudStorageSection = React.lazy(() =>
  import('@/features/settings/components/CloudStorageSection').then(m => ({ default: m.CloudStorageSection }))
);
import { DsDialog, DsDialogBody } from './components/ui/DsDialog';
// 🚀 性能优化：Template*, IrecInsightRecall 等页面组件改为懒加载
const AnkiTasksApp = React.lazy(() =>
  import('@/features/anki-tasks/AnkiTasksApp').then(m => ({ default: m.AnkiTasksApp }))
);
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
  clearNativeTitlebarSidebarMaterial,
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
import { useAndroidSafeArea } from './hooks/useAndroidSafeArea';
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
import { sessionManager } from './features/chat/core/session/sessionManager';
import { GoalStatusChip } from './features/chat/components/GoalStatusChip';
import { useSessionSidebarContextSync } from './app/hooks/useSessionSidebarContextSync';
import { groupCache } from './features/chat/core/store/groupCache';
import { getSessionTitleText } from './features/chat/utils/sessionTitle';
import type { ChatStore } from './features/chat/core/types';
import { getHiddenDraftSessionScope } from './features/chat/pages/draftSession';

import { ViewLayerRenderer } from './app/components';
import { canonicalizeView } from './app/navigation/canonicalView';
import { isCardsHubView, rememberCardsHubView } from './app/navigation/cardsHub';
import { CardsHubTabs } from './app/shell/CardsHubTabs';
import { advanceViewNavStack, computeNextVisitedViews } from './app/navigation/viewRouting';
import {
  DESKTOP_SHELL,
  getShellSidebarDragLayout,
  getShellSidebarMaxWidth,
  getShellSidebarWidth,
  resolveShellSidebarResize,
  resolveShellTitlebarTopInset,
} from './app/shell/desktopShell';
import { DesktopSidebarResizeHandle } from './app/shell/DesktopSidebarResizeHandle';
import { DesktopShellSidebarPortalProvider } from './app/shell/DesktopShellSidebarPortal';
import { DesktopShellHeaderPortalProvider } from './app/shell/DesktopShellHeaderPortal';
import { getMobileShellCssVars } from './app/shell/mobileShell';
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
import { useViewScrollRestoration } from './app/hooks/useViewScrollRestoration';
import { useCrossFeatureHandoffs } from './app/hooks/useCrossFeatureHandoffs';
import { useDevtoolsShortcut } from './app/hooks/useDevtoolsShortcut';
import { useWebviewSettingsPersistence } from './app/hooks/useWebviewSettingsPersistence';

// 🚀 性能优化：懒加载页面组件
import {
  PageLoadingFallback,
  LazyDataImportExport,
  LazyImportConversationDialog,
} from './lazyComponents';
import {
  useAuxiliaryViewContents,
  useDashboardAndSettingsContents,
  useFeatureViewContents,
} from './app/hooks/useViewLayerContents';
import { useShellViewChrome } from './app/hooks/useShellViewChrome';

// ★ Workbench（学习 OS 桌面，实验功能）：刻意深路径导入轻量模块，
//   避免经 workbench/index.ts 把应用群 re-export 拖进主 bundle；
//   桌面本体为独立 lazy chunk，开关关闭时不加载（设计 §9.3）。
import { WORKBENCH_MODE_CACHE_KEY, useWorkbenchMode } from './app/hooks/useWorkbenchMode';
import { AgentBridge } from '@/features/workbench/agent/AgentBridge';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useClassicToWorkbenchHandoff } from './app/hooks/useClassicToWorkbenchHandoff';
import { requestLearningHubIntent } from '@/features/learning-hub/navigation/pendingLearningHubIntent';
// 工厂提成共享常量：React.lazy 与下方预热 import() 指向同一模块说明符，命中同一 chunk
const importWorkbenchDesktop = () => import('@/features/workbench/components/WorkbenchDesktop');
const LazyWorkbenchDesktop = React.lazy(importWorkbenchDesktop);

// ★ Workbench chunk 预热：OS 模式是产品默认（缺失键 → true），冷启动大概率要挂
//   WorkbenchDesktop——在模块求值期用与 workbenchMode 初始态同源的 localStorage
//   同步预读判定后立即发起 import()，与首屏渲染并行拉取 chunk，消除瀑布式加载。
//   不 await、错误吞掉（真正挂载时 Suspense 会正常重试/报错）。
//   注意与 workbenchActive 的平台护栏保持一致：移动端不预热。
try {
  if (
    typeof localStorage !== 'undefined' &&
    localStorage.getItem(WORKBENCH_MODE_CACHE_KEY) !== 'false' &&
    !isMobilePlatform()
  ) {
    void importWorkbenchDesktop().catch(() => { /* 预热失败无所谓，挂载时再拉 */ });
  }
} catch { /* localStorage 不可用（隐私模式等）则跳过预热 */ }

// ★ debugLog 别名：将本文件中的 console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
const LazyGlobalDebugPanel = React.lazy(() => import('./components/dev/GlobalDebugPanel'));
const LazyDevMobileRecoveryFab = React.lazy(() => import('./dev/DevMobileRecoveryFab'));
// Web 演示壳（demo.html/hero.html iframe）标记：由 src/demo/main.tsx 在加载 App 前置位。
// 演示环境不渲染任何开发版悬浮件（调试面板球、移动端恢复 FAB）。
const isDemoShell =
  typeof window !== 'undefined' && Boolean((window as unknown as { __DS_DEMO_SHELL__?: boolean }).__DS_DEMO_SHELL__);

/**
 * 命令面板按钮 - 用于顶部栏
 */
function CommandPaletteButton({
  className,
  onOpenReady,
}: {
  className?: string;
  onOpenReady?: (trigger: (() => void) | null) => void;
}) {
  const { open } = useCommandPalette();
  const { t } = useTranslation('common');
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  useEffect(() => {
    onOpenReady?.(open);

    return () => {
      onOpenReady?.(null);
    };
  }, [onOpenReady, open]);
  
  return (
    <CommonTooltip content={`${t('common:command_palette_label')} (${isMac ? '⌘' : 'Ctrl'}+K)`} position="bottom">
      {/* 外层标题热区本身就是可聚焦的「命令面板」按钮：内层图标按钮不再占一个 Tab 位，
          但保留无障碍名（此前为空，读屏读作无名按钮） */}
      <DsButton
        variant="ghost"
        size="icon"
        onClick={open}
        tabIndex={-1}
        aria-label={t('common:command_palette_label')}
        className={cn('desktop-shell-toolbar-button', className)}
      >
        <Terminal size={16} />
      </DsButton>
    </CommonTooltip>
  );
}

function DesktopSidebarAccessory({
  onToggle,
  label,
  collapsed,
}: {
  onToggle: () => void;
  label: string;
  collapsed: boolean;
}) {
  return (
    <div className="desktop-shell-accessory-group flex min-w-0 items-center">
      <CommonTooltip content={label} position="bottom">
        <DsButton
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="desktop-shell-toolbar-button desktop-shell-accessory-button"
          aria-label={label}
        >
          {collapsed ? <SidebarFrameIcon /> : <SidebarFrameWithLeftRailIcon />}
        </DsButton>
      </CommonTooltip>
    </div>
  );
}

function DesktopHeaderNavControls({
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onNewSession,
  onTitlebarDoubleClick,
  newSessionLabel,
  showNewSession,
  backTitle,
  backLabel,
  forwardTitle,
  forwardLabel,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onNewSession: () => void;
  onTitlebarDoubleClick: () => void | Promise<void>;
  newSessionLabel: string;
  showNewSession: boolean;
  backTitle: string;
  backLabel: string;
  forwardTitle: string;
  forwardLabel: string;
}) {
  return (
    <div
      className="desktop-shell-toolbar-group"
    >
      <CommonTooltip content={backTitle} position="bottom">
        <span className="inline-flex">
          <DsButton
            variant="ghost"
            size="icon"
            onClick={onGoBack}
            disabled={!canGoBack}
            className="desktop-shell-toolbar-button"
            aria-label={backLabel}
          >
            <CaretLeft size={16} />
          </DsButton>
        </span>
      </CommonTooltip>
      <CommonTooltip content={forwardTitle} position="bottom">
        <span className="inline-flex">
          <DsButton
            variant="ghost"
            size="icon"
            onClick={onGoForward}
            disabled={!canGoForward}
            className="desktop-shell-toolbar-button"
            aria-label={forwardLabel}
          >
            <CaretRight size={16} />
          </DsButton>
        </span>
      </CommonTooltip>
      {showNewSession ? (
        <CommonTooltip content={newSessionLabel} position="bottom">
          <DsButton
            variant="ghost"
            size="icon"
            onMouseDown={(event) => handleDesktopToolbarButtonMouseDown(event, onTitlebarDoubleClick)}
            onClick={(event) => handleDesktopToolbarButtonClick(event, onNewSession)}
            className="desktop-shell-toolbar-button"
            aria-label={newSessionLabel}
          >
            <StudyComposeIcon className="h-4 w-4" />
          </DsButton>
        </CommonTooltip>
      ) : null}
    </div>
  );
}

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
    setCurrentView(canonicalizeView(view));
    // 如果有参数，可以通过事件或其他方式传递
    void params;
  }, []);

  // ★ Workbench 产品默认身份 + 平台护栏 + 应用退出护栏（见 useWorkbenchMode）
  const { workbenchActive } = useWorkbenchMode(i18n);

  const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');
  // ★ previousView 用于模板选择返回
  const [previousView, setPreviousView] = useState<CurrentView>('chat-v2');
  // 视图切换方向（仅 <768px 的层滑动画消费；桌面是纵向淡入淡出无方向语义）。
  // 访问栈模型：目标是栈内已有视图 → 「返回」(-1)，未见过的新视图 → 「前进」(+1)。
  // 在 setCurrentView 内与视图切换同批 setState，保证动画首帧方向即正确。
  const viewNavStackRef = useRef<CurrentView[]>(['chat-v2']);
  const [viewNavDirection, setViewNavDirection] = useState<1 | -1>(1);
  const leftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);
  const leftPanelWidth = useUIStore((state) => state.leftPanelWidth);
  const shellSidebarWidth = getShellSidebarWidth(
    isSmallScreen,
    leftPanelWidth,
    typeof window === 'undefined' ? undefined : window.innerWidth
  );
  const [desktopSidebarMotionWidth, setDesktopSidebarMotionWidth] = useState<number | null>(null);
  const desktopSidebarPresentationWidth = desktopSidebarMotionWidth ?? shellSidebarWidth;
  const desktopNavigationWidth = workbenchActive
    ? 0
    : !isSmallScreen && leftPanelCollapsed ? 0 : desktopSidebarPresentationWidth;
  const desktopSidebarTranslateX = !isSmallScreen && leftPanelCollapsed ? -desktopSidebarPresentationWidth : 0;
  // Keep the visual shell visible until the sidebar's 360ms slide-out ends.
  // Layout width can close immediately, but the native material must leave the
  // titlebar and sidebar on the same frame throughout the transition.
  const isDesktopSidebarSurfaceVisible =
    !isSmallScreen
    && !workbenchActive
    && (!leftPanelCollapsed || desktopSidebarMotionWidth !== null);
  const [isDesktopSidebarResizing, setIsDesktopSidebarResizing] = useState(false);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const desktopSidebarCollapsePendingRef = useRef(false);
  const desktopFloatingAccessoryOffset = isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer + 16 : 16;
  const desktopSidebarToggleLabel = t('common:navigation.toggle_sidebar');
  const desktopSidebarResizeLabel = t('common:navigation.resize_sidebar');
  const desktopHeaderNavHotzoneLabel = t('chatV2:page.newSession');
  const desktopHeaderTitleHotzoneLabel = t('common:command_palette_label');
  const desktopHeaderIconButtonSize = 32;
  const desktopHeaderControlGap = 4;
  const desktopCollapsedControlCount = 4;
  const desktopCollapsedLeadingWidth =
    desktopHeaderIconButtonSize * desktopCollapsedControlCount
    + desktopHeaderControlGap * (desktopCollapsedControlCount - 1)
    + 16;
  const desktopTitlebarLeadingInset = !isSmallScreen && leftPanelCollapsed
    ? (isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer : 0) + 16 + desktopCollapsedLeadingWidth
    : 0;
  const { toggleDesktopWindowMaximize } = useDesktopWindowMaximizeToggle();
  // macOS traffic lights share the native titlebar with the custom shell
  // controls. The horizontal spacer reserves their hit area; adding a second
  // vertical inset would render a duplicate toolbar below the native chrome.
  // issue 472：Android 平板走桌面壳时还要避让状态栏 / 刘海 / 厂商顶部手柄条（原生注入）。
  const androidSafeArea = useAndroidSafeArea();
  const shellTitlebarTopInset = resolveShellTitlebarTopInset({
    isSmallScreen,
    isMacOS: isMacOS(),
    manualTopMargin: topbarTopMargin,
    androidSafeAreaTop: androidSafeArea?.top ?? null,
  });
  // 工作台模式：顶栏只留原生/自绘窗口控制，不占内容高度
  const shellTitlebarOccupiedHeight = workbenchActive
    ? 0
    : DESKTOP_SHELL.titlebarBaseHeight + shellTitlebarTopInset;
  const appShellCustomProperties = useMemo(() => ({
    ...getMobileShellCssVars(),
    '--sidebar-width': `${desktopNavigationWidth}px`,
    '--sidebar-expanded-width': `${desktopSidebarPresentationWidth}px`,
    '--sidebar-collapsed-width': `${desktopNavigationWidth}px`,
    '--shell-navigation-width': `${desktopNavigationWidth}px`,
    '--shell-sidebar-translate-x': `${desktopSidebarTranslateX}px`,
    '--shell-titlebar-height': `${shellTitlebarOccupiedHeight}px`,
    '--desktop-titlebar-height': `${shellTitlebarOccupiedHeight}px`,
    // 与 --shell-navigation-width 同值。该变量已注册为 <length> 自定义属性并挂在
    // app-shell 的 transition 上（app.css @property），标题栏深浅渐变分界随侧栏
    // 收起/展开逐帧联动；拖拽改宽期间由下方 setProperty 直写（过渡已被
    // data-sidebar-resizing 规则关闭），保证手柄拖动时即时跟随。
    '--shell-navigation-surface-width': `${desktopNavigationWidth}px`,
    '--shell-titlebar-content-height': `${workbenchActive ? 0 : DESKTOP_SHELL.titlebarBaseHeight}px`,
    '--topbar-safe-area': `${workbenchActive ? 0 : shellTitlebarTopInset}px`,
  }) as React.CSSProperties, [
    desktopNavigationWidth,
    desktopSidebarPresentationWidth,
    desktopSidebarTranslateX,
    shellTitlebarOccupiedHeight,
    shellTitlebarTopInset,
    workbenchActive,
  ]);
  useEffect(() => {
    if (!leftPanelCollapsed || desktopSidebarMotionWidth === null) return;

    const cleanupTimer = window.setTimeout(() => {
      setDesktopSidebarMotionWidth(null);
    }, 360);

    return () => window.clearTimeout(cleanupTimer);
  }, [desktopSidebarMotionWidth, leftPanelCollapsed]);
  const handleDesktopSidebarResizeStart = useCallback(() => {
    desktopSidebarCollapsePendingRef.current = false;
    setDesktopSidebarMotionWidth(null);
    setIsDesktopSidebarResizing(true);
  }, []);
  const handleDesktopSidebarResize = useCallback((requestedWidth: number) => {
    if (requestedWidth <= DESKTOP_SHELL.navigationCloseSnapWidth) {
      if (desktopSidebarCollapsePendingRef.current) return;

      desktopSidebarCollapsePendingRef.current = true;
      setDesktopSidebarMotionWidth(DESKTOP_SHELL.navigationMinWidth);
      appShellRef.current?.style.setProperty(
        '--shell-navigation-width',
        `${DESKTOP_SHELL.navigationMinWidth}px`
      );
      appShellRef.current?.style.setProperty(
        '--shell-navigation-surface-width',
        `${DESKTOP_SHELL.navigationMinWidth}px`
      );
      appShellRef.current?.style.setProperty(
        '--sidebar-expanded-width',
        `${DESKTOP_SHELL.navigationMinWidth}px`
      );
      appShellRef.current?.style.setProperty('--shell-sidebar-translate-x', '0px');
      setIsDesktopSidebarResizing(false);
      requestAnimationFrame(() => {
        desktopSidebarCollapsePendingRef.current = false;
        useUIStore.setState({
          leftPanelCollapsed: true,
          leftPanelWidth,
        });
      });
      return;
    }

    const layout = getShellSidebarDragLayout(
      requestedWidth,
      leftPanelWidth,
      typeof window === 'undefined' ? undefined : window.innerWidth
    );
    appShellRef.current?.style.setProperty('--shell-navigation-width', `${layout.trackWidth}px`);
    appShellRef.current?.style.setProperty('--shell-navigation-surface-width', `${layout.trackWidth}px`);
    appShellRef.current?.style.setProperty('--sidebar-expanded-width', `${layout.surfaceWidth}px`);
    appShellRef.current?.style.setProperty('--shell-sidebar-translate-x', `${layout.translateX}px`);
  }, [leftPanelWidth]);
  const handleDesktopSidebarResizeEnd = useCallback((requestedWidth: number) => {
    if (desktopSidebarCollapsePendingRef.current) return;

    const result = resolveShellSidebarResize(
      requestedWidth,
      leftPanelWidth,
      typeof window === 'undefined' ? undefined : window.innerWidth
    );

    setIsDesktopSidebarResizing(false);
    useUIStore.setState({
      leftPanelCollapsed: result.collapsed,
      leftPanelWidth: result.width,
    });
  }, [leftPanelWidth]);
  // 清理旧版本可能遗留的原生标题栏材质。标题栏左段现在与侧栏共用
  // WebView 背景，避免原生 NSVisualEffectView 覆盖自绘导航控件。
  useEffect(() => {
    if (!isSmallScreen && isMacOS()) {
      void clearNativeTitlebarSidebarMaterial();
    }
  }, [isSmallScreen]);
  const [templateManagementRefreshTick, setTemplateManagementRefreshTick] = useState(0);
  const [desktopPageSidebarTarget, setDesktopPageSidebarTarget] = useState<HTMLDivElement | null>(null);
  const [desktopPageHeaderTarget, setDesktopPageHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [desktopChatHeaderTarget, setDesktopChatHeaderTarget] = useState<HTMLDivElement | null>(null);
  const currentViewRef = useRef<CurrentView>('chat-v2');
  const isSmallScreenRef = useRef(isSmallScreen);
  const viewSwitchStartRef = useRef<{ from: CurrentView; to: CurrentView; startTime: number } | null>(null);
  
  // 🚀 性能优化：追踪已访问的页面，只渲染访问过的页面
  // 使用 Map<view, timestamp> 实现 LRU 淘汰，避免保活视图无限增长
  const [visitedViews, setVisitedViews] = useState<Map<CurrentView, number>>(
    () => new Map<CurrentView, number>([['chat-v2', Date.now()]])
  );

  useEffect(() => {
    isSmallScreenRef.current = isSmallScreen;
  }, [isSmallScreen]);

  // 包装 setCurrentView，添加视图切换追踪 + LRU 淘汰
  const setCurrentView = useCallback((newView: CurrentView | ((prev: CurrentView) => CurrentView)) => {
    const prevView = currentViewRef.current;
    const rawTargetView = typeof newView === 'function' ? newView(prevView) : newView;
    const targetView = canonicalizeView(rawTargetView);

    // 演示壳收窄：只保留主会话页交互，次级页面入口点击不响应
    //（对应 lazy 页面模块已在 vite.demo.config.ts 中 stub 剔除，不会被打包/加载）
    if (isDemoShell && targetView !== 'chat-v2') return;

    if (targetView !== prevView) {
      if (pageLifecycleTracker.isEnabled()) {
        viewSwitchStartRef.current = { from: prevView, to: targetView, startTime: performance.now() };
      }
      
      pageLifecycleTracker.log(
        'app', 
        'App.tsx', 
        'view_switch', 
        `${prevView} → ${targetView}`
      );

      // 视图切换广播：让 portal 到 body 的浮层（如输入栏组合面板）在宿主视图被隐藏时自行关闭，
      // 避免命令面板/程序化导航等无 pointerdown 的切换路径留下悬浮残影
      dispatchAppEvent(APP_EVENTS.VIEW_SWITCHED, { from: prevView, to: targetView });
    }

    // 使用 startTransition 将 LRU 更新 + 视图切换 打包在同一个 transition 中。
    // 导航历史由 useNavigationHistory 的 useEffect 推入（始终基于 committed state，避免快速点击竞态）。
    startTransition(() => {
      // 切换方向：与视图切换同批提交，层动画首帧即拿到正确方向（前进右入/后退左入镜像）
      advanceViewNavStack(viewNavStackRef.current, prevView, targetView, setViewNavDirection);

      // 🚀 LRU 更新：记录访问时间戳，超过阈值时淘汰最久未访问的非 pinned 视图
      setVisitedViews(prev => computeNextVisitedViews(prev, targetView));
      setCurrentViewRaw(targetView);
    });
  }, []);

  // 启动恢复回执跳转设置页；UI Lab 关闭时退出 ui-lab 视图
  const { uiLabEnabled } = useViewRedirects(currentView, setCurrentView);

  // ★ 移动端顶栏活跃视图同步已移至 MobileHeaderActiveViewSync 组件

  useEffect(() => {
    currentViewRef.current = currentView;
    // 闪卡中心：记住最近访问的分区，侧栏「闪卡」入口点击时回到这里
    rememberCardsHubView(currentView);
    // Publish committed navigation only; external-store writes cannot be deferred by startTransition.
    useViewStore.getState().setCurrentView(currentView);

    if (currentView === 'learning-hub') {
      setActiveOpenResourceHandler('learning-hub');
    } else if (currentView === 'chat-v2') {
      setActiveOpenResourceHandler('chat-v2');
    }

    // 调试追踪关闭时不安排双 RAF。生产环境每次导航都安排两帧回调，
    // 即使 tracker 不消费事件，也会把测量工作叠加到用户的切换路径上。
    if (!pageLifecycleTracker.isEnabled()) {
      viewSwitchStartRef.current = null;
      return;
    }

    // 记录视图切换完成和渲染耗时
    if (viewSwitchStartRef.current && viewSwitchStartRef.current.to === currentView) {
      const { from, to, startTime } = viewSwitchStartRef.current;
      const reactDuration = Math.round(performance.now() - startTime);
      
      pageLifecycleTracker.log(
        'app',
        'App.tsx',
        'render_end',
        `React: ${reactDuration}ms | ${from} → ${to}`,
        { duration: reactDuration }
      );
      
      // 使用 requestAnimationFrame 测量真正的浏览器渲染完成时间
      const rafStart = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const paintDuration = Math.round(performance.now() - startTime);
          const rafDelta = Math.round(performance.now() - rafStart);
          pageLifecycleTracker.log(
            'app',
            'App.tsx',
            'custom',
            `Paint完成: ${paintDuration}ms (RAF: ${rafDelta}ms) | ${from} → ${to}`,
            { duration: paintDuration }
          );
        });
      });
      
      viewSwitchStartRef.current = null;
    }
  }, [currentView]);
  const [textbookReturnContext, setTextbookReturnContext] = useState<{ view: CurrentView; payload?: any } | null>(null);
  const textbookReturnContextRef = useRef<typeof textbookReturnContext>(null);
  useEffect(() => {
    textbookReturnContextRef.current = textbookReturnContext;
  }, [textbookReturnContext]);

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
  
  // [Phase 3 清理] 教材侧栏状态已迁移到 TextbookContext
  // 旧的 useState、事件监听、回调函数已移除，现在由以下组件统一处理：
  // - TextbookProvider (App 顶层) - 状态管理
  // - TextbookEventBridge - 事件桥接
  // - AnalysisViewWithTextbook - 布局和渲染
  const textbookMaxPages = 12;
  const textbookExportScale = 2.0;
  const textbookExportConcurrency = 2;

  // 前端错误采集：记录到事件模式（channel='error', eventName='frontend_error'）
  useFrontendErrorCapture();

  // Milkdown / Notes / 新建桥接 / Crepe demo 壳层导航监听；跨页「在学习资源中打开 X」
  const { openInLearningHub } = useShellNavigationEvents(setCurrentView);

  // 媒体时间戳引用（`[媒体@id:mm:ss]`，闪卡来源按钮、笔记锚点等）：经典壳下除聊天页外
  // 一律在「音视频」学习页打开并跳转（docs/dev/media-learning §0.5）。聊天页自己处理（右侧
  // 附件面板，见 useChatPageEvents）；这里不依赖聊天页挂载——触屏 LRU 可能已淘汰它，否则从
  // 其它页面点击会无响应或在隐藏的聊天面板里出声。跳转只投给子应用学习页的播放器
  // （targetScopeId），资源库保活标签里同一媒体不会抢走 seek；学习页就绪晚于重发窗口时
  // 由媒体视图领取待兑现意图兜底（mediaRefEvents）。
  const handleMediaRefOpen = useCallback((event: Event) => {
    if (workbenchBus.isEnabled() || currentViewRef.current === 'chat-v2') return;
    const { resourceId, seconds } = (event as CustomEvent<{ resourceId?: string; seconds?: number }>).detail ?? {};
    if (!resourceId || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return;
    void Promise.all([
      import('@/features/media-studio/mediaStudioNavigation'),
      import('@/features/learning-hub/apps/views/media/mediaRefEvents'),
    ]).then(([{ openMediaStudio, MEDIA_STUDIO_FOCUS_SCOPE }, { requestMediaFocusUntilHandled }]) => {
      openMediaStudio(resourceId);
      requestMediaFocusUntilHandled({ resourceId, seconds, targetScopeId: MEDIA_STUDIO_FOCUS_SCOPE });
    });
  }, []);
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

    const targetView = canonicalizeView(detail.view);
    setTextbookReturnContext(null);

    if (targetView !== currentViewRef.current) {
      setCurrentView(targetView);
    }

    if (detail.openResource && targetView === 'learning-hub' && !workbenchBus.isEnabled()) {
      requestLearningHubIntent(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, { dstuPath: detail.openResource });
    }
  }, [setCurrentView, setTextbookReturnContext]);

  useEventRegistry([
    {
      target: 'window',
      type: APP_EVENTS.NAVIGATE_TO_VIEW,
      listener: toAppEventListener(handleNavigateToView),
    },
  ], [handleNavigateToView]);

  // ★ 分析模式已废弃（旧错题系统已移除）

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
  }, [setCurrentView]);

  // F1（移动端审计）：移动端统一顶栏的返回兜底。
  // dashboard / data-management / pdf-reader / sandbox-workbench
  // 等视图没有 ☰ 抽屉入口，左上角只有全局历史返回按钮；
  // 历史为空时按钮会消失，页面失去唯一出口。这里保证非 chat-v2 视图始终
  // 显示返回按钮：有历史走历史后退，无历史回 chat-v2 主视图。
  // （注册了 showMenu/showBackArrow 的页面优先级更高，不受影响。）
  const mobileHeaderCanGoBack = unifiedCanGoBack || currentView !== 'chat-v2';
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

  // 📜 自动保存和恢复列表页滚动位置（扩展到所有主要视图）
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
  }, []);

  // ★ Bridge 会话上下文已废弃（2026-01 清理）

  // ★ irec 相关回调已废弃（图谱模块已移除）
  // handleNavigateToAnalysisFromIrec, handleNavigateToGraph, handleJumpToGraphCard,
  // handleNavigateToMistake, handleNavigateToIrecFromMistake, irecAnalysisData cleanup

  // 跨功能交接：试卷 / 翻译 / 作文 / 笔记 → 学习资源页，DSTU_OPEN_NOTE（经典壳），预填聊天输入
  useCrossFeatureHandoffs(openInLearningHub, setCurrentView);

  // 处理页面切换（useCallback 稳定引用，避免 ModernSidebar 每次重渲染）
  const handleViewChange = useCallback((newView: CurrentView) => {
    // 如果切换到模板管理页面，且不是从 Anki 制卡页面进入的，清除选择模板状态
    if (newView === 'template-management' && currentViewRef.current !== 'task-dashboard') {
      setIsSelectingTemplate(false);
      setTemplateSelectionCallback(null);
    }

    setCurrentView(newView);
  }, [setCurrentView]);

  // P1-7: 移动抽屉导航回调。Android 键盘弹出/输入框聚焦期间屏蔽导航，防止
  // 键盘引发的 resize/blur 连锁误触发"输入中被跳转"（社区 issue 113 bug 1/3）。
  // 经 MobileAppNavigationProvider 直连注入 MobileSidebarNavigation；下方的
  // 全局事件监听仅作为无 Provider 场景的兼容回退，两条路径共用同一守卫。
  // 返回 false 表示导航被拦截（抽屉侧据此保持展开，不产生"点了没反应还关菜单"）
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

  // 历史管理已迁移到 useNavigationHistory Hook

  // 开发者工具快捷键支持 (仅生产模式，仅 Ctrl+Shift+I / Cmd+Alt+I)
  useDevtoolsShortcut();

  // 模板管理状态
  const [isSelectingTemplate, setIsSelectingTemplate] = useState(false);
  const [templateSelectionCallback, setTemplateSelectionCallback] = useState<((template: any) => void) | null>(null);

  // 开发功能设置状态
  // 移除：Gemini 适配器测试开关

  // App组件状态变化（已禁用日志）
  const { startDragging } = useWindowDrag();
  
  
  // 🔧 定期持久化 WebView 设置，确保自动备份可获取
  useWebviewSettingsPersistence();

  // 处理模板选择请求
  const handleTemplateSelectionRequest = useCallback((callback: (template: any) => void) => {
    setPreviousView(currentView);
    setTemplateSelectionCallback(() => callback);
    setIsSelectingTemplate(true);
    setCurrentView('template-management');
  }, [currentView]);

  // 处理模板选择完成
  const handleTemplateSelected = useCallback((template: any) => {
    if (templateSelectionCallback) {
      templateSelectionCallback(template);
    }
    setIsSelectingTemplate(false);
    setTemplateSelectionCallback(null);
    setCurrentView(previousView);
  }, [templateSelectionCallback, previousView]);

  // 取消模板选择
  const handleTemplateSelectionCancel = useCallback(() => {
    setIsSelectingTemplate(false);
    setTemplateSelectionCallback(null);
    setCurrentView(previousView);
  }, [previousView]);

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
  const shouldShowDesktopPageBackButton = currentView === 'learning-hub';
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
  const desktopShellSidebarKind = currentView === 'settings'
    ? 'settings'
    : currentView === 'todo'
    ? 'todo'
    : currentView === 'learning-hub'
    ? 'desktop-page'
    : 'main';
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
  const {
    navigationShortcuts,
    commandPaletteTriggerRef,
    handleDesktopTitlebarMouseDown,
    handleHeaderHotzoneMouseDown,
    handleHeaderHotzoneMouseMove,
    handleHeaderHotzoneMouseUp,
    handleHeaderHotzoneMouseLeave,
    handleCreateChatSession,
    openCommandPalette,
  } = useDesktopTitlebarInteractions(startDragging, toggleDesktopWindowMaximize, currentView, setCurrentView);
  const [currentChatHeaderTitle, setCurrentChatHeaderTitle] = useState('');
  const [currentChatHeaderGroupName, setCurrentChatHeaderGroupName] = useState('');
  const [currentChatHeaderSessionId, setCurrentChatHeaderSessionId] = useState<string | null>(null);
  const currentChatHeaderStoreUnsubscribeRef = useRef<(() => void) | null>(null);
  const currentChatHeaderSubscribedSessionIdRef = useRef<string | null>(null);
  // ★ P3 handoff · 经典壳 → Workbench 消费侧（会话内 workbenchActive false→true 时在桌面重开同一资源）
  useClassicToWorkbenchHandoff(workbenchActive, currentView, currentChatHeaderSessionId);
  const desktopHeaderNewSessionTooltipLabel = currentChatHeaderGroupName
    ? t('chatV2:page.newSessionInGroup', {
      groupName: currentChatHeaderGroupName,
    })
    : desktopHeaderNavHotzoneLabel;
  const shouldShowDesktopSidebarToggle = currentView !== 'settings';
  const shouldShowDesktopHeaderNavControls = currentView !== 'settings' && currentView !== 'todo';
  const handleDesktopSidebarToggle = useCallback(() => {
    // Preserve the current native surface width while the sidebar slides out.
    // Opening can reveal both layers immediately because the sidebar is already
    // at its target position when the collapsed state is removed.
    setDesktopSidebarMotionWidth(leftPanelCollapsed ? null : shellSidebarWidth);
    useUIStore.getState().toggleLeftPanel();
  }, [leftPanelCollapsed, shellSidebarWidth]);
  const desktopHeaderNavControls = (
    <DesktopHeaderNavControls
      canGoBack={unifiedCanGoBack}
      canGoForward={unifiedCanGoForward}
      onGoBack={unifiedGoBack}
      onGoForward={unifiedGoForward}
      onNewSession={handleCreateChatSession}
      onTitlebarDoubleClick={toggleDesktopWindowMaximize}
      newSessionLabel={desktopHeaderNewSessionTooltipLabel}
      showNewSession={leftPanelCollapsed}
      backTitle={t('common:navigation.back_tooltip', { shortcut: navigationShortcuts.back })}
      backLabel={t('common:navigation.back')}
      forwardTitle={t('common:navigation.forward_tooltip', { shortcut: navigationShortcuts.forward })}
      forwardLabel={t('common:navigation.forward')}
    />
  );
  const desktopSidebarTopAccessoryContent = (
    <div className="flex min-w-0 items-center gap-1.5">
      {shouldShowDesktopSidebarToggle ? (
        <DesktopSidebarAccessory
          onToggle={handleDesktopSidebarToggle}
          label={desktopSidebarToggleLabel}
          collapsed={leftPanelCollapsed}
        />
      ) : null}
      {shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}
    </div>
  );

  const clearCurrentChatHeaderStoreSubscription = useCallback(() => {
    currentChatHeaderStoreUnsubscribeRef.current?.();
    currentChatHeaderStoreUnsubscribeRef.current = null;
    currentChatHeaderSubscribedSessionIdRef.current = null;
  }, []);

  const getChatHeaderTitleFromStoreState = useCallback((state?: ChatStore | null) => {
    if (!state) {
      return '';
    }

    if (getHiddenDraftSessionScope(state?.sessionMetadata)) {
      return '';
    }

    // 空标题代表尚未命名的当前会话；壳层保持标题区域为空，避免把
    // “未命名会话”误呈现为新会话的真实标题。
    return getSessionTitleText(state.title, '');
  }, [t]);

  const getChatHeaderGroupNameFromStoreState = useCallback((state?: ChatStore | null) => {
    if (!state?.groupId) {
      return '';
    }

    return groupCache.get(state.groupId)?.name ?? '';
  }, []);

  const syncCurrentChatHeaderTitle = useCallback((sessionId?: string | null) => {
    const chatHeaderSessionId = sessionId ?? sessionManager.getCurrentSessionId();
    if (!chatHeaderSessionId) {
      setCurrentChatHeaderSessionId(null);
      setCurrentChatHeaderTitle('');
      setCurrentChatHeaderGroupName('');
      return;
    }

    const chatHeaderStore = sessionManager.get(chatHeaderSessionId);
    setCurrentChatHeaderSessionId(chatHeaderSessionId);
    setCurrentChatHeaderTitle(getChatHeaderTitleFromStoreState(chatHeaderStore?.getState()));
    setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(chatHeaderStore?.getState()));
  }, [getChatHeaderGroupNameFromStoreState, getChatHeaderTitleFromStoreState, t]);

  const saveCurrentChatHeaderTitle = useCallback(async (sessionId: string, title: string) => {
    await invoke('chat_v2_update_session_settings', {
      sessionId,
      settings: { title },
    });

    sessionManager.get(sessionId)?.setState({ title });
    window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
  }, []);

  useEffect(() => {
    const bindCurrentChatHeaderStore = (sessionId: string | null) => {
      if (!sessionId) {
        clearCurrentChatHeaderStoreSubscription();
        return;
      }

      if (currentChatHeaderSubscribedSessionIdRef.current === sessionId) {
        return;
      }

      clearCurrentChatHeaderStoreSubscription();

      const activeChatHeaderStore = sessionManager.get(sessionId);
      if (!activeChatHeaderStore) {
        return;
      }

      currentChatHeaderSubscribedSessionIdRef.current = sessionId;
      currentChatHeaderStoreUnsubscribeRef.current = activeChatHeaderStore.subscribe(
        (state, prevState) => {
          if (
            state.title !== prevState.title ||
            state.sessionMetadata !== prevState.sessionMetadata ||
            state.groupId !== prevState.groupId
          ) {
            setCurrentChatHeaderTitle(getChatHeaderTitleFromStoreState(state));
            setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(state));
          }
        }
      );
    };

    const syncAndBindCurrentChatHeader = (sessionId: string | null = sessionManager.getCurrentSessionId()) => {
      bindCurrentChatHeaderStore(sessionId);
      syncCurrentChatHeaderTitle(sessionId);
    };

    syncAndBindCurrentChatHeader();

    const unsubscribeSessionManager = sessionManager.subscribe((event) => {
      if (event.type === 'current-session-changed') {
        syncAndBindCurrentChatHeader(sessionManager.getCurrentSessionId());
        return;
      }

      const activeSessionId = sessionManager.getCurrentSessionId();
      if (!activeSessionId) {
        syncAndBindCurrentChatHeader(null);
        return;
      }

      if (event.sessionId === activeSessionId && event.type === 'session-created') {
        syncAndBindCurrentChatHeader(activeSessionId);
        return;
      }

      if (event.sessionId === activeSessionId && (event.type === 'session-destroyed' || event.type === 'session-evicted')) {
        syncAndBindCurrentChatHeader(activeSessionId);
      }
    });

    return () => {
      unsubscribeSessionManager();
      clearCurrentChatHeaderStoreSubscription();
    };
  }, [
    clearCurrentChatHeaderStoreSubscription,
    getChatHeaderGroupNameFromStoreState,
    getChatHeaderTitleFromStoreState,
    syncCurrentChatHeaderTitle,
    t,
  ]);

  const syncCurrentChatHeaderGroupName = useCallback(() => {
    const chatHeaderSessionId = sessionManager.getCurrentSessionId();
    if (!chatHeaderSessionId) {
      setCurrentChatHeaderGroupName('');
      return;
    }

    const chatHeaderStore = sessionManager.get(chatHeaderSessionId);
    setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(chatHeaderStore?.getState()));
  }, [getChatHeaderGroupNameFromStoreState]);

  useAppEvent(APP_EVENTS.CHAT_GROUPS_UPDATED, () => {
    syncCurrentChatHeaderGroupName();
  }, [syncCurrentChatHeaderGroupName]);

  // 壳层标题（桌面标题栏 / 移动端兜底标题）与闪卡中心移动端分区条
  const { desktopShellViewLabel, cardsHubMobileTabs } = useShellViewChrome(
    currentView,
    currentChatHeaderTitle,
    t,
    isSmallScreen,
    handleMobileAppNavigate,
  );

  // 🚀 性能优化：各视图内容 useMemo 收口（见 app/hooks/useViewLayerContents）；
  // task-dashboard / data-management 依赖 App 内 state setter，留在下方
  const { dashboardContent, settingsContent } = useDashboardAndSettingsContents(
    currentView,
    isSmallScreen,
    setCurrentView,
  );

  const taskDashboardContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <AnkiTasksApp
        onNavigateToChat={(sessionId) => {
          setCurrentView('chat-v2');
          dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_SESSION, { sessionId });
        }}
        onOpenChat={() => setCurrentView('chat-v2')}
        onOpenTemplateManagement={() => {
          setIsSelectingTemplate(false);
          setCurrentView('template-management');
        }}
      />
    </Suspense>
  ), [setCurrentView]);

  const {
    skillsManagementContent,
    flashcardsContent,
    mediaStudioContent,
    styleDebugContent,
    learningHubContent,
    pdfReaderContent,
    chatV2Content,
    templateManagementContent,
  } = useFeatureViewContents(
    currentView,
    chatV2Blocked,
    t,
    isSelectingTemplate,
    handleTemplateSelected,
    handleTemplateSelectionCancel,
    templateManagementRefreshTick,
  );

  // data-management: 依赖仅在导入对话框打开/语言切换时变化
  const dataManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyDataImportExport onBack={() => setCurrentView('chat-v2')} />
      <LazyImportConversationDialog
        open={showImportConversation}
        onOpenChange={setShowImportConversation}
        onImportSuccess={handleImportConversationSuccess}
      />
    </Suspense>
  ), [showImportConversation, handleImportConversationSuccess, setCurrentView]);

  const {
    todoContent,
    sandboxWorkbenchContent,
    crepeDemoContent,
    chatV2TestContent,
    llmPlaygroundContent,
  } = useAuxiliaryViewContents(setCurrentView);

  // 🚀 使用抽取的 ViewLayerRenderer 组件
  const renderViewLayer = (
    view: CurrentView,
    content: React.ReactNode,
    extraClass?: string,
    extraStyle?: React.CSSProperties
  ) => (
    <ViewLayerRenderer
      view={view}
      currentView={currentView}
      visitedViews={visitedViews}
      errorBoundaryName={view}
      navDirection={viewNavDirection}
      extraClass={extraClass}
      extraStyle={extraStyle}
    >
      {content}
    </ViewLayerRenderer>
  );

  // 保留初始化逻辑，但不阻塞渲染，不再显示覆盖式载入页

  // 🔍 诊断：分离调度延迟 vs 渲染时间（找出 200-400ms 的真正来源）
  useEffect(() => {
    if (!viewSwitchStartRef.current || viewSwitchStartRef.current.to !== currentView) return;
    const hooksMs = Math.round(performance.now() - viewSwitchStartRef.current.startTime);
    pageLifecycleTracker.log('app', 'App.tsx', 'custom', `⏱ Hooks+调度: ${hooksMs}ms | ${viewSwitchStartRef.current.from} → ${currentView}`);
  }, [currentView]);

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
    <CommandPaletteProvider
        currentView={currentView}
        workbenchActive={workbenchActive}
        navigate={commandPaletteNavigate}
        toggleTheme={toggleDarkMode}
        isDarkMode={isDarkMode}
        switchLanguage={switchLanguage}
      >
      <AgentBridge workbenchActive={workbenchActive} />
      <TextContextMenuProvider>
      <MobileLayoutProvider>
      <MobileAppNavigationProvider navigate={handleMobileAppNavigate}>
      <MobileHeaderProvider>
      {/* ★ 移动端顶栏活跃视图同步 - 必须在 MobileHeaderProvider 内部 */}
      <MobileHeaderActiveViewSync activeView={currentView} />
      <MobileHeaderNavProvider
        value={{
          canGoBack: mobileHeaderCanGoBack,
          onBack: handleMobileHeaderBack,
          canGoForward: unifiedCanGoForward,
          onForward: unifiedGoForward,
          fallbackTitle: desktopShellViewLabel,
          accessory: cardsHubMobileTabs,
        }}
      >
      <LearningHubNavigationProvider>
      <DesktopShellSidebarPortalProvider value={desktopShellSidebarPortalValue}>
      <DesktopShellHeaderPortalProvider value={desktopShellHeaderPortalValue}>
      <div
        ref={appShellRef}
        data-shell-role="app-shell"
        data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}
        data-sidebar-resizing={isDesktopSidebarResizing ? 'true' : 'false'}
        className={cn(
          'relative flex h-dvh w-full overflow-hidden font-sans text-foreground'
          // 背景由 src/shared/styles/app.css 的 [data-shell-role="app-shell"] 规则根据 data-sidebar-visible
          // 切换到 --shell-navigation-surface / --shell-backdrop，保证工作区左下凹角
          // 透出的颜色与侧边栏严格同源，避免主题切换时出现色差（与左上凹角一致）。
          //
          // 注意：刻意不在此层加 `transition-colors duration-500`。
          // 工作区圆角凹陷处会透出本层背景；如果本层做颜色过渡，而相邻的 workspace、
          // titlebar 是瞬间变色，主题切换中间帧就会出现色差（左下凹角白底闪烁问题）。
          // 业界最佳实践（ Linear / VS Code）：主题切换瞬间生效，避免接缝问题。
        )}
        style={appShellCustomProperties}
      >
        {/* Skip navigation link for keyboard accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[9999] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:text-sm focus:font-medium focus:shadow-lg"
        >
          {t('common:aria.skip_to_main_content')}
        </a>

        {/* 桌面端：固定顶部栏。工作台模式不渲染——窗口拖拽与 Win 三键
            全部由 Workbench StatusBar（wb-menubar）接管。 */}
        {!isSmallScreen && !workbenchActive && (
        <header
          data-shell-layer="window-chrome"
          data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}
          className="desktop-shell-titlebar fixed top-0 left-0 right-0 flex motion-reduce:transition-none"
          style={{
            zIndex: Z_INDEX.desktopTitlebar,
            paddingTop: `${shellTitlebarTopInset}px`,
            height: `${shellTitlebarOccupiedHeight}px`,
            minHeight: `${shellTitlebarOccupiedHeight}px`,
          }}
          onMouseDown={handleDesktopTitlebarMouseDown}
        >
            <>
              <div
                className="desktop-shell-sidebar-top-accessory"
                data-no-drag
                style={{
                  left: `${desktopFloatingAccessoryOffset}px`,
                  top: `${shellTitlebarTopInset}px`,
                  height: `${DESKTOP_SHELL.titlebarBaseHeight}px`,
                }}
              >
                <div className="pointer-events-auto inline-flex h-full items-center">
                  {desktopSidebarTopAccessoryContent}
                </div>
              </div>

              <div
                className={cn(
                  'desktop-shell-header-cell desktop-shell-header-cell--nav relative z-10 flex min-w-0 shrink-0 items-center justify-end overflow-hidden',
                  leftPanelCollapsed ? 'px-0' : 'px-4'
                )}
                style={{
                  width: 'var(--shell-navigation-width)',
                }}
              >
                <div
                  className="desktop-shell-header-hotzone absolute inset-0 z-0 flex min-w-0 items-center justify-end"
                  data-no-drag
                  data-shell-hotzone="desktop-nav"
                  role="button"
                  tabIndex={0}
                  aria-label={desktopHeaderNewSessionTooltipLabel}
                  onMouseDown={handleHeaderHotzoneMouseDown}
                  onMouseMove={handleHeaderHotzoneMouseMove}
                  onMouseUp={handleHeaderHotzoneMouseUp}
                  onMouseLeave={handleHeaderHotzoneMouseLeave}
                  onClick={(event) => handleHeaderHotzoneClick(event, handleCreateChatSession)}
                  onKeyDown={(event) => handleHeaderHotzoneKeyDown(event, handleCreateChatSession)}
                >
                  {isMacOS() && <div className="flex-shrink-0" style={{ width: DESKTOP_SHELL.macTrafficLightsSpacer }} />}
                </div>
              </div>

              <div
                data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}
                className="desktop-shell-header-cell desktop-shell-header-cell--workspace relative z-10 flex flex-1 min-w-0 items-center justify-between px-5"
                style={{ paddingLeft: `${20 + desktopTitlebarLeadingInset}px` }}
              >
                {currentView === 'learning-hub' || currentView === 'todo' || currentView === 'skills-management' || currentView === 'media' ? (
                  <div
                    ref={setDesktopPageHeaderTarget}
                    className="h-full min-w-0 flex-1"
                    data-no-drag
                    data-shell-slot={currentView === 'learning-hub' ? 'learning-hub-toolbar' : currentView === 'todo' ? 'todo-toolbar' : currentView === 'media' ? 'media-toolbar' : 'skills-toolbar'}
                  />
                ) : currentView === 'chat-v2' && currentChatHeaderSessionId && currentChatHeaderTitle ? (
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <CommandPaletteButton onOpenReady={(trigger) => { commandPaletteTriggerRef.current = trigger; }} />
                    <div className="min-w-0 flex-1 pl-1" data-no-drag>
                      <DesktopShellTitleEditor
                        key={currentChatHeaderSessionId}
                        sessionId={currentChatHeaderSessionId}
                        title={desktopShellViewLabel}
                        renameLabel={t('chatV2:page.renameSession')}
                        emptyTitleError={t('chatV2:page.renameEmptyError')}
                        saveError={t('chatV2:page.renameFailed')}
                        onSave={saveCurrentChatHeaderTitle}
                        className="desktop-shell-header-title"
                      />
                    </div>
                    {/* goal 模式 P0：会话目标状态 chip（goal 为 null 时自渲染空） */}
                    <GoalStatusChip sessionId={currentChatHeaderSessionId} />
                  </div>
                ) : (
                  <div
                    className="desktop-shell-header-hotzone flex min-w-0 items-center gap-3"
                    data-no-drag
                    data-shell-hotzone="desktop-title"
                    role="button"
                    tabIndex={0}
                    aria-label={desktopHeaderTitleHotzoneLabel}
                    onMouseDown={handleHeaderHotzoneMouseDown}
                    onMouseMove={handleHeaderHotzoneMouseMove}
                    onMouseUp={handleHeaderHotzoneMouseUp}
                    onMouseLeave={handleHeaderHotzoneMouseLeave}
                    onClick={(event) => handleHeaderHotzoneClick(event, openCommandPalette)}
                    onKeyDown={(event) => handleHeaderHotzoneKeyDown(event, openCommandPalette)}
                  >
                    <CommandPaletteButton onOpenReady={(trigger) => { commandPaletteTriggerRef.current = trigger; }} />

                    <div className="min-w-0 flex-1 pl-1">
                      <div className="min-w-0 desktop-shell-header-title">
                        <TextSwap
                          text={desktopShellViewLabel}
                          className="block max-w-full truncate"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* 闪卡中心分区切换：放在标题热区之外（热区点击会打开命令面板） */}
                {isCardsHubView(currentView) ? (
                  <CardsHubTabs
                    variant="titlebar"
                    currentView={currentView}
                    onNavigate={handleViewChange}
                    className="ml-3"
                  />
                ) : null}

                <div
                  ref={setDesktopChatHeaderTarget}
                  className="flex h-full min-w-0 flex-1 items-center justify-end"
                  data-no-drag
                  data-shell-slot="chat-search"
                />

                <div className="flex shrink-0 items-center gap-2" data-no-drag>
                  {isWindows() && <WindowControls />}
                </div>
              </div>
            </>
        </header>
        )}

        {/* 桌面端：主导航侧边栏（workbench 模式下隐藏，导航职责移交 Dock，设计 §3.1） */}
        {!isSmallScreen && !workbenchActive ? (
          <div
            className="desktop-shell-sidebar-track t-resize"
            style={{ width: 'var(--shell-navigation-width)' }}
          >
            <div className="desktop-shell-sidebar-motion-surface">
              <DesktopShellSidebarLayers
                activeKind={desktopShellSidebarKind}
                layers={desktopShellSidebarLayers}
              />
            </div>
          </div>
        ) : null}

        {!isSmallScreen && !workbenchActive && !leftPanelCollapsed ? (
          <DesktopSidebarResizeHandle
            label={desktopSidebarResizeLabel}
            width={desktopNavigationWidth}
            minWidth={DESKTOP_SHELL.navigationMinWidth}
            maxWidth={getShellSidebarMaxWidth(typeof window === 'undefined' ? undefined : window.innerWidth)}
            onResizeStart={handleDesktopSidebarResizeStart}
            onResize={handleDesktopSidebarResize}
            onResizeEnd={handleDesktopSidebarResizeEnd}
          />
        ) : null}

        <div
          data-shell-layer="workspace"
          data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}
          className="desktop-shell-workspace flex flex-1 flex-col h-full min-w-0 relative overflow-hidden"
          style={{
            // 移动端：48px 基础高度 + topbarTopMargin；工作台：顶栏不占位；其余桌面：标题栏高度
            paddingTop: isSmallScreen
              ? 0
              : workbenchActive
                ? 0
                : `${shellTitlebarOccupiedHeight}px`,
          }}
        >
          <MigrationStatusBanner />

          {/* 🆕 维护模式全局横幅 */}
          {maintenanceMode && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm"
            >
              <Warning size={16} className="shrink-0" />
              <span className="font-medium shrink-0">{t('common:maintenance.banner_title')}</span>
              <span className="flex-1 truncate">
                {maintenanceReason || t('common:maintenance.banner_description')}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                className="shrink-0 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
                onClick={() => {
                  if (maintenanceRequiresRestart) {
                    void (async () => {
                      try {
                        await TauriAPI.restartApp();
                        if (import.meta.env.DEV) window.location.reload();
                      } catch (error: unknown) {
                        showGlobalNotification(
                          'error',
                          getErrorMessage(error),
                          t('common:maintenance.restart_failed'),
                        );
                      }
                    })();
                    return;
                  }
                  if (currentView === 'settings') {
                    // 已在设置页面，直接通过事件切换到数据治理标签
                    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'data-governance' });
                  } else {
                    setPendingSettingsTab('data-governance');
                    setCurrentView('settings');
                  }
                }}
              >
                {t(
                  maintenanceRequiresRestart
                    ? 'common:maintenance.restart_now'
                    : 'common:maintenance.go_to_data_governance',
                )}
              </DsButton>
            </div>
          )}

          <main
            id="main-content"
            role="main"
            className={cn(
              "flex-1 relative overflow-hidden w-full"
            )}
            data-tour-id="analysis-main"
          >
            <div
              ref={contentBodyRef}
              className={cn(
                'content-body w-full h-full relative',
                currentView === 'settings' && 'settings-view',
                // 学习桌面大量 transform（视差/Dock/AppsPanel）；content-body 的
                // contain:layout 会在 WebView2 上裁错合成脏区，表现为半屏撕裂。
                workbenchActive && 'content-body--workbench',
              )}
            >
              {workbenchActive ? (
              /* ★ Workbench 学习桌面：独立 lazy chunk，替换整个视图层；
                 关闭开关即卸载整棵树回到下方 legacy 视图（布局快照保留在磁盘） */
              <Suspense fallback={<PageLoadingFallback />}>
                <LazyWorkbenchDesktop />
              </Suspense>
              ) : (
              <>
              {/* ★ 废弃视图已移除（2026-01 清理）：analysis, library, exam-sheet */}

              {renderViewLayer('dashboard', dashboardContent, 'overflow-hidden')}

              {renderViewLayer('settings', settingsContent, 'overflow-hidden')}

              {/* 🎯 Phase 5 清理：mistake-detail 视图已移除，统一由 ChatViewWithSidebar 处理 */}
              {/* 🎯 2026-01: llm-usage-stats 视图已移除，统计数据已整合到 DataStats 页面 */}

              {/* 制卡任务管理页面 */}
              {renderViewLayer('task-dashboard', taskDashboardContent)}
              {/* anki-generation 已通过 canonicalView.ts 重定向到 task-dashboard */}

              {renderViewLayer('skills-management', skillsManagementContent)}

              {/* ★ 记忆内化已废弃（图谱模块已移除） */}

              {renderViewLayer('data-management', dataManagementContent)}

              {renderViewLayer('template-management', templateManagementContent)}

              {uiLabEnabled && renderViewLayer('ui-lab', styleDebugContent)}

              {/* ★ 废弃视图已移除（2026-01 清理）：irec, irec-management, irec-service-switcher, math-workflow */}

              {/* 笔记模块已整合到 Learning Hub，通过 DSTU 协议访问；历史 NotesHome 视图已下线删除 */}

              {/* Learning Hub 学习资源全屏模式（已整合教材库功能） */}
              {renderViewLayer('learning-hub', learningHubContent)}

              {/* 音视频（资源库音视频的专用视角） */}
              {renderViewLayer('media', mediaStudioContent)}

              {renderViewLayer('sandbox-workbench', sandboxWorkbenchContent)}

              {renderViewLayer('pdf-reader', pdfReaderContent)}

              {/* 待办事项独立页面 */}
              {renderViewLayer('todo', todoContent)}

              {/* 闪卡复习（传统壳入口） */}
              {renderViewLayer('flashcards', flashcardsContent)}

              {import.meta.env.DEV && renderViewLayer('crepe-demo', crepeDemoContent)}

              {import.meta.env.DEV && renderViewLayer('chat-v2-test', chatV2TestContent)}

              {import.meta.env.DEV && renderViewLayer('llm-playground', llmPlaygroundContent)}

              {/* Chat V2 正式入口 */}
              {renderViewLayer('chat-v2', chatV2Content)}

              {/* ★ 废弃视图已移除（2026-01 清理）：bridge-to-irec */}
              </>
              )}

            </div>
          </main>
        </div>

      </div>
      {/* CmdK 由 Notes 模块内部管理 */}
      {/* 全局通知容器 */}
      <NotificationContainer />

      {/* 云存储配置弹窗 - 移到全局位置避免被 renderViewLayer 的 visibility 影响 */}
      <DsDialog open={showCloudStorageSettings} onOpenChange={setShowCloudStorageSettings} maxWidth="max-w-[560px]">
        <DsDialogBody>
          <Suspense fallback={<PageLoadingFallback />}>
            <CloudStorageSection isDialog />
          </Suspense>
        </DsDialogBody>
      </DsDialog>
      {/* 全局悬浮调试面板（按需懒加载，避免生产首包引入调试模块）；演示壳不出现 */}
      {debugPanelRequested && !isDemoShell && (
        <Suspense fallback={null}>
          <LazyGlobalDebugPanel openRequest={debugPanelOpenRequest} />
        </Suspense>
      )}

      {import.meta.env.DEV && isSmallScreen && !isDemoShell && (
        <Suspense fallback={null}>
          <LazyDevMobileRecoveryFab />
        </Suspense>
      )}

      {/* 命令面板 */}
      <CommandPalette />

      {/* Global Pomodoro Timer（workbench 激活时药丸让位给菜单栏/番茄窗投射） */}
      <GlobalPomodoroWidget workbenchActive={workbenchActive} />

      {/* 跨题目集的到期错题复习（「今日待复习 · 错题」各入口共用，两种壳都挂在这里） */}
      <DueMistakesReviewHost />

      {/* 🆕 首启欢迎引导（协议同意后、未配置 AI 服务时展示一次） */}
      {welcomeOnboardingOpen && (
        <WelcomeOnboardingDialog
          onConfigure={() => {
            dismissWelcomeOnboarding();
            setPendingSettingsTab('apis');
            setCurrentView('settings');
          }}
          onSkip={dismissWelcomeOnboarding}
        />
      )}

      {/* 调试面板入口由全局悬浮按钮统一控制 */}
      </DesktopShellHeaderPortalProvider>
      </DesktopShellSidebarPortalProvider>
      </LearningHubNavigationProvider>
      </MobileHeaderNavProvider>
      </MobileHeaderProvider>
      </MobileAppNavigationProvider>
      </MobileLayoutProvider>
      </TextContextMenuProvider>
      </CommandPaletteProvider>
  );
}

export default App;
