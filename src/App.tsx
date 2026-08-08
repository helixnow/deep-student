import React, { Suspense } from 'react';
import { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import './i18n';
import { useTranslation } from 'react-i18next';
// getCurrentWebviewWindow 已无使用（2026-02 清理）
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
// 🚀 性能优化：Settings, Dashboard, SOTADashboard 改为懒加载
import { CaretLeft, CaretRight, CircleNotch, Terminal, Warning, X } from '@phosphor-icons/react';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';
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
import { ModernSidebar } from './components/ModernSidebar';
import { StudyComposeIcon } from './components/icons/StudySidebarIcons';
import { WindowControls } from './components/WindowControls';
import { DesktopShellTitleEditor } from './components/DesktopShellTitleEditor';
import { MobileLayoutProvider, MobileHeaderProvider, UnifiedMobileHeader, MobileHeaderActiveViewSync, MobileAppNavigationProvider } from '@/components/layout';
import { GlobalPomodoroWidget } from '@/features/pomodoro/components/GlobalPomodoroWidget';
import { initReminderScheduler } from '@/features/todo/reminderScheduler';
import { useAutomationRunNotifications } from '@/features/todo/hooks/useAutomationRunNotifications';
// 🚀 性能优化：IrecServiceSwitcher, IrecGraphFlow, IrecGraphFlowDemo, CrepeDemoPage, ChatV2IntegrationTest, BridgeToIrec 改为懒加载
import { TauriAPI } from './utils/tauriApi';
// ★ MistakeItem 类型导入已废弃（2026-01 清理）
import { isWindows, isMacOS, isMobilePlatform } from './utils/platform';
import {
  applySidebarTranslucency,
  clearNativeTitlebarSidebarMaterial,
  syncNativeWindowAppearance,
} from './utils/sidebarTranslucency';
// 🚀 性能优化：ChatV2Page 改为懒加载，见 lazyComponents.tsx
// NT-1: NoteEditorPortal（白板远程桌面模式遗留，恒 return null）已随死渲染路径移除
// 🚀 性能优化：TreeDragTest, PdfReader, LearningHubPage 改为懒加载
import {
  LearningHubNavigationProvider,
  getGlobalLearningHubNavigation,
  subscribeLearningHubNavigation,
} from './features/learning-hub';
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
import { CustomScrollArea } from './components/custom-scroll-area';
import { getErrorMessage } from './utils/errorUtils';
import { useAppInitialization } from './hooks/useAppInitialization';
import { useShellScrollGuard } from './hooks/useShellScrollGuard';
import { useAppUpdater } from './hooks/useAppUpdater';
import { UserAgreementDialog, useUserAgreement } from './components/legal/UserAgreementDialog';
import { WelcomeOnboardingDialog, useWelcomeOnboarding } from './components/onboarding/WelcomeOnboardingDialog';
import { useMigrationStatusListener } from './hooks/useMigrationStatusListener';
import useTheme from './hooks/useTheme';
import { emitDebug, getDebugEnabled } from './utils/emitDebug';
import { useDialogControl } from './contexts/DialogControlContext';
import './styles/typography.css'; // 全局排版（字体/字号/行高）
import './styles/shadcn-overrides.css'; // 修复图标尺寸被覆盖的问题
import { MigrationStatusBanner } from './components/system-status/MigrationStatusBanner';
import { FeatureUnavailablePanel } from './components/system-status/FeatureUnavailablePanel';
import { SettingsShellSidebar } from '@/features/settings/components/SettingsShellSidebar';
import { TodoShellSidebar } from '@/features/todo/components/TodoShellSidebar';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from './app/shell/DesktopShellIcons';
import { setPendingSettingsTab, setPendingSettingsRoute } from './utils/pendingSettingsTab';
import { useBreakpoint } from './hooks/useBreakpoint';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { shouldBlockMobileNavigation, ensureKeyboardTracking } from './hooks/useKeyboardHeight';
import { installAndroidBackBridge, registerBackHandler, BACK_PRIORITY } from './app/navigation/androidBackCoordinator';
import { useNavigationShortcuts, getNavigationShortcutText } from './hooks/useNavigationShortcuts';
import type { CurrentView as NavigationCurrentView } from './types/navigation';
import { autoSaveScrollPosition, autoRestoreScrollPosition } from './utils/viewStateManager';
import { usePreventScroll } from './hooks/usePreventScroll';
import { CommandPaletteProvider, CommandPalette, registerBuiltinCommands, useCommandPalette } from './command-palette';
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
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useViewStore } from './stores/viewStore';
import { debugLog } from './debug-panel/debugMasterSwitch';
import { toggleDevtools } from './dev/devtools';
import { useIsUILabEnabled } from './utils/uiLabToggle';
import { sessionManager } from './features/chat/core/session/sessionManager';
import { setSessionSidebarViewContext } from './features/chat/hooks/useSessionSidebarIndicators';
import { groupCache } from './features/chat/core/store/groupCache';
import { getSessionTitleText } from './features/chat/utils/sessionTitle';
import type { ChatStore } from './features/chat/core/types';
import { getHiddenDraftSessionScope } from './features/chat/pages/draftSession';

import { ViewLayerRenderer } from './app/components';
import { canonicalizeView } from './app/navigation/canonicalView';
import {
  DESKTOP_SHELL,
  getShellSidebarDragLayout,
  getShellSidebarMaxWidth,
  getShellSidebarWidth,
  resolveShellSidebarResize,
} from './app/shell/desktopShell';
import { DesktopSidebarResizeHandle } from './app/shell/DesktopSidebarResizeHandle';
import { DesktopShellSidebarPortalProvider } from './app/shell/DesktopShellSidebarPortal';
import { DesktopShellHeaderPortalProvider } from './app/shell/DesktopShellHeaderPortal';
import { getMobileShellCssVars } from './app/shell/mobileShell';
import { Z_INDEX } from './config/zIndex';

// 🚀 性能优化：懒加载页面组件
import {
  PageLoadingFallback,
  LazySettings,
  LazySOTADashboard,
  LazyDataImportExport,
  LazyImportConversationDialog,
  LazySkillsManagementPage,
  LazyTemplateManagementPage,
  LazyStyleDebugPage,
  LazyTemplateJsonPreviewPage,
  LazyLearningHubPage,
  LazySandboxWorkbenchPage,
  LazyPdfReader,
  LazyTodoPage,
  LazyCrepeDemoPage,
  LazyChatV2IntegrationTest,
  LazyLLMOutputPlayground,
  LazyChatV2Page,
} from './lazyComponents';

// ★ Workbench（学习 OS 桌面，实验功能）：刻意深路径导入轻量模块，
//   避免经 workbench/index.ts 把应用群 re-export 拖进主 bundle；
//   桌面本体为独立 lazy chunk，开关关闭时不加载（设计 §9.3）。
import { installLegacyNavigationFallback } from '@/features/workbench/core/legacyNavigationMap';
import { AgentBridge } from '@/features/workbench/agent/AgentBridge';
import { useWindowStore } from '@/features/workbench/core/windowStore';
// 工厂提成共享常量：React.lazy 与下方预热 import() 指向同一模块说明符，命中同一 chunk
const importWorkbenchDesktop = () => import('@/features/workbench/components/WorkbenchDesktop');
const LazyWorkbenchDesktop = React.lazy(importWorkbenchDesktop);
/** workbench 模式的 localStorage 同步预读键（组件内 workbenchMode 初始态同源） */
const WORKBENCH_MODE_CACHE_KEY = 'desktop.workbenchMode';

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
const MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY = 'macos.native_font_smoothing';
const POINTER_CURSOR_SETTING_KEY = 'ui.pointer_cursor';

function applyMacOSFontSmoothingPreference(enabled: boolean) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.fontSmoothing = enabled ? 'macos-native' : 'macos-grayscale';
}

function applyPointerCursorPreference(enabled: boolean) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.pointerCursor = enabled ? 'true' : 'false';
}

const HEADER_HOTZONE_INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  '[data-shell-hotzone-ignore="true"]',
].join(', ');
const HEADER_HOTZONE_DRAG_THRESHOLD = 4;
const HEADER_HOTZONE_CLICK_ACTIVATION_DELAY_MS = 180;

function clearHeaderHotzoneActivationTimer(element: HTMLElement) {
  const timerId = element.dataset.shellHotzoneActivationTimer;
  if (!timerId) {
    return;
  }

  window.clearTimeout(Number(timerId));
  delete element.dataset.shellHotzoneActivationTimer;
}

function shouldIgnoreHeaderHotzoneTarget(target: EventTarget | null, boundary?: Element) {
  if (!(target instanceof Element)) {
    return false;
  }

  const closestInteractiveTarget = target.closest(HEADER_HOTZONE_INTERACTIVE_SELECTOR);
  return closestInteractiveTarget !== null && closestInteractiveTarget !== boundary;
}

function handleHeaderHotzoneClick(
  event: React.MouseEvent<HTMLElement>,
  activate: () => void,
) {
  const hotzoneElement = event.currentTarget;
  if (hotzoneElement.dataset.shellHotzoneSuppressClick === 'true' || event.detail > 1) {
    clearHeaderHotzoneActivationTimer(hotzoneElement);
    delete hotzoneElement.dataset.shellHotzoneSuppressClick;
    return;
  }

  if (shouldIgnoreHeaderHotzoneTarget(event.target, hotzoneElement)) {
    return;
  }

  clearHeaderHotzoneActivationTimer(hotzoneElement);
  const timerId = window.setTimeout(() => {
    delete hotzoneElement.dataset.shellHotzoneActivationTimer;
    activate();
  }, HEADER_HOTZONE_CLICK_ACTIVATION_DELAY_MS);
  hotzoneElement.dataset.shellHotzoneActivationTimer = String(timerId);
}

function handleHeaderHotzoneKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  activate: () => void,
) {
  if (shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)) {
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

function handleDesktopToolbarButtonMouseDown(
  event: React.MouseEvent<HTMLElement>,
  onTitlebarDoubleClick: () => void | Promise<void>,
) {
  if (event.button !== 0 || event.detail !== 2) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void onTitlebarDoubleClick();
}

function handleDesktopToolbarButtonClick(
  event: React.MouseEvent<HTMLElement>,
  activate: () => void,
) {
  event.stopPropagation();

  if (event.detail > 1) {
    return;
  }

  activate();
}

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
      <DsButton
        variant="ghost"
        size="icon"
        onClick={open}
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

// 🚀 LRU 视图淘汰：限制保活视图数量，避免内存无限增长
/** 始终保活的视图（不参与 LRU 淘汰） */
const PINNED_VIEWS: Set<CurrentView> = new Set(['chat-v2']);
/**
 * 暂缓驱逐的视图（2026-07 移动端审计 残留#3）：这两个视图的关键状态是纯本地
 * state（pdf-reader 已打开的 PDF 与页码、template-json-preview 手输的 JSON），
 * 被 LRU 驱逐即清零且不可恢复。淘汰时优先驱逐其他视图，仅当候选里只剩它们
 * 时才驱逐（软保护，不是 pinned——总保活上限不变，不抬高低端机内存天花板）。
 */
const EVICTION_DEFERRED_VIEWS: Set<CurrentView> = new Set(['pdf-reader', 'template-json-preview']);
/** 最大保活视图数量（含 pinned）
 *  桌面用户常用 6-7 个视图，设为 8 避免频繁驱逐导致的重新挂载开销；
 *  搭配 useMemo 缓存子树后，保活视图的 re-render 成本接近零。
 *  触屏设备（PERF-1）：低端 Android 同时保活 8 棵完整视图子树内存压力大，降为 4。
 *  取值在每次淘汰时动态读取，旋转/分屏后自然收敛，无需监听。
 */
const MAX_ALIVE_VIEWS_DESKTOP = 8;
const MAX_ALIVE_VIEWS_TOUCH = 4;
const getMaxAliveViews = (): number => {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches
      ? MAX_ALIVE_VIEWS_TOUCH
      : MAX_ALIVE_VIEWS_DESKTOP;
  } catch {
    return MAX_ALIVE_VIEWS_DESKTOP;
  }
};

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

  // 🆕 任务3：应用启动时同步后端维护模式状态到前端 store
  useEffect(() => {
    const syncMaintenanceStatus = async () => {
      try {
        const status = await invoke<{
          is_in_maintenance_mode: boolean;
          blocked_components?: string[];
          component_health?: { components?: StartupComponentIssue[] } | null;
          component_issues?: StartupComponentIssue[];
        }>('data_governance_get_maintenance_status');
        const componentHealth =
          status.component_health?.components
          ?? status.component_issues
          ?? [];
        useSystemStatusStore.getState().setComponentHealth(componentHealth);
        if (status.is_in_maintenance_mode) {
          useSystemStatusStore.getState().requireMaintenanceRestart(
            status.blocked_components?.length
              ? t('common:maintenance.recovery_required')
              : t('common:maintenance.banner_description')
          );
        } else if (componentHealth.some((entry) => entry.status !== 'healthy')) {
          const affected = componentHealth
            .filter((entry) => entry.status !== 'healthy')
            .map((entry) => entry.component)
            .join(', ');
          useSystemStatusStore.getState().showMigrationStatus({
            level: componentHealth.some((entry) => entry.status === 'blocked') ? 'error' : 'warning',
            message: t('common:maintenance.partial_degradation_title'),
            details: t('common:maintenance.partial_degradation_description', { components: affected }),
          });
        }
      } catch (err) {
        // 命令可能不存在（旧版后端），静默忽略
        console.warn('[App] 查询后端维护模式状态失败:', err);
      }
    };
    syncMaintenanceStatus();
  }, [t]);

  // 🌐 全局网络状态监测
  const { isOnline } = useNetworkStatus();
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    // 跳过首次渲染
    if (wasOnline === isOnline) return;
    if (!isOnline) {
      showGlobalNotification('warning', t('common:network.offline_message'), t('common:network.offline_title'));
    } else {
      showGlobalNotification('info', t('common:network.online_message'), t('common:network.online_title'));
    }
  }, [isOnline, t]);

  // P1修复：暗色主题初始化
  const { isDarkMode, toggleDarkMode } = useTheme(); // 自动初始化主题系统

  useEffect(() => {
    void syncNativeWindowAppearance(isDarkMode);
  }, [isDarkMode]);
  

  // 对话控制（MCP 工具与搜索引擎选择）
  const { selectedMcpTools, selectedSearchEngines } = useDialogControl();
  
  // 响应式检测：移动端布局调整
  const { isSmallScreen } = useBreakpoint();
  const [debugPanelRequested, setDebugPanelRequested] = useState(() => getDebugEnabled());
  const [debugPanelOpenRequest, setDebugPanelOpenRequest] = useState(0);

  // 生产包不会预先加载调试面板。设置页和命令面板都可能在面板尚未挂载时
  // 发起打开请求，因此由 App 保留请求并触发懒加载，避免事件落空。
  const openDebugPanel = useCallback(() => {
    setDebugPanelRequested(true);
    setDebugPanelOpenRequest((request) => request + 1);
  }, []);

  const toggleDebugPanel = useCallback(() => {
    const win = window as Window & { DSTU_TOGGLE_DEBUGGER?: () => void };
    if (typeof win.DSTU_TOGGLE_DEBUGGER === 'function') {
      win.DSTU_TOGGLE_DEBUGGER();
      return;
    }
    openDebugPanel();
  }, [openDebugPanel]);

  useEventRegistry([
    { target: 'window', type: 'DSTU_OPEN_DEBUGGER', listener: openDebugPanel },
    { target: 'window', type: 'DEV_TOGGLE_DEBUG_PANEL', listener: toggleDebugPanel },
  ], [openDebugPanel, toggleDebugPanel]);

  // 防止 content-body 被编程方式滚动
  const contentBodyRef = useRef<HTMLDivElement>(null);
  usePreventScroll(contentBodyRef);

  // 顶部栏顶部边距高度设置
  // 桌面端读取用户设置；移动端统一改由 mobile shell safe-area contract 提供。
  const [topbarTopMargin, setTopbarTopMargin] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    if (isSmallScreen) {
      setTopbarTopMargin(0);
      return;
    }
    // 桌面端读取用户设置
    const loadSetting = async () => {
      try {
        const v = await invoke<string>('get_setting', { key: 'topbar.top_margin' });
        if (cancelled) return;
        const value = String(v ?? '').trim();
        if (value) {
          const numValue = parseInt(value, 10);
          setTopbarTopMargin(isNaN(numValue) || numValue < 0 ? 0 : numValue);
        } else {
          setTopbarTopMargin(0);
        }
      } catch {
        if (cancelled) return;
        setTopbarTopMargin(0);
      }
    };
    loadSetting();
    // 监听设置变化事件（owner: App shell；dispose 与 cancelled 同生命周期）
    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (detail?.topbarTopMargin) {
        void loadSetting();
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [isSmallScreen]); // 响应窗口大小变化，自动切换移动端/桌面端默认值

  useEffect(() => {
    if (!isMacOS()) {
      delete document.documentElement.dataset.fontSmoothing;
      return;
    }

    let cancelled = false;

    const loadFontSmoothingSetting = async () => {
      try {
        const value = await invoke<string | null>('get_setting', {
          key: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
        });
        if (cancelled) return;
        applyMacOSFontSmoothingPreference(String(value ?? '').trim() !== 'false');
      } catch {
        if (cancelled) return;
        applyMacOSFontSmoothingPreference(true);
      }
    };

    void loadFontSmoothingSetting();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (
        detail?.macosFontSmoothing ||
        detail?.settingKey === MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY
      ) {
        void loadFontSmoothingSetting();
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // 侧边栏半透明：启动时从持久化设置恢复（CSS 属性 + macOS 原生 vibrancy）
  useEffect(() => {
    let cancelled = false;
    const SIDEBAR_TRANSLUCENT_KEY = 'sidebar.translucent';

    const loadSidebarTranslucentSetting = async () => {
      try {
        const val = await invoke<string | null>('get_setting', { key: SIDEBAR_TRANSLUCENT_KEY });
        if (cancelled) return;
        void applySidebarTranslucency(String(val ?? '').trim() === 'true');
      } catch {
        if (cancelled) return;
        void applySidebarTranslucency(false);
      }
    };
    void loadSidebarTranslucentSetting();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (detail?.settingKey === SIDEBAR_TRANSLUCENT_KEY) {
        void loadSidebarTranslucentSetting();
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPointerCursorSetting = async () => {
      try {
        const val = await invoke<string | null>('get_setting', { key: POINTER_CURSOR_SETTING_KEY });
        if (cancelled) return;
        applyPointerCursorPreference(String(val ?? '').trim() !== 'false');
      } catch {
        if (cancelled) return;
        applyPointerCursorPreference(true);
      }
    };

    void loadPointerCursorSetting();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (
        detail?.pointerCursor ||
        detail?.settingKey === POINTER_CURSOR_SETTING_KEY
      ) {
        const enabled =
          typeof detail?.value === 'boolean'
            ? detail.value
            : String(detail?.value ?? '').trim() !== 'false';
        applyPointerCursorPreference(enabled);
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);
  
  // 🎯 命令面板：注册内置命令
  // ★ 2026-06-12：命令名在注册时经 i18next.t() 一次性求值,运行时切换语言后必须
  //   重新注册一遍,否则面板里仍显示旧语言文案
  useEffect(() => {
    let unregister = registerBuiltinCommands();
    const refreshOnLanguageChange = () => {
      unregister();
      unregister = registerBuiltinCommands();
    };
    i18n.on('languageChanged', refreshOnLanguageChange);
    return () => {
      i18n.off('languageChanged', refreshOnLanguageChange);
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- i18n 为模块级单例,引用稳定
  }, []);

  // ⏰ 待办提醒调度器（应用级，到点弹系统通知）
  useEffect(() => initReminderScheduler(), []);

  // ★ 4.2 制卡完成通知（应用级，后台时发系统通知）
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    import('@/features/anki/ankiCompletionNotifier').then((m) => {
      cleanup = m.initAnkiCompletionNotifier();
    });
    return () => cleanup?.();
  }, []);

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

  // ★ Workbench 产品默认身份：localStorage 同步预读避免冷启动闪回 legacy 壳，
  //   再以 resolveWorkbenchModeEnabled 为准（缺失键 → true + 迁移哨兵）；
  //   监听设置页 workbench:mode-changed 即时切换（缓存键提升至模块级供预热复用）
  const [workbenchMode, setWorkbenchMode] = useState(() => {
    try {
      if (typeof localStorage === 'undefined') return true;
      // 显式 false 保留经典壳；缺失 / true → 学习桌面（产品默认）
      return localStorage.getItem(WORKBENCH_MODE_CACHE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    installLegacyNavigationFallback();
    let cancelled = false;
    const cacheMode = (enabled: boolean) => {
      try {
        localStorage.setItem(WORKBENCH_MODE_CACHE_KEY, String(enabled));
      } catch {
        /* private mode / quota */
      }
    };
    (async () => {
      try {
        const { resolveWorkbenchModeEnabled } = await import(
          '@/features/settings/components/workbenchMode'
        );
        const { enabled } = await resolveWorkbenchModeEnabled();
        if (cancelled) return;
        setWorkbenchMode(enabled);
        cacheMode(enabled);
      } catch {
        /* 默认启用；保留预读缓存 */
      }
    })();
    const dispose = addAppEventListener(APP_EVENTS.WORKBENCH_MODE_CHANGED, (detail) => {
      const enabled = Boolean(detail?.enabled);
      setWorkbenchMode(enabled);
      cacheMode(enabled);
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // Workbench 仅桌面端生效（设计文档：移动端不适用，继续现有滑动布局）；
  // 屏宽之外再按平台护栏：宽屏 Android 平板 / iPad 也不进 OS 模式
  //
  // 迟滞（250ms 宽度稳定确认）：isSmallScreen 在 768 边界即时翻转会整壳硬切，
  // WorkbenchDesktop 连同所有窗口立刻卸载，绕过 ResourceAppWorkspace 的未保存
  // 确认与 windowCloseGuard。拖拽窗口宽度瞬间穿越 768 再回来时不应误卸载整棵树。
  // 仅工作台壳切换用稳定值；页面内布局仍用即时 isSmallScreen，不受影响。
  const [shellStableSmallScreen, setShellStableSmallScreen] = useState(isSmallScreen);
  useEffect(() => {
    if (isSmallScreen === shellStableSmallScreen) return;
    const timer = window.setTimeout(() => {
      // 250ms 后仍是新值才提交（期间弹回则本 effect 已被 cleanup 取消）
      setShellStableSmallScreen(isSmallScreen);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isSmallScreen, shellStableSmallScreen]);
  const workbenchActive = workbenchMode && !shellStableSmallScreen && !isMobilePlatform();

  const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');
  // ★ previousView 用于模板选择返回
  const [previousView, setPreviousView] = useState<CurrentView>('chat-v2');
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
  const toggleDesktopWindowMaximize = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
        return;
      }

      await appWindow.maximize();
    } catch (error: unknown) {
      console.error('Failed to toggle desktop window maximize:', error);
    }
  }, []);
  // macOS traffic lights share the native titlebar with the custom shell
  // controls. The horizontal spacer reserves their hit area; adding a second
  // vertical inset would render a duplicate toolbar below the native chrome.
  const shellTitlebarTopInset = isSmallScreen || isMacOS() ? 0 : topbarTopMargin;
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
    '--shell-navigation-surface-width': leftPanelCollapsed && desktopSidebarMotionWidth !== null
      ? `${desktopSidebarMotionWidth}px`
      : 'var(--shell-navigation-width)',
    '--shell-titlebar-content-height': `${workbenchActive ? 0 : DESKTOP_SHELL.titlebarBaseHeight}px`,
    '--topbar-safe-area': `${workbenchActive ? 0 : shellTitlebarTopInset}px`,
    '--sidebar-header-height': '65px', // 左侧导航栏第一个图标到分隔线的高度
  }) as React.CSSProperties, [
    desktopNavigationWidth,
    desktopSidebarPresentationWidth,
    desktopSidebarTranslateX,
    desktopSidebarMotionWidth,
    leftPanelCollapsed,
    shellTitlebarOccupiedHeight,
    topbarTopMargin,
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
  const [templateManagementShellBackVisible, setTemplateManagementShellBackVisible] = useState(true);
  const currentViewRef = useRef<CurrentView>('chat-v2');
  // 移动端设置以 Sheet 覆盖在原视图之上；保留打开设置前的视图作为露出区背景。
  const [settingsBackdropView, setSettingsBackdropView] = useState<CurrentView>('chat-v2');
  // 关闭 Sheet 返回原视图时跳过一次页面入场动画，避免和 Sheet 离场动画叠加造成闪现。
  const settingsClosingViewRef = useRef<CurrentView | null>(null);
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

    if (targetView !== prevView) {
      const startTime = performance.now();
      viewSwitchStartRef.current = { from: prevView, to: targetView, startTime };
      
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
      if (targetView === 'settings' && prevView !== 'settings') {
        setSettingsBackdropView(prevView);
        settingsClosingViewRef.current = null;
      } else if (prevView === 'settings' && targetView !== 'settings') {
        settingsClosingViewRef.current = targetView;
      }

      // 🚀 LRU 更新：记录访问时间戳，超过阈值时淘汰最久未访问的非 pinned 视图
      setVisitedViews(prev => {
        const now = Date.now();
        const next = new Map(prev);
        next.set(targetView, now);

        // 淘汰逻辑：仅在超出上限时移除最旧的非 pinned 视图。
        // 两轮扫描：先跳过 EVICTION_DEFERRED_VIEWS（本地状态驱逐即丢的视图），
        // 候选里只剩暂缓视图时才回退为普通 LRU，保证上限恒成立。
        if (next.size > getMaxAliveViews()) {
          let oldestView: CurrentView | null = null;
          let oldestTime = Infinity;
          for (const deferProtected of [true, false]) {
            for (const [view, ts] of next) {
              if (PINNED_VIEWS.has(view)) continue;
              if (view === targetView) continue;
              if (deferProtected && EVICTION_DEFERRED_VIEWS.has(view)) continue;
              if (ts < oldestTime) {
                oldestTime = ts;
                oldestView = view;
              }
            }
            if (oldestView) break;
          }
          if (oldestView) {
            next.delete(oldestView);
            pageLifecycleTracker.log(
              'app',
              'App.tsx',
              'view_evict',
              `LRU evicted: ${oldestView} (%.0fms old)`.replace('%.0fms', `${now - oldestTime}ms`)
            );
          }
        }

        return next;
      });
      setCurrentViewRaw(targetView);
    });
  }, []);
  const templateJsonPreviewReturnRef = useRef<CurrentView>('template-management');

  useEffect(() => {
    let shouldOpenRecoveryReceipt = false;
    try {
      shouldOpenRecoveryReceipt =
        localStorage.getItem('deep-student.pending-recovery-receipt') === '1';
      if (shouldOpenRecoveryReceipt) {
        localStorage.removeItem('deep-student.pending-recovery-receipt');
      }
    } catch {
      return;
    }

    if (!shouldOpenRecoveryReceipt) return;
    setPendingSettingsRoute({
      tab: 'data-governance',
      dataGovernanceTab: 'recovery',
    });
    setCurrentView('settings');
  }, [setCurrentView]);

  const uiLabEnabled = useIsUILabEnabled();

  useEffect(() => {
    if (currentView === 'ui-lab' && !uiLabEnabled) {
      setCurrentView('chat-v2');
    }
  }, [currentView, uiLabEnabled, setCurrentView]);

  // ★ 移动端顶栏活跃视图同步已移至 MobileHeaderActiveViewSync 组件

  useEffect(() => {
    currentViewRef.current = currentView;
    // 同步当前视图到全局 store，供子组件通过 useViewVisibility 读取
    useViewStore.getState().setCurrentView(currentView);

    if (currentView === 'learning-hub') {
      setActiveOpenResourceHandler('learning-hub');
    } else if (currentView === 'chat-v2') {
      setActiveOpenResourceHandler('chat-v2');
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
  // 原生 DOM 事件走 useEventRegistry（非 CustomEvent 域）
  const onFrontendError = useCallback((ev: Event) => {
    const dispatchFrontendErrorDebug = (payload: Record<string, unknown>) => {
      const meta = { path: window.location?.pathname, ua: navigator?.userAgent };
      const emitTask = () => {
        try {
          emitDebug({ channel: 'error', eventName: 'frontend_error', payload, meta });
        } catch (e) { debugLog.warn('[App] emitDebug frontend_error failed:', e); }
      };
      if (typeof queueMicrotask === 'function') {
        try {
          queueMicrotask(emitTask);
          return;
        } catch { /* non-critical: queueMicrotask unavailable, falls through to setTimeout */ }
      }
      setTimeout(emitTask, 0);
    };

    try {
      const errorEvent = ev as ErrorEvent & { target?: EventTarget | null };
      const target = errorEvent.target as (EventTarget & {
        currentSrc?: string;
        src?: string;
        href?: string;
        tagName?: string;
        baseURI?: string;
      }) | null;
      const isResourceError = Boolean(errorEvent && target && target !== window);
      if (isResourceError) {
        const src = target?.currentSrc || target?.src || target?.href || '';
        if (typeof src === 'string' && src.includes('/sse-proxy/')) {
          return;
        }
      }
      const payload = isResourceError
        ? {
          type: 'ResourceError',
          tagName: target?.tagName,
          src: target?.currentSrc || target?.src || target?.href,
          baseURI: target?.baseURI,
        }
        : {
          type: 'Error',
          message: errorEvent?.message || String((errorEvent as ErrorEvent)?.error || 'Unknown error'),
          stack: (errorEvent?.error && (errorEvent.error as Error)?.stack) || undefined,
          filename: errorEvent?.filename,
          lineno: errorEvent?.lineno,
          colno: errorEvent?.colno,
        };
      dispatchFrontendErrorDebug(payload);
      console.error('[DSTU][FRONTEND_ERROR]', payload);
    } catch (e) { debugLog.warn('[App] onError handler failed:', e); }
  }, []);

  const onUnhandledRejection = useCallback((ev: Event) => {
    try {
      const rejection = ev as PromiseRejectionEvent;
      const reason = rejection?.reason || 'Unknown rejection';
      const message = typeof reason === 'string' ? reason : (reason?.message || String(reason));

      if (message.includes('fetch_cancel_body') || message.includes('http.fetch_cancel_body')) {
        return;
      }

      emitDebug({
        channel: 'error',
        eventName: 'frontend_error',
        payload: {
          type: 'UnhandledRejection',
          message,
          stack: typeof reason === 'object' && reason ? reason.stack : undefined,
        },
        meta: { path: window.location?.pathname, ua: navigator?.userAgent },
      });
    } catch (e) { debugLog.warn('[App] onRejection handler failed:', e); }
  }, []);

  useEventRegistry([
    { target: 'window', type: 'error', listener: onFrontendError, options: true },
    { target: 'window', type: 'unhandledrejection', listener: onUnhandledRejection },
  ], [onFrontendError, onUnhandledRejection]);

  // Milkdown / Notes / 新建桥接 / 知识库：壳层导航监听（owner: App）
  useAppEvent(APP_EVENTS.OPEN_MARKDOWN_EDITOR, () => {
    setCurrentView('learning-hub');
  }, [setCurrentView]);

  useAppEvent(APP_EVENTS.OPEN_NOTES, () => {
    setCurrentView('learning-hub');
  }, [setCurrentView]);

  const handleCreateChatSessionBridge = useCallback((detail: { action?: string } | undefined) => {
    if (
      detail?.action &&
      detail.action !== 'create-session' &&
      detail.action !== 'create-group'
    ) {
      return;
    }
    setCurrentView('chat-v2');
  }, [setCurrentView]);

  useEventRegistry([
    {
      target: 'window',
      type: APP_EVENTS.CHAT_NEW_SESSION,
      listener: toAppEventListener(handleCreateChatSessionBridge),
    },
    {
      target: 'window',
      type: APP_EVENTS.MODERN_SIDEBAR_GROUP_ACTION,
      listener: toAppEventListener(handleCreateChatSessionBridge),
    },
    {
      target: 'window',
      type: APP_EVENTS.NOTES_CREATE_NEW,
      listener: () => {
        setCurrentView('learning-hub');
      },
    },
  ], [handleCreateChatSessionBridge, setCurrentView]);

  // Crepe minimal demo：用于排查编辑器性能的纯净示例（仅开发模式）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openCrepeDemo = () => setCurrentView('crepe-demo');
    const dispose = addAppEventListener(APP_EVENTS.OPEN_CREPE_DEMO, openCrepeDemo);
    (window as unknown as { openCrepeDemo?: () => void }).openCrepeDemo = openCrepeDemo;
    return () => {
      dispose();
      const w = window as unknown as { openCrepeDemo?: () => void };
      if (w.openCrepeDemo === openCrepeDemo) {
        delete w.openCrepeDemo;
      }
    };
  }, [setCurrentView]);

  // ★ OPEN_RF_DEMO 事件已废弃（图谱演示已移除）

  // 顶部安全区功能已移除

  // ★ 2026-01 清理：知识库导航统一跳转到 Learning Hub
  useAppEvent(APP_EVENTS.NAVIGATE_TO_KNOWLEDGE_BASE, (detail) => {
    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.LEARNING_HUB_NAVIGATE_TO_KNOWLEDGE, detail ?? {});
      }, 0);
    });
  }, [setCurrentView]);

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

    if (detail.openResource && targetView === 'learning-hub') {
      const dstuPath = detail.openResource;
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, { dstuPath });
      }, 150);
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

  // 🐛 BUG-1 修复: 追踪是否通过页面级 back/forward 抵达 Learning Hub
  // 当通过页面级导航抵达 LH 时，前进按钮应优先使用页面级前进（如有），
  // 避免 LH 内部残留的前进历史遮蔽页面级前进。
  const arrivedAtLHViaPageNavRef = useRef(false);
  const pageNavInProgressRef = useRef(false);

  // ⚙️ 视图历史：使用新的导航历史 Hook
  const navigationHistory = useNavigationHistory({
    currentView,
    onViewChange: (view, _params) => {
      // 🐛 BUG-1: 页面级导航（back/forward）抵达 LH 时设置标记
      if (pageNavInProgressRef.current && view === 'learning-hub') {
        arrivedAtLHViaPageNavRef.current = true;
      }
      setCurrentView(view);
    },
  });

  // 📁 Learning Hub 内部导航（使用全局订阅，因为 App.tsx 在 Provider 外部）
  const [learningHubNav, setLearningHubNav] = useState(() => getGlobalLearningHubNavigation());
  const isInLearningHub = currentView === 'learning-hub';

  // 订阅 Learning Hub 导航状态变化
  useEffect(() => {
    // 获取初始状态
    setLearningHubNav(getGlobalLearningHubNavigation());

    // 订阅状态变化
    const unsubscribe = subscribeLearningHubNavigation((state) => {
      setLearningHubNav(state);
    });

    return unsubscribe;
  }, []);

  // 🐛 BUG-1: 离开 Learning Hub 时清除页面级抵达标记
  useEffect(() => {
    if (!isInLearningHub) {
      arrivedAtLHViaPageNavRef.current = false;
    }
  }, [isInLearningHub]);

  // 统一的导航处理：Learning Hub / workbench files 的 finder 历史优先，否则使用页面级导航
  // 🐛 BUG-1: 通过页面级导航抵达 LH 时，前进优先使用页面级（如有），
  //   避免 LH 残留的内部前进历史遮蔽页面级前进目标。
  const focusedWbTypeId = useWindowStore((s) => {
    if (!workbenchActive) return null;
    const topId = s.focusStack[s.focusStack.length - 1];
    return topId ? (s.windows[topId]?.typeId ?? null) : null;
  });
  const isWorkbenchFilesFocused = workbenchActive && focusedWbTypeId === 'files';
  const finderCanBack = Boolean(learningHubNav?.canGoBack);
  const finderCanForward = Boolean(learningHubNav?.canGoForward);

  const unifiedCanGoBack =
    ((isInLearningHub || isWorkbenchFilesFocused) && finderCanBack)
    || (!isWorkbenchFilesFocused && navigationHistory.canGoBack);
  const unifiedCanGoForward = (() => {
    if (isInLearningHub) {
      // 通过页面级导航抵达 LH 且页面级有前进 → 页面级前进优先
      if (arrivedAtLHViaPageNavRef.current && navigationHistory.canGoForward) {
        return true;
      }
      // LH 内部有前进（用户主动 LH 后退产生的，或页面级前进已耗尽）
      if (finderCanForward) {
        return true;
      }
    }
    if (isWorkbenchFilesFocused) {
      return finderCanForward;
    }
    return navigationHistory.canGoForward;
  })();
  const unifiedGoBack = useCallback(() => {
    if (isInLearningHub && arrivedAtLHViaPageNavRef.current && navigationHistory.canGoBack) {
      pageNavInProgressRef.current = true;
      navigationHistory.goBack();
      pageNavInProgressRef.current = false;
      return;
    }
    if ((isInLearningHub || isWorkbenchFilesFocused) && learningHubNav?.canGoBack) {
      learningHubNav.goBack();
      // 🐛 BUG-1: 用户主动使用 LH 内部后退，清除页面级抵达标记
      if (isInLearningHub) {
        arrivedAtLHViaPageNavRef.current = false;
      }
      return;
    }
    // files 聚焦且 finder 已见底：勿用页面级 history 偷换视图
    if (isWorkbenchFilesFocused) {
      return;
    }
    pageNavInProgressRef.current = true;
    navigationHistory.goBack();
    pageNavInProgressRef.current = false;
  }, [isInLearningHub, isWorkbenchFilesFocused, learningHubNav, navigationHistory]);
  const unifiedGoForward = useCallback(() => {
    if (isInLearningHub) {
      // 🐛 BUG-1: 通过页面级导航抵达 LH 且页面级有前进 → 页面级前进优先
      if (arrivedAtLHViaPageNavRef.current && navigationHistory.canGoForward) {
        pageNavInProgressRef.current = true;
        navigationHistory.goForward();
        pageNavInProgressRef.current = false;
        return;
      }
      // LH 内部有前进（正常 LH 浏览，或页面级前进已耗尽）
      if (learningHubNav?.canGoForward) {
        learningHubNav.goForward();
        return;
      }
    }
    if (isWorkbenchFilesFocused) {
      if (learningHubNav?.canGoForward) {
        learningHubNav.goForward();
      }
      return;
    }
    navigationHistory.goForward();
  }, [isInLearningHub, isWorkbenchFilesFocused, learningHubNav, navigationHistory]);
  
  // ⌨️ 键盘和鼠标快捷键支持
  useNavigationShortcuts({
    onBack: unifiedGoBack,
    onForward: unifiedGoForward,
    canGoBack: unifiedCanGoBack,
    canGoForward: unifiedCanGoForward,
  });

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
  // dashboard / data-management / pdf-reader / sandbox-workbench /
  // template-json-preview 等视图没有 ☰ 抽屉入口，左上角只有全局历史返回按钮；
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
  useEffect(() => {
    const viewsWithScrollState: CurrentView[] = [
      'learning-hub',
      'settings',
      'skills-management',
      'task-dashboard',
      'template-management',
    ];
    
    if (!viewsWithScrollState.includes(currentView)) {
      return;
    }

    // 恢复滚动位置
    const timer = setTimeout(() => {
      autoRestoreScrollPosition(currentView);
    }, 100); // 等待 DOM 渲染

    // 自动保存滚动位置
    const cleanup = autoSaveScrollPosition(currentView);

    return () => {
      clearTimeout(timer);
      cleanup();
    };
  }, [currentView]);

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

  // 其他页面导航事件监听（typed registry + useEventRegistry lifecycle）
  const handleNavigateToExamSheet = useCallback((detail: {
    sessionId: string;
    cardId?: string;
    mistakeId?: string;
  }) => {
    const sessionId = detail?.sessionId;
    if (!sessionId) return;

    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_EXAM, {
          sessionId,
          cardId: detail?.cardId ?? null,
          mistakeId: detail?.mistakeId ?? null,
        });
      }, 0);
    });
  }, [setCurrentView]);

  const handleNavigateToTranslation = useCallback((detail: {
    translationId: string;
    title?: string;
  }) => {
    const translationId = detail?.translationId;
    if (!translationId) return;

    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_TRANSLATION, {
          translationId,
          title: detail?.title,
        });
      }, 0);
    });
  }, [setCurrentView]);

  const handleNavigateToEssay = useCallback((detail: {
    essayId: string;
    title?: string;
  }) => {
    const essayId = detail?.essayId;
    if (!essayId) return;

    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_ESSAY, {
          essayId,
          title: detail?.title,
        });
      }, 0);
    });
  }, [setCurrentView]);

  const handleNavigateToNote = useCallback((detail: {
    noteId: string;
    source?: string;
  }) => {
    const noteId = detail?.noteId;
    if (!noteId) return;

    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_NOTE, {
          noteId,
          source: detail?.source,
        });
      }, 0);
    });
  }, [setCurrentView]);

  const handlePrefillChatInput = useCallback((detail: {
    content: string;
    autoSend?: boolean;
  }) => {
    const { content, autoSend } = detail ?? {};
    if (!content) return;

    setCurrentView('chat-v2');
    setTimeout(() => {
      dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, { content, autoSend });
    }, 150);
  }, [setCurrentView]);

  // ★ irec 相关事件监听已废弃（图谱模块已移除）
  // ★ navigateToMistakeById 事件监听已废弃（2026-01 清理）
  useEventRegistry([
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_EXAM_SHEET, listener: toAppEventListener(handleNavigateToExamSheet) },
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_TRANSLATION, listener: toAppEventListener(handleNavigateToTranslation) },
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_ESSAY, listener: toAppEventListener(handleNavigateToEssay) },
    { target: 'window', type: APP_EVENTS.NAVIGATE_TO_NOTE, listener: toAppEventListener(handleNavigateToNote) },
    { target: 'window', type: APP_EVENTS.PREFILL_CHAT_INPUT, listener: toAppEventListener(handlePrefillChatInput) },
  ], [handleNavigateToExamSheet, handleNavigateToTranslation, handleNavigateToEssay, handleNavigateToNote, handlePrefillChatInput]);

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
  // 注：F12 由命令系统 dev.open-devtools 统一处理；debug 构建下 Cmd+Alt+I 由
  // Tauri 注入热键处理，此处仅覆盖生产 web 部署场景（统一走自有命令 toggle_devtools）
  const handleDevtoolsKeyDown = useCallback(async (event: Event) => {
    const isProduction = !window.location.hostname.includes('localhost') &&
                        !window.location.hostname.includes('127.0.0.1') &&
                        !window.location.hostname.includes('tauri.localhost');
    if (!isProduction) return;

    const keyboardEvent = event as KeyboardEvent;
    const isDevtoolsShortcut =
      (keyboardEvent.ctrlKey && keyboardEvent.shiftKey && keyboardEvent.key === 'I') ||
      (keyboardEvent.metaKey && keyboardEvent.altKey && keyboardEvent.key === 'I');

    if (!isDevtoolsShortcut) return;

    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    const opened = await toggleDevtools();
    if (opened === null) {
      debugLog.warn('[App] DevTools 不可用：当前构建未启用 devtools（需 debug 构建或 --features devtools）');
    }
  }, []);

  useEventRegistry([
    { target: 'document', type: 'keydown', listener: handleDevtoolsKeyDown },
  ], [handleDevtoolsKeyDown]);

  // 模板管理状态
  const [isSelectingTemplate, setIsSelectingTemplate] = useState(false);
  const [templateSelectionCallback, setTemplateSelectionCallback] = useState<((template: any) => void) | null>(null);

  // 开发功能设置状态
  // 移除：Gemini 适配器测试开关

  // App组件状态变化（已禁用日志）
  const { startDragging } = useWindowDrag();
  
  
  // 🔧 定期持久化 WebView 设置，确保自动备份可获取
  useEffect(() => {
    let lastSnapshot = '';
    let cancelled = false;

    const persistWebviewSettings = async () => {
      if (cancelled) return;
      try {
        const data = TauriAPI.collectLocalStorageForBackup();
        const snapshot = JSON.stringify(data);
        if (snapshot === lastSnapshot) {
          return;
        }
        lastSnapshot = snapshot;
        await TauriAPI.saveWebviewSettings(data);
      } catch (error) {
        console.warn('[App] WebView 设置持久化失败:', error);
      }
    };

    void persistWebviewSettings();
    const intervalId = window.setInterval(persistWebviewSettings, 10 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

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

  // 渲染侧边栏导航 - 现代化风格
  const noopToggle = useCallback(() => {}, []);
  const sidebarElement = useMemo(() => (
    <ModernSidebar
      currentView={currentView}
      onViewChange={handleViewChange}
      sidebarCollapsed={leftPanelCollapsed}
      onToggleSidebar={noopToggle}
      startDragging={startDragging}
      topbarTopMargin={topbarTopMargin}
      updater={updater}
    />
  ), [currentView, handleViewChange, leftPanelCollapsed, noopToggle, startDragging, topbarTopMargin, updater]);

  const settingsShellSidebarElement = useMemo(() => (
    <SettingsShellSidebar
      isSmallScreen={false}
      globalLeftPanelCollapsed={leftPanelCollapsed}
      onBack={() => setCurrentView('chat-v2')}
    />
  ), [leftPanelCollapsed, setCurrentView]);

  const todoShellSidebarElement = useMemo(() => (
    <TodoShellSidebar
      isSmallScreen={false}
      globalLeftPanelCollapsed={leftPanelCollapsed}
      onBack={() => setCurrentView('chat-v2')}
    />
  ), [leftPanelCollapsed, setCurrentView]);

  const handleDesktopPageSidebarTarget = useCallback((node: HTMLDivElement | null) => {
    setDesktopPageSidebarTarget(node);
  }, []);
  const shouldShowDesktopPageBackButton =
    currentView === 'learning-hub'
    || (currentView === 'template-management' && templateManagementShellBackVisible);
  const desktopPageShellSidebarElement = useMemo(() => (
    <div className="sidebar-shell-surface font-sidebar-study-ui flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      {shouldShowDesktopPageBackButton ? (
        <div className="flex shrink-0 items-center px-3 pb-2 pt-[var(--sidebar-header-height)]">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setCurrentView('chat-v2')}
            className="desktop-shell-sidebar-row w-full justify-start"
          >
            <CaretLeft size={14} aria-hidden="true" />
            <span className="desktop-shell-sidebar-row-title truncate">
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

  // 侧栏内容类型：同时作为侧栏包裹层的 key，类型变化时重挂载并重播入场动画
  const desktopShellSidebarKind = currentView === 'settings'
    ? 'settings'
    : currentView === 'todo'
    ? 'todo'
    : currentView === 'learning-hub' || currentView === 'template-management'
    ? 'desktop-page'
    : 'main';
  const desktopShellSidebarElement = desktopShellSidebarKind === 'settings'
    ? settingsShellSidebarElement
    : desktopShellSidebarKind === 'todo'
    ? todoShellSidebarElement
    : desktopShellSidebarKind === 'desktop-page'
    ? desktopPageShellSidebarElement
    : sidebarElement;

  const syncSessionSidebarContext = useCallback(() => {
    setSessionSidebarViewContext({
      currentView,
      activeSessionId: sessionManager.getCurrentSessionId(),
      isDocumentVisible:
        typeof document === 'undefined'
          ? true
          : document.visibilityState === 'visible' && document.hasFocus(),
    });
  }, [currentView]);

  useEffect(() => {
    syncSessionSidebarContext();

    const unsubscribeSessionManager = sessionManager.subscribe((event) => {
      if (event.type === 'current-session-changed') {
        syncSessionSidebarContext();
      }
    });

    return () => {
      unsubscribeSessionManager();
    };
  }, [syncSessionSidebarContext]);

  useEventRegistry([
    {
      target: 'window',
      type: 'focus',
      listener: syncSessionSidebarContext as EventListener,
    },
    {
      target: 'window',
      type: 'blur',
      listener: syncSessionSidebarContext as EventListener,
    },
    {
      target: 'document',
      type: 'visibilitychange',
      listener: syncSessionSidebarContext as EventListener,
    },
  ], [syncSessionSidebarContext]);

  // ★ 分析模式已废弃（旧错题系统已移除）- handleCoreStateUpdate, handleSaveRequest, analysisHostProps 已移除
  // const renderAnalysisView = () => null; // 已废弃

  const navigationShortcuts = getNavigationShortcutText();
  const commandPaletteTriggerRef = useRef<(() => void) | null>(null);
  const handleDesktopTitlebarMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const dragExclusionTarget = (event.target as HTMLElement).closest('[data-no-drag]');
    if (dragExclusionTarget || shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    if (event.detail === 2) {
      void toggleDesktopWindowMaximize();
      return;
    }

    void startDragging(event);
  }, [startDragging, toggleDesktopWindowMaximize]);
  const clearHeaderHotzonePress = useCallback((element: HTMLElement) => {
    delete element.dataset.shellHotzoneStartX;
    delete element.dataset.shellHotzoneStartY;
  }, []);
  const handleHeaderHotzoneMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)) {
      return;
    }

    if (event.detail === 2) {
      event.preventDefault();
      event.stopPropagation();
      clearHeaderHotzonePress(event.currentTarget);
      clearHeaderHotzoneActivationTimer(event.currentTarget);
      event.currentTarget.dataset.shellHotzoneSuppressClick = 'true';
      void toggleDesktopWindowMaximize();
      return;
    }

    event.currentTarget.dataset.shellHotzoneStartX = String(event.clientX);
    event.currentTarget.dataset.shellHotzoneStartY = String(event.clientY);
    delete event.currentTarget.dataset.shellHotzoneSuppressClick;
  }, [clearHeaderHotzonePress, toggleDesktopWindowMaximize]);
  const handleHeaderHotzoneMouseMove = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.buttons !== 1) {
      return;
    }

    const { shellHotzoneStartX, shellHotzoneStartY } = event.currentTarget.dataset;
    if (!shellHotzoneStartX || !shellHotzoneStartY) {
      return;
    }

    const deltaX = event.clientX - Number(shellHotzoneStartX);
    const deltaY = event.clientY - Number(shellHotzoneStartY);
    if (Math.hypot(deltaX, deltaY) < HEADER_HOTZONE_DRAG_THRESHOLD) {
      return;
    }

    clearHeaderHotzonePress(event.currentTarget);
    event.currentTarget.dataset.shellHotzoneSuppressClick = 'true';
    void startDragging(event);
  }, [clearHeaderHotzonePress, startDragging]);
  const handleHeaderHotzoneMouseUp = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const hotzoneElement = event.currentTarget;
    clearHeaderHotzonePress(hotzoneElement);

    if (hotzoneElement.dataset.shellHotzoneSuppressClick === 'true') {
      window.setTimeout(() => {
        delete hotzoneElement.dataset.shellHotzoneSuppressClick;
      }, 0);
    }
  }, [clearHeaderHotzonePress]);
  const handleHeaderHotzoneMouseLeave = useCallback((event: React.MouseEvent<HTMLElement>) => {
    clearHeaderHotzonePress(event.currentTarget);
  }, [clearHeaderHotzonePress]);
  const handleCreateChatSession = useCallback(() => {
    if (currentView !== 'chat-v2') {
      setCurrentView('chat-v2');
      requestAnimationFrame(() => {
        dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
      });
      return;
    }

    dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
  }, [currentView, setCurrentView]);
  const openCommandPalette = useCallback(() => {
    commandPaletteTriggerRef.current?.();
  }, []);
  const [currentChatHeaderTitle, setCurrentChatHeaderTitle] = useState('');
  const [currentChatHeaderGroupName, setCurrentChatHeaderGroupName] = useState('');
  const [currentChatHeaderSessionId, setCurrentChatHeaderSessionId] = useState<string | null>(null);
  const currentChatHeaderStoreUnsubscribeRef = useRef<(() => void) | null>(null);
  const currentChatHeaderSubscribedSessionIdRef = useRef<string | null>(null);
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

  const desktopShellViewLabel = useMemo(() => {
    if (currentView === 'chat-v2') {
      // 新会话尚未写入标题时，按 Codex 的行为保持标题区域为空。
      return currentChatHeaderTitle;
    }

    const labels: Partial<Record<CurrentView, string>> = {
      'chat-v2': t('sidebar:navigation.chat_v2'),
      'learning-hub': t('sidebar:navigation.learning_hub'),
      'settings': t('sidebar:navigation.settings'),
      'dashboard': t('common:navigation.dashboard'),
      'task-dashboard': t('sidebar:navigation.anki_generation'),
      'skills-management': t('sidebar:navigation.skills_management'),
      'data-management': t('common:navigation.data_management'),
      'template-management': t('sidebar:navigation.template_management'),
      'ui-lab': t('sidebar:navigation.ui_lab'),
      'template-json-preview': t('common:navigation.template_json_preview'),
      'pdf-reader': t('common:navigation.pdf_reader'),
      'sandbox-workbench': t('common:navigation.sandbox_workbench'),
      'todo': t('sidebar:navigation.todo'),
      'crepe-demo': t('common:navigation.crepe_demo'),
      'chat-v2-test': t('common:navigation.chat_v2_test'),
      'llm-playground': t('common:navigation.llm_playground'),
    };

    return labels[currentView] ?? t('common:app.default_header');
  }, [currentChatHeaderTitle, currentView, t]);

  // 🚀 性能优化：memoize 各视图内容，防止切换视图时所有已缓存视图子树被重新协调
  // 当 App 因 currentView 变化而重渲染时，useMemo 返回相同的 React 元素引用，
  // React 协调器看到相同引用后会跳过整个子树的 diff，大幅减少切换耗时。
  // 仅包含稳定依赖（useCallback/useState setter/ref）的视图可安全 memoize。
  const dashboardContent = useMemo(() => (
    <CustomScrollArea className="flex-1" viewportClassName="flex-1" trackOffsetTop={12} trackOffsetBottom={12}>
      <Suspense fallback={<PageLoadingFallback />}>
        <LazySOTADashboard
          onBack={() => setCurrentView('chat-v2')}
          onNavigate={(view) => setCurrentView(view)}
        />
      </Suspense>
    </CustomScrollArea>
  ), [setCurrentView]);

  const settingsContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazySettings
        onBack={() => setCurrentView('chat-v2')}
        isActive={currentView === 'settings'}
      />
    </Suspense>
  ), [currentView, setCurrentView]);

  const taskDashboardContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <AnkiTasksApp
        onNavigateToChat={(sessionId) => {
          setCurrentView('chat-v2');
          dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_SESSION, { sessionId });
        }}
        onOpenTemplateManagement={() => {
          setIsSelectingTemplate(false);
          setCurrentView('template-management');
        }}
      />
    </Suspense>
  ), [setCurrentView]);

  const skillsManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazySkillsManagementPage /></Suspense>
  ), []);

  const templateJsonPreviewContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyTemplateJsonPreviewPage
        onBack={() => setCurrentView(templateJsonPreviewReturnRef.current)}
      />
    </Suspense>
  ), [setCurrentView]);

  const styleDebugContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyStyleDebugPage />
    </Suspense>
  ), []);

  const learningHubContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazyLearningHubPage /></Suspense>
  ), []);

  const pdfReaderContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}><LazyPdfReader /></Suspense>
  ), []);

  const chatV2Content = useMemo(() => (
    chatV2Blocked
      ? <FeatureUnavailablePanel component="chat_v2" title={t('common:maintenance.chat_unavailable')} />
      : <Suspense fallback={<PageLoadingFallback />}><LazyChatV2Page /></Suspense>
  ), [chatV2Blocked, t]);

  // template-management: 依赖仅在模板选择流程触发时变化，日常视图切换中保持稳定
  const templateManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyTemplateManagementPage
        isSelectingMode={isSelectingTemplate}
        onTemplateSelected={handleTemplateSelected}
        onCancel={handleTemplateSelectionCancel}
        onBackToAnki={() => setCurrentView('task-dashboard')}
        refreshToken={templateManagementRefreshTick}
        onDesktopShellBackVisibilityChange={setTemplateManagementShellBackVisible}
        onOpenJsonPreview={() => {
          templateJsonPreviewReturnRef.current = currentViewRef.current;
          setCurrentView('template-json-preview');
        }}
      />
    </Suspense>
  ), [isSelectingTemplate, handleTemplateSelected, handleTemplateSelectionCancel, templateManagementRefreshTick, setCurrentView]);

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
      extraClass={extraClass}
      extraStyle={extraStyle}
      isBackdrop={isSmallScreen && currentView === 'settings' && view === settingsBackdropView}
      suppressEnterAnimation={isSmallScreen && currentView !== 'settings' && view === settingsClosingViewRef.current}
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
        {/* 移动端：统一顶部导航栏 */}
        {isSmallScreen && (
          <UnifiedMobileHeader
            canGoBack={mobileHeaderCanGoBack}
            onBack={handleMobileHeaderBack}
            canGoForward={unifiedCanGoForward}
            onForward={unifiedGoForward}
            fallbackTitle={desktopShellViewLabel}
            className="fixed top-0 left-0 right-0"
            style={{ zIndex: Z_INDEX.mobileHeader }}
          />
        )}

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
                {currentView === 'learning-hub' ? (
                  <div
                    ref={setDesktopPageHeaderTarget}
                    className="h-full min-w-0 flex-1"
                    data-no-drag
                    data-shell-slot="learning-hub-toolbar"
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
              {/* key 按侧栏类型：整组内容替换时重挂载并播放入场动画（与视图切换同款观感） */}
              <div key={desktopShellSidebarKind} className="desktop-shell-content-enter h-full w-full">
                {desktopShellSidebarElement}
              </div>
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
              ? 'var(--mobile-header-total-height)'
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
                className="shrink-0 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 h-6 px-2 text-xs"
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

              {renderViewLayer('template-json-preview', templateJsonPreviewContent)}

              {/* ★ 废弃视图已移除（2026-01 清理）：irec, irec-management, irec-service-switcher, math-workflow */}

              {/* 笔记模块已整合到 Learning Hub，通过 DSTU 协议访问，不再需要独立入口 */}
              {/* {renderViewLayer('notes', <NotesHome />)} */}

              {/* Learning Hub 学习资源全屏模式（已整合教材库功能） */}
              {renderViewLayer('learning-hub', learningHubContent)}

              {renderViewLayer('sandbox-workbench', <Suspense fallback={<PageLoadingFallback />}><LazySandboxWorkbenchPage /></Suspense>)}

              {renderViewLayer('pdf-reader', pdfReaderContent)}

              {/* 待办事项独立页面 */}
              {renderViewLayer('todo', <Suspense fallback={<PageLoadingFallback />}><LazyTodoPage /></Suspense>)}

              {import.meta.env.DEV && renderViewLayer('crepe-demo', <Suspense fallback={<PageLoadingFallback />}><LazyCrepeDemoPage onBack={() => setCurrentView('settings')} /></Suspense>)}

              {import.meta.env.DEV && renderViewLayer('chat-v2-test', <Suspense fallback={<PageLoadingFallback />}><LazyChatV2IntegrationTest /></Suspense>)}

              {import.meta.env.DEV && renderViewLayer('llm-playground', <Suspense fallback={<PageLoadingFallback />}><LazyLLMOutputPlayground /></Suspense>)}

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
      {/* 全局悬浮调试面板（按需懒加载，避免生产首包引入调试模块） */}
      {debugPanelRequested && (
        <Suspense fallback={null}>
          <LazyGlobalDebugPanel openRequest={debugPanelOpenRequest} />
        </Suspense>
      )}

      {import.meta.env.DEV && isSmallScreen && (
        <Suspense fallback={null}>
          <LazyDevMobileRecoveryFab />
        </Suspense>
      )}

      {/* 命令面板 */}
      <CommandPalette />

      {/* Global Pomodoro Timer */}
      <GlobalPomodoroWidget />

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
      </MobileHeaderProvider>
      </MobileAppNavigationProvider>
      </MobileLayoutProvider>
      </TextContextMenuProvider>
      </CommandPaletteProvider>
  );
}

export default App;
