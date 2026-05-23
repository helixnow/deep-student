import React, { Suspense } from 'react';
import { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import './i18n';
import { useTranslation } from 'react-i18next';
// getCurrentWebviewWindow 已无使用（2026-02 清理）
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
// 🚀 性能优化：Settings, Dashboard, SOTADashboard 改为懒加载
import { CaretLeft, CaretRight, Terminal, Warning, X } from '@phosphor-icons/react';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { TextSwap } from '@/components/ui/TextSwap';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/shad/Sheet';
import { useUIStore } from '@/stores/uiStore';

// 🚀 性能优化：DataImportExport, ImportConversationDialog 改为懒加载
import { CloudStorageSection } from '@/features/settings';
import { NotionDialog, NotionDialogBody } from './components/ui/NotionDialog';
// 🚀 性能优化：Template*, IrecInsightRecall 等页面组件改为懒加载
import { TaskDashboardPage } from '@/components/anki/TaskDashboardPage';
import { useWindowDrag } from './hooks/useWindowDrag';
// 🚀 性能优化：ImageViewer 改为懒加载
import { ModernSidebar } from './components/ModernSidebar';
import { StudyComposeIcon } from './components/icons/StudySidebarIcons';
import { WindowControls } from './components/WindowControls';
import { useFinderStore } from './features/learning-hub/stores/finderStore';
import { MobileLayoutProvider, MobileHeaderProvider, UnifiedMobileHeader, MobileHeaderActiveViewSync, MOBILE_APP_NAVIGATE_EVENT } from '@/components/layout';
import { GlobalPomodoroWidget } from '@/features/pomodoro';
// 🚀 性能优化：IrecServiceSwitcher, IrecGraphFlow, IrecGraphFlowDemo, CrepeDemoPage, ChatV2IntegrationTest, BridgeToIrec 改为懒加载
import { TauriAPI } from './utils/tauriApi';
// ★ MistakeItem 类型导入已废弃（2026-01 清理）
import { isWindows, isMacOS } from './utils/platform';
// 🚀 性能优化：ChatV2Page 改为懒加载，见 lazyComponents.tsx
// 🚀 P0-1 性能优化：NoteEditorPortal 改为懒加载，避免 CrepeEditor → mermaid (~1.6MB) 进入首屏 bundle
const LazyNoteEditorPortal = React.lazy(() => import('./features/notes/NoteEditorPortal').then(m => ({ default: m.NoteEditorPortal })));
// 🚀 性能优化：TreeDragTest, PdfReader, LearningHubPage 改为懒加载
import {
  LearningHubNavigationProvider,
  getGlobalLearningHubNavigation,
  subscribeLearningHubNavigation,
} from './features/learning-hub';
import { setActiveOpenResourceHandler } from './dstu/openResource';
import type { ResourceLocator } from './features/learning-hub/learningHubContracts';
import { getQuickAccessTypeFromPath } from './features/learning-hub/learningHubContracts';
import { pageLifecycleTracker } from './debug-panel/services/pageLifecycleTracker';
import './styles/tailwind.css'; // Tailwind (should be first to provide base/utility layers)
import './styles/shadcn-variables.css'; // 设计令牌：支持亮/暗色变量（必须优先）
import './styles/theme-colors.css';
import './shared/styles/index.css';
import 'overlayscrollbars/overlayscrollbars.css';

import './styles/ios-safe-area.css'; // iOS安全区域适配
import './styles/modern-buttons.css'; // 现代化按钮样式
import './styles/responsive-utilities.css'; // 响应式工具类
// 🚀 性能优化：页面组件改为懒加载
import { NotificationContainer } from './components/NotificationContainer';
import { showGlobalNotification } from './components/UnifiedNotification';
import { CustomScrollArea } from './components/custom-scroll-area';
import { getErrorMessage } from './utils/errorUtils';
import { useAppInitialization } from './hooks/useAppInitialization';
import { useAppUpdater } from './hooks/useAppUpdater';
import type { AppUpdaterController } from './hooks/useAppUpdater';
import { UpdateNotificationDialog } from '@/features/settings';
import { UserAgreementDialog, useUserAgreement } from './components/legal/UserAgreementDialog';
import { useMigrationStatusListener } from './hooks/useMigrationStatusListener';
import useTheme from './hooks/useTheme';
import { emitDebug, getDebugEnabled } from './utils/emitDebug';
import { useDialogControl } from './contexts/DialogControlContext';
import './styles/typography.css'; // 全局排版（字体/字号/行高）
import './styles/shadcn-overrides.css'; // 修复图标尺寸被覆盖的问题
import { MigrationStatusBanner } from './components/system-status/MigrationStatusBanner';
import { SettingsShellSidebar } from '@/features/settings';
import { TodoShellSidebar } from '@/features/todo';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from './app/shell/DesktopShellIcons';
import { settingsMobileSheetCloseButtonClassName } from '@/features/settings';
import { setPendingSettingsTab } from './utils/pendingSettingsTab';
import { useBreakpoint } from './hooks/useBreakpoint';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { useNavigationShortcuts, getNavigationShortcutText } from './hooks/useNavigationShortcuts';
import type { CurrentView as NavigationCurrentView } from './types/navigation';
import { autoSaveScrollPosition, autoRestoreScrollPosition } from './utils/viewStateManager';
import { usePreventScroll } from './hooks/usePreventScroll';
import { CommandPaletteProvider, CommandPalette, registerBuiltinCommands, useCommandPalette } from './command-palette';
import { TextContextMenuProvider } from './components/context-menu/TextContextMenu';
import { useMenuEventBridge } from './menu/menuEventBridge';
import { useCommandEvents, COMMAND_EVENTS } from './command-palette/hooks/useCommandEvents';
import { useEventRegistry } from './hooks/useEventRegistry';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useViewStore } from './stores/viewStore';
import { debugLog } from './debug-panel/debugMasterSwitch';
import { useIsUILabEnabled } from './utils/uiLabToggle';
import { sessionManager } from './features/chat/core/session/sessionManager';
import { setSessionSidebarViewContext } from './features/chat/hooks/useSessionSidebarIndicators';
import { groupCache } from './features/chat/core/store/groupCache';
import { getSessionTitleText } from './features/chat/utils/sessionTitle';
import type { ChatStore } from './features/chat/core/types';
import { getHiddenDraftSessionScope } from './features/chat/pages/draftSession';

import { ViewLayerRenderer } from './app/components';
import { ErrorBoundary } from './components/ErrorBoundary';
import { canonicalizeView } from './app/navigation/canonicalView';
import { DESKTOP_SHELL, getShellSidebarWidth } from './app/shell/desktopShell';
import { getMobileShellCssVars } from './app/shell/mobileShell';

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
  LazyTreeDragTest,
  LazyCrepeDemoPage,
  LazyChatV2IntegrationTest,
  LazyLLMOutputPlayground,
  LazyChatV2Page,
} from './lazyComponents';

// ★ debugLog 别名：将本文件中的 console 调用路由到调试面板，受 debugMasterSwitch 控制
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
const LazyGlobalDebugPanel = React.lazy(() => import('./components/dev/GlobalDebugPanel'));
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

/**
 * 启动时自动更新检查弹窗
 * 仅在启动静默检查发现新版本时显示。
 */
function StartupUpdateNotification({ updater }: { updater: AppUpdaterController }) {
  // 仅在启动检查发现更新时显示弹窗
  const shouldShow = updater.isStartupCheck && updater.available && !!updater.info;

  if (!shouldShow) return null;

  return (
    <UpdateNotificationDialog
      open={shouldShow}
      version={updater.info!.version}
      body={updater.info!.body}
      date={updater.info!.date}
      isMobile={updater.isMobile}
      apkUrl={updater.info!.apkUrl}
      downloading={updater.downloading}
      progress={updater.progress}
      onUpdate={() => updater.downloadAndInstall()}
      onDismiss={() => updater.dismiss()}
      onSkipVersion={(v) => updater.skipVersion(v)}
      onNeverRemind={() => updater.setNeverRemind()}
    />
  );
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
    <CommonTooltip content={`${t('common:command_palette_label', '命令面板')} (${isMac ? '⌘' : 'Ctrl'}+K)`} position="bottom">
      <NotionButton
        variant="ghost"
        size="icon"
        onClick={open}
        className={cn('desktop-shell-toolbar-button', className)}
      >
        <Terminal size={16} />
      </NotionButton>
    </CommonTooltip>
  );
}

function SidebarUpdateBadge({
  visible,
  onClick,
  downloading,
}: {
  visible: boolean;
  onClick: () => void;
  downloading: boolean;
}) {
  if (!visible) return null;

  return (
    <button
      type="button"
      data-slot="sidebar-update-badge"
      className="desktop-shell-update-badge"
      onClick={onClick}
      disabled={downloading}
      aria-label={downloading ? '下载中...' : '点击更新'}
    >
      {downloading ? '下载中' : '更新'}
    </button>
  );
}

function DesktopSidebarAccessory({
  onToggle,
  label,
  collapsed,
  updateVisible,
  onUpdate,
  updateDownloading,
}: {
  onToggle: () => void;
  label: string;
  collapsed: boolean;
  updateVisible: boolean;
  onUpdate: () => void;
  updateDownloading: boolean;
}) {
  return (
    <div className="desktop-shell-accessory-group flex min-w-0 items-center">
      <CommonTooltip content={label} position="bottom">
        <NotionButton
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="desktop-shell-toolbar-button desktop-shell-accessory-button"
          aria-label={label}
        >
          {collapsed ? <SidebarFrameIcon /> : <SidebarFrameWithLeftRailIcon />}
        </NotionButton>
      </CommonTooltip>
      <div
        aria-hidden={collapsed}
        className={cn(
          'overflow-hidden transition-[width,opacity,margin-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
          collapsed ? 'ml-0 w-0 opacity-0' : 'ml-1.5 w-[3.125rem] opacity-100'
        )}
      >
        <div
          className={cn(
            'flex items-center justify-start transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
            collapsed ? '-translate-x-1 opacity-0' : 'translate-x-0 opacity-100'
          )}
        >
          <SidebarUpdateBadge
            visible={updateVisible}
            onClick={onUpdate}
            downloading={updateDownloading}
          />
        </div>
      </div>
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
  backTitle,
  backLabel,
  forwardTitle,
  forwardLabel,
  collapsed,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onNewSession: () => void;
  onTitlebarDoubleClick: () => void | Promise<void>;
  newSessionLabel: string;
  backTitle: string;
  backLabel: string;
  forwardTitle: string;
  forwardLabel: string;
  collapsed: boolean;
}) {
  return (
    <div
      className={cn(
        'desktop-shell-toolbar-group transition-[transform,opacity,margin-right] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
        collapsed ? 'mr-0 translate-x-0 opacity-100' : 'mr-1 translate-x-1 opacity-100'
      )}
    >
      <CommonTooltip content={backTitle} position="bottom">
        <span className="inline-flex">
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={onGoBack}
            disabled={!canGoBack}
            className="desktop-shell-toolbar-button"
            aria-label={backLabel}
          >
            <CaretLeft size={16} />
          </NotionButton>
        </span>
      </CommonTooltip>
      <CommonTooltip content={forwardTitle} position="bottom">
        <span className="inline-flex">
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={onGoForward}
            disabled={!canGoForward}
            className="desktop-shell-toolbar-button"
            aria-label={forwardLabel}
          >
            <CaretRight size={16} />
          </NotionButton>
        </span>
      </CommonTooltip>
      <CommonTooltip content={newSessionLabel} position="bottom">
        <NotionButton
          variant="ghost"
          size="icon"
          onMouseDown={(event) => handleDesktopToolbarButtonMouseDown(event, onTitlebarDoubleClick)}
          onClick={(event) => handleDesktopToolbarButtonClick(event, onNewSession)}
          className="desktop-shell-toolbar-button"
          aria-label={newSessionLabel}
        >
          <StudyComposeIcon className="h-4 w-4" />
        </NotionButton>
      </CommonTooltip>
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
/** 最大保活视图数量（含 pinned）
 *  用户常用 6-7 个视图，设为 8 避免频繁驱逐导致的重新挂载开销。
 *  搭配 useMemo 缓存子树后，保活视图的 re-render 成本接近零。
 */
const MAX_ALIVE_VIEWS = 8;

interface AnnStatusResponse {
  indexed: boolean;
  items: number;
  size_mb: number;
  last_dump_at?: string;
}

/**
 * 学习资源顶栏面包屑导航
 */
function LearningHubTopbarBreadcrumb({ currentView }: { currentView: string }) {
  const { t } = useTranslation('learningHub');
  const currentPath = useFinderStore(state => state.currentPath);
  const quickAccessNavigate = useFinderStore(state => state.quickAccessNavigate);
  const jumpToBreadcrumb = useFinderStore(state => state.jumpToBreadcrumb);

  // 非学习资源页面不显示
  if (currentView !== 'learning-hub') {
    return null;
  }

  // 计算当前视图标题
  const currentTitle = (() => {
    const activeType = getQuickAccessTypeFromPath(currentPath);
    if (!activeType || activeType === 'allFiles') return undefined;
    if (activeType === 'memory') return t('memory.title');
    if (activeType === 'desktop') return t('finder.quickAccess.desktop');
    return t(`finder.quickAccess.${activeType}`);
  })();

  const breadcrumbs = currentPath.breadcrumbs;
  const rootTitle = t('title');

  // 根目录：只显示 "学习资源"
  if (!currentTitle && breadcrumbs.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-sm">
        <span className="font-medium text-foreground">{rootTitle}</span>
      </div>
    );
  }

  // 智能文件夹模式：学习资源 > 全部笔记
  if (currentTitle && breadcrumbs.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-sm">
        <button
          onClick={() => quickAccessNavigate('allFiles')}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {rootTitle}
        </button>
        <CaretRight size={16} className="text-muted-foreground" />
        <span className="font-medium text-foreground">{currentTitle}</span>
      </div>
    );
  }

  // 文件夹导航模式：学习资源 > 文件夹1 > 文件夹2
  return (
    <div className="flex items-center gap-1.5 text-sm overflow-hidden">
      <button
        onClick={() => quickAccessNavigate('allFiles')}
        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
      >
        {rootTitle}
      </button>
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <React.Fragment key={crumb.id || index}>
            <CaretRight size={16} className="text-muted-foreground shrink-0" />
            {isLast ? (
              <span className="font-medium text-foreground truncate max-w-[150px]">{crumb.name}</span>
            ) : (
              <button
                onClick={() => jumpToBreadcrumb(index)}
                className="text-muted-foreground hover:text-foreground transition-colors truncate max-w-[100px]"
              >
                {crumb.name}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function App() {
  // 全面接入新引擎统一管理（在 App 级别避免再手绑流事件）
  const USE_STABLE_STREAM_ENGINE = true;
  // 🚀 应用初始化
  useAppInitialization();

  // 🍎 macOS 原生菜单栏 → 命令系统桥接（其他平台为 no-op）
  useMenuEventBridge();
  
  // 🆕 监听数据治理迁移状态（启动时显示警告/错误通知）
  useMigrationStatusListener();

  // 🆕 用户协议同意检查（合规要求）
  const { needsAgreement, checkAgreement, acceptAgreement } = useUserAgreement();
  useEffect(() => { checkAgreement(); }, [checkAgreement]);

  // 🌍 国际化支持（提前至此处，后续 useEffect 依赖 t）
  const { t, i18n } = useTranslation(['common', 'analysis', 'sidebar', 'command_palette', 'settings']);
  const updater = useAppUpdater();

  // 🆕 维护模式：从 store 读取全局状态
  const maintenanceMode = useSystemStatusStore((s) => s.maintenanceMode);
  const maintenanceReason = useSystemStatusStore((s) => s.maintenanceReason);

  // 🆕 任务3：应用启动时同步后端维护模式状态到前端 store
  useEffect(() => {
    const syncMaintenanceStatus = async () => {
      try {
        const status = await invoke<{ is_in_maintenance_mode: boolean }>('data_governance_get_maintenance_status');
        if (status.is_in_maintenance_mode) {
          useSystemStatusStore.getState().enterMaintenanceMode(
            t('common:maintenance.banner_description', '系统正在进行维护操作，部分功能暂时受限。')
          );
        }
      } catch (err) {
        // 命令可能不存在（旧版后端），静默忽略
        console.warn('[App] 查询后端维护模式状态失败:', err);
      }
    };
    syncMaintenanceStatus();
  }, []); // 仅启动时执行一次

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
  

  // 对话控制（MCP 工具与搜索引擎选择）
  const { selectedMcpTools, selectedSearchEngines } = useDialogControl();
  
  // 响应式检测：移动端布局调整
  const { isSmallScreen } = useBreakpoint();
  const shouldRenderDebugPanel = useMemo(() => getDebugEnabled(), []);

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
    // 监听设置变化事件
    const handleSettingsChange = (ev: any) => {
      if (ev?.detail?.topbarTopMargin) {
        loadSetting();
      }
    };
    try { window.addEventListener('systemSettingsChanged' as any, handleSettingsChange as any); } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => {
      cancelled = true;
      try { window.removeEventListener('systemSettingsChanged' as any, handleSettingsChange as any); } catch { /* non-critical: cleanup */ }
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

    const handleSettingsChange = (event: any) => {
      if (
        event?.detail?.macosFontSmoothing ||
        event?.detail?.settingKey === MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY
      ) {
        void loadFontSmoothingSetting();
      }
    };

    try {
      window.addEventListener('systemSettingsChanged' as any, handleSettingsChange as any);
    } catch {
      /* non-critical: event listener setup may fail in test env */
    }

    return () => {
      cancelled = true;
      try {
        window.removeEventListener('systemSettingsChanged' as any, handleSettingsChange as any);
      } catch {
        /* non-critical: cleanup */
      }
    };
  }, []);

  // 侧边栏半透明：启动时从持久化设置恢复 data attribute
  useEffect(() => {
    let cancelled = false;
    const SIDEBAR_TRANSLUCENT_KEY = 'sidebar.translucent';

    (async () => {
      try {
        const val = await invoke<string | null>('get_setting', { key: SIDEBAR_TRANSLUCENT_KEY });
        if (cancelled) return;
        document.documentElement.setAttribute(
          'data-sidebar-translucent',
          String(val ?? '').trim() === 'true' ? 'true' : 'false',
        );
      } catch {
        if (cancelled) return;
        document.documentElement.setAttribute('data-sidebar-translucent', 'false');
      }
    })();

    return () => { cancelled = true; };
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

    const handleSettingsChange = (event: any) => {
      if (
        event?.detail?.pointerCursor ||
        event?.detail?.settingKey === POINTER_CURSOR_SETTING_KEY
      ) {
        void loadPointerCursorSetting();
      }
    };

    try {
      window.addEventListener('systemSettingsChanged' as any, handleSettingsChange as any);
    } catch {
      /* non-critical: event listener setup may fail in test env */
    }

    return () => {
      cancelled = true;
      try {
        window.removeEventListener('systemSettingsChanged' as any, handleSettingsChange as any);
      } catch {
        /* non-critical: cleanup */
      }
    };
  }, []);
  
  // 🎯 命令面板：注册内置命令
  useEffect(() => {
    const unregister = registerBuiltinCommands();
    return () => {
      unregister();
    };
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

  // page-container 的 top 值：现在 content-body 有 position: relative，
  // page-container 相对于 content-body 定位，content-body 已经在 content-header 之后了
  // 所以 pageContainerTop 应该始终为 0，无论桌面端还是移动端
  const pageContainerTop = 0;
  
  const [currentView, setCurrentViewRaw] = useState<CurrentView>('chat-v2');
  // ★ previousView 用于模板选择返回
  const [previousView, setPreviousView] = useState<CurrentView>('chat-v2');
  const leftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);
  const shellSidebarWidth = getShellSidebarWidth(isSmallScreen);
  const desktopNavigationWidth = !isSmallScreen && leftPanelCollapsed ? 0 : shellSidebarWidth;
  const isDesktopSidebarSurfaceVisible = !isSmallScreen && !leftPanelCollapsed;
  const shouldUseDesktopFloatingAccessory = !isSmallScreen;
  const desktopFloatingAccessoryOffset = isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer + 16 : 16;
  const desktopSidebarToggleLabel = t('common:navigation.toggle_sidebar', '切换边栏');
  const desktopHeaderNavHotzoneLabel = t('chatV2:page.newSession', '新建会话');
  const desktopHeaderTitleHotzoneLabel = t('common:command_palette_label', '命令面板');
  const desktopCollapsedLeadingWidth = 148;
  const desktopTitlebarLeadingInset = !isSmallScreen && leftPanelCollapsed
    ? (isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer : 0) + 16 + desktopCollapsedLeadingWidth
    : 0;
  const desktopFloatingAccessoryWidth = desktopCollapsedLeadingWidth;
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
  const desktopSidebarAccessoryContent = (
    <DesktopSidebarAccessory
      onToggle={useUIStore.getState().toggleLeftPanel}
      label={desktopSidebarToggleLabel}
      collapsed={leftPanelCollapsed}
      updateVisible={!updater.checking && updater.available && !!updater.info}
      onUpdate={() => void updater.performUpdateAction()}
      updateDownloading={updater.downloading}
    />
  );
  const appShellCustomProperties = useMemo(() => ({
    ...getMobileShellCssVars(),
    '--sidebar-width': `${desktopNavigationWidth}px`,
    '--sidebar-expanded-width': `${shellSidebarWidth}px`,
    '--sidebar-collapsed-width': `${desktopNavigationWidth}px`,
    '--shell-navigation-width': `${desktopNavigationWidth}px`,
    '--shell-titlebar-height': `${DESKTOP_SHELL.titlebarBaseHeight + topbarTopMargin}px`,
    '--desktop-titlebar-height': `${DESKTOP_SHELL.titlebarBaseHeight + topbarTopMargin}px`,
    '--topbar-safe-area': `${topbarTopMargin}px`,
    '--sidebar-header-height': '65px', // 左侧导航栏第一个图标到分隔线的高度
  }) as React.CSSProperties, [desktopNavigationWidth, shellSidebarWidth, topbarTopMargin]);
  const [templateManagementRefreshTick, setTemplateManagementRefreshTick] = useState(0);
  const currentViewRef = useRef<CurrentView>('chat-v2');
  const isSmallScreenRef = useRef(isSmallScreen);
  const [mobileSettingsSheetOpen, setMobileSettingsSheetOpen] = useState(false);
  const viewSwitchStartRef = useRef<{ from: CurrentView; to: CurrentView; startTime: number } | null>(null);
  
  // 🚀 性能优化：追踪已访问的页面，只渲染访问过的页面
  // 使用 Map<view, timestamp> 实现 LRU 淘汰，避免保活视图无限增长
  const [visitedViews, setVisitedViews] = useState<Map<CurrentView, number>>(
    () => new Map<CurrentView, number>([['chat-v2', Date.now()]])
  );

  useEffect(() => {
    isSmallScreenRef.current = isSmallScreen;
    if (!isSmallScreen) {
      setMobileSettingsSheetOpen(false);
    }
  }, [isSmallScreen]);

  // 包装 setCurrentView，添加视图切换追踪 + LRU 淘汰
  const setCurrentView = useCallback((newView: CurrentView | ((prev: CurrentView) => CurrentView)) => {
    const prevView = currentViewRef.current;
    const rawTargetView = typeof newView === 'function' ? newView(prevView) : newView;
    const targetView = canonicalizeView(rawTargetView);

    if (isSmallScreenRef.current && targetView === 'settings') {
      setMobileSettingsSheetOpen(true);
      return;
    }

    if (isSmallScreenRef.current) {
      setMobileSettingsSheetOpen(false);
    }

    if (targetView !== prevView) {
      const startTime = performance.now();
      viewSwitchStartRef.current = { from: prevView, to: targetView, startTime };
      
      pageLifecycleTracker.log(
        'app', 
        'App.tsx', 
        'view_switch', 
        `${prevView} → ${targetView}`
      );
    }

    // 使用 startTransition 将 LRU 更新 + 视图切换 打包在同一个 transition 中。
    // 导航历史由 useNavigationHistory 的 useEffect 推入（始终基于 committed state，避免快速点击竞态）。
    startTransition(() => {
      // 🚀 LRU 更新：记录访问时间戳，超过阈值时淘汰最久未访问的非 pinned 视图
      setVisitedViews(prev => {
        const now = Date.now();
        const next = new Map(prev);
        next.set(targetView, now);

        // 淘汰逻辑：仅在超出上限时移除最旧的非 pinned 视图
        if (next.size > MAX_ALIVE_VIEWS) {
          let oldestView: CurrentView | null = null;
          let oldestTime = Infinity;
          for (const [view, ts] of next) {
            if (PINNED_VIEWS.has(view)) continue;
            if (view === targetView) continue;
            if (ts < oldestTime) {
              oldestTime = ts;
              oldestView = view;
            }
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

  // 🎯 监听导入对话事件
  useEffect(() => {
    const onOpenImportConversation = () => {
      setShowImportConversation(true);
    };
    window.addEventListener('DSTU_OPEN_IMPORT_CONVERSATION', onOpenImportConversation);
    return () => { window.removeEventListener('DSTU_OPEN_IMPORT_CONVERSATION', onOpenImportConversation); };
  }, []);

  // 🎯 监听云存储设置事件
  useEffect(() => {
    const onOpenCloudStorage = () => {
      setShowCloudStorageSettings(true);
    };
    window.addEventListener('DSTU_OPEN_CLOUD_STORAGE_SETTINGS', onOpenCloudStorage);
    return () => { window.removeEventListener('DSTU_OPEN_CLOUD_STORAGE_SETTINGS', onOpenCloudStorage); };
  }, []);

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
  useEffect(() => {
    const dispatchFrontendErrorDebug = (payload: any) => {
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

    const onError = (ev: any) => {
      try {
        const isResourceError = ev && ev.target && ev.target !== window;
        if (isResourceError) {
          const src = ev.target?.currentSrc || ev.target?.src || ev.target?.href || '';
          // 忽略开发代理的 SSE 410/Gone 噪声
          if (typeof src === 'string' && src.includes('/sse-proxy/')) {
            return;
          }
        }
        const payload = isResourceError
          ? {
            type: 'ResourceError',
            tagName: ev.target?.tagName,
            src: ev.target?.currentSrc || ev.target?.src || ev.target?.href,
            baseURI: ev.target?.baseURI,
          }
          : {
            type: 'Error',
            message: ev?.message || String(ev?.error || 'Unknown error'),
            stack: (ev?.error && ev?.error?.stack) || undefined,
            filename: ev?.filename,
            lineno: ev?.lineno,
            colno: ev?.colno,
          };
        dispatchFrontendErrorDebug(payload);
        // 控制台兜底
        console.error('[DSTU][FRONTEND_ERROR]', payload);
      } catch (e) { debugLog.warn('[App] onError handler failed:', e); }
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      try {
        const reason = (ev && (ev as any).reason) || 'Unknown rejection';
        const message = typeof reason === 'string' ? reason : (reason?.message || String(reason));
        
        // ★ 2026-02-04: 过滤 Tauri HTTP 插件的已知 bug (fetch_cancel_body)
        if (message.includes('fetch_cancel_body') || message.includes('http.fetch_cancel_body')) {
          return; // 静默忽略此错误
        }
        
        const payload = {
          type: 'UnhandledRejection',
          message,
          stack: reason?.stack || undefined,
        };
        dispatchFrontendErrorDebug(payload);
      } catch (e) { debugLog.warn('[App] onRejection handler failed:', e); }
    };
    try {
      window.addEventListener('error', onError as any, true);
      window.addEventListener('unhandledrejection', onRejection as any);
    } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => {
      try {
        window.removeEventListener('error', onError as any, true);
        window.removeEventListener('unhandledrejection', onRejection as any);
      } catch { /* non-critical: cleanup */ }
    };
  }, []);

  // Milkdown Markdown Editor: global open event from Settings > 关于
  useEffect(() => {
    const open = () => setCurrentView('learning-hub');
    try {
      window.addEventListener('OPEN_MARKDOWN_EDITOR' as any, open as any);
    } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => {
      try { window.removeEventListener('OPEN_MARKDOWN_EDITOR' as any, open as any); } catch { /* non-critical: cleanup */ }
    };
  }, []);

  // Notes: global open event from Settings > 关于
  useEffect(() => {
    const openNotes = () => setCurrentView('learning-hub');
    try { window.addEventListener('OPEN_NOTES' as any, openNotes as any); } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => { try { window.removeEventListener('OPEN_NOTES' as any, openNotes as any); } catch { /* non-critical: cleanup */ } };
  }, []);

  // 全局新建桥接：即便事件在隐藏页面里已被处理，也要把壳层切到对应输入页
  useEffect(() => {
    const handleCreateChatSession = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail;
      if (
        detail?.action &&
        detail.action !== 'create-session' &&
        detail.action !== 'create-group'
      ) {
        return;
      }
      setCurrentView('chat-v2');
    };

    const handleCreateNote = () => {
      setCurrentView('learning-hub');
    };

    try {
      window.addEventListener(COMMAND_EVENTS.CHAT_NEW_SESSION, handleCreateChatSession);
      window.addEventListener('modern-sidebar:group-action', handleCreateChatSession);
      window.addEventListener(COMMAND_EVENTS.NOTES_CREATE_NEW, handleCreateNote);
    } catch {
      /* non-critical: event listener setup may fail in test env */
    }

    return () => {
      try {
        window.removeEventListener(COMMAND_EVENTS.CHAT_NEW_SESSION, handleCreateChatSession);
        window.removeEventListener('modern-sidebar:group-action', handleCreateChatSession);
        window.removeEventListener(COMMAND_EVENTS.NOTES_CREATE_NEW, handleCreateNote);
      } catch {
        /* non-critical: cleanup */
      }
    };
  }, []);

  // Crepe minimal demo：用于排查编辑器性能的纯净示例（仅开发模式）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openCrepeDemo = () => setCurrentView('crepe-demo');
    try {
      window.addEventListener('OPEN_CREPE_DEMO' as any, openCrepeDemo as any);
      (window as any).openCrepeDemo = openCrepeDemo;
    } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => {
      try {
        window.removeEventListener('OPEN_CREPE_DEMO' as any, openCrepeDemo as any);
        if ((window as any).openCrepeDemo === openCrepeDemo) {
          delete (window as any).openCrepeDemo;
        }
      } catch { /* non-critical: cleanup */ }
    };
  }, []);

  // ★ OPEN_RF_DEMO 事件已废弃（图谱演示已移除）

  // 顶部安全区功能已移除

  // ★ 2026-01 清理：知识库导航统一跳转到 Learning Hub
  useEffect(() => {
    const handleNavigateToKnowledgeBase = (event: CustomEvent<{ preferTab?: 'manage' | 'memory'; locator?: ResourceLocator }>) => {
      // 跳转到 Learning Hub（知识库入口已整合）
      setCurrentView('learning-hub');
      // 等待 React 渲染完成后发送事件让 Learning Hub 处理具体导航
      requestAnimationFrame(() => {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('learningHubNavigateToKnowledge', {
            detail: event.detail
          }));
        }, 0);
      });
    };
    try { window.addEventListener('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE' as any, handleNavigateToKnowledgeBase as any); } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => { try { window.removeEventListener('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE' as any, handleNavigateToKnowledgeBase as any); } catch { /* non-critical: cleanup */ } };
  }, []);

  // Tree test: global open event for testing（仅开发模式）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openTreeTest = () => setCurrentView('tree-test');
    try { 
      window.addEventListener('OPEN_TREE_TEST' as any, openTreeTest as any); 
      (window as any).openTreeTest = openTreeTest;
    } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => { 
      try { 
        window.removeEventListener('OPEN_TREE_TEST' as any, openTreeTest as any); 
        delete (window as any).openTreeTest;
      } catch { /* non-critical: cleanup */ } 
    };
  }, []);

  // Chat V2 Integration Test: 集成测试页面入口（仅开发模式）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openChatV2Test = () => setCurrentView('chat-v2-test');
    try { 
      window.addEventListener('OPEN_CHAT_V2_TEST' as any, openChatV2Test as any); 
      (window as any).openChatV2Test = openChatV2Test;
    } catch { /* non-critical: event listener setup may fail in test env */ }
    return () => { 
      try { 
        window.removeEventListener('OPEN_CHAT_V2_TEST' as any, openChatV2Test as any); 
        delete (window as any).openChatV2Test;
      } catch { /* non-critical: cleanup */ } 
    };
  }, []);

  // 通用导航事件：支持从任意组件跳转到指定视图
  const handleNavigateToView = useCallback((evt: Event) => {
    const detail = ((evt as CustomEvent).detail || {}) as {
      view?: string;
      returnTo?: string;
      returnPayload?: any;
      openResource?: string;
    };
    if (!detail.view) return;

    const targetView = canonicalizeView(detail.view);
    setTextbookReturnContext(null);

    if (targetView !== currentViewRef.current) {
      setCurrentView(targetView);
    }

    if (detail.openResource && targetView === 'learning-hub') {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('learningHubOpenResource', {
          detail: { dstuPath: detail.openResource },
        }));
      }, 150);
    }
  }, [setCurrentView, setTextbookReturnContext]);

  useEventRegistry([
    {
      target: 'window',
      type: 'NAVIGATE_TO_VIEW',
      listener: handleNavigateToView as EventListener,
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

  // 统一的导航处理：Learning Hub 内部优先，否则使用页面级导航
  // 🐛 BUG-1: 通过页面级导航抵达 LH 时，前进优先使用页面级（如有），
  //   避免 LH 残留的内部前进历史遮蔽页面级前进目标。
  const unifiedCanGoBack = isInLearningHub && learningHubNav?.canGoBack
    ? true
    : navigationHistory.canGoBack;
  const unifiedCanGoForward = (() => {
    if (isInLearningHub) {
      // 通过页面级导航抵达 LH 且页面级有前进 → 页面级前进优先
      if (arrivedAtLHViaPageNavRef.current && navigationHistory.canGoForward) {
        return true;
      }
      // LH 内部有前进（用户主动 LH 后退产生的，或页面级前进已耗尽）
      if (learningHubNav?.canGoForward) {
        return true;
      }
    }
    return navigationHistory.canGoForward;
  })();
  const unifiedGoBack = useCallback(() => {
    if (isInLearningHub && learningHubNav?.canGoBack) {
      learningHubNav.goBack();
      // 🐛 BUG-1: 用户主动使用 LH 内部后退，清除页面级抵达标记
      arrivedAtLHViaPageNavRef.current = false;
    } else {
      pageNavInProgressRef.current = true;
      navigationHistory.goBack();
      pageNavInProgressRef.current = false;
    }
  }, [isInLearningHub, learningHubNav, navigationHistory]);
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
    navigationHistory.goForward();
  }, [isInLearningHub, learningHubNav, navigationHistory]);
  
  // ⌨️ 键盘和鼠标快捷键支持
  useNavigationShortcuts({
    onBack: unifiedGoBack,
    onForward: unifiedGoForward,
    canGoBack: unifiedCanGoBack,
    canGoForward: unifiedCanGoForward,
  });

  // 🎯 P0-01 修复: 监听命令面板导航事件
  // 🎯 P1-04 修复: 监听 GLOBAL_SHORTCUT_SETTINGS 等事件
  const handleShortcutSettings = useCallback(() => {
    setCurrentView('settings');
    // 触发设置页面跳转到快捷键 tab
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'shortcuts' } }));
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

  // 其他页面导航事件监听（已迁移到 useEventRegistry）
  const handleNavigateToExamSheet = useCallback((evt: Event) => {
    const detail = (evt as CustomEvent<{ sessionId: string; cardId?: string; mistakeId?: string }>).detail;
    const sessionId = detail?.sessionId;
    if (!sessionId) return;

    // 重定向到 Learning Hub，并发送事件让 Learning Hub 打开题目集
    setCurrentView('learning-hub');
    // 等待 React 渲染完成后发送事件（rAF 确保渲染帧，setTimeout(0) 确保微任务完成）
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('learningHubOpenExam', {
          detail: {
            sessionId,
            cardId: detail?.cardId ?? null,
            mistakeId: detail?.mistakeId ?? null,
          },
        }));
      }, 0);
    });
  }, [setCurrentView]);

  // P1-18: 从其他页面跳转到指定翻译
  const handleNavigateToTranslation = useCallback((evt: Event) => {
    const detail = (evt as CustomEvent<{ translationId: string; title?: string }>).detail;
    const translationId = detail?.translationId;
    if (!translationId) return;

    // 重定向到 Learning Hub，并发送事件让 Learning Hub 打开翻译
    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('learningHubOpenTranslation', {
          detail: {
            translationId,
            title: detail?.title,
          },
        }));
      }, 0);
    });
  }, [setCurrentView]);

  // P1-18: 从其他页面跳转到指定作文
  const handleNavigateToEssay = useCallback((evt: Event) => {
    const detail = (evt as CustomEvent<{ essayId: string; title?: string }>).detail;
    const essayId = detail?.essayId;
    if (!essayId) return;

    // 重定向到 Learning Hub，并发送事件让 Learning Hub 打开作文
    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('learningHubOpenEssay', {
          detail: {
            essayId,
            title: detail?.title,
          },
        }));
      }, 0);
    });
  }, [setCurrentView]);

  // 从 ChatV2Page 笔记工具跳转到指定笔记
  const handleNavigateToNote = useCallback((evt: Event) => {
    const detail = (evt as CustomEvent<{ noteId: string; source?: string }>).detail;
    const noteId = detail?.noteId;
    if (!noteId) return;

    // 重定向到 Learning Hub，并发送事件让 Learning Hub 打开笔记
    setCurrentView('learning-hub');
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('learningHubOpenNote', {
          detail: { noteId, source: detail?.source },
        }));
      }, 0);
    });
  }, [setCurrentView]);

  // 预填充聊天输入框并跳转到 chat-v2
  const handlePrefillChatInput = useCallback((evt: Event) => {
    const event = evt as CustomEvent<{ content: string; autoSend?: boolean }>;
    const { content, autoSend } = event?.detail ?? {};
    if (!content) return;

    // 切换到 chat-v2 视图
    setCurrentView('chat-v2');

    // 延迟设置输入框内容，等待视图切换完成
    setTimeout(() => {
      // 通过事件通知 ChatV2Page 设置输入框内容
      window.dispatchEvent(new CustomEvent('CHAT_V2_SET_INPUT', {
        detail: { content, autoSend }
      }));
    }, 150);
  }, [setCurrentView]);

  // ★ irec 相关事件监听已废弃（图谱模块已移除）
  // ★ navigateToMistakeById 事件监听已废弃（2026-01 清理）
  useEventRegistry([
    { target: 'window', type: 'navigateToExamSheet', listener: handleNavigateToExamSheet },
    { target: 'window', type: 'navigateToTranslation', listener: handleNavigateToTranslation },
    { target: 'window', type: 'navigateToEssay', listener: handleNavigateToEssay },
    { target: 'window', type: 'navigateToNote', listener: handleNavigateToNote },
    { target: 'window', type: 'PREFILL_CHAT_INPUT', listener: handlePrefillChatInput },
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

  useEffect(() => {
    const handleMobileSidebarNavigate = (event: Event) => {
      const view = (event as CustomEvent<{ view?: CurrentView }>).detail?.view;
      if (!view) return;
      handleViewChange(view);
    };

    window.addEventListener(MOBILE_APP_NAVIGATE_EVENT, handleMobileSidebarNavigate);
    return () => window.removeEventListener(MOBILE_APP_NAVIGATE_EVENT, handleMobileSidebarNavigate);
  }, [handleViewChange]);

  // 历史管理已迁移到 useNavigationHistory Hook

  // 开发者工具快捷键支持 (仅生产模式，仅 Ctrl+Shift+I / Cmd+Alt+I)
  // 注：F12 由命令系统 dev.open-devtools 统一处理，此处不再重复
  useEffect(() => {
    const isProduction = !window.location.hostname.includes('localhost') && 
                        !window.location.hostname.includes('127.0.0.1') &&
                        !window.location.hostname.includes('tauri.localhost');
    
    if (!isProduction) return;
    
    const handleKeyDown = async (event: KeyboardEvent) => {
      const isDevtoolsShortcut = 
        (event.ctrlKey && event.shiftKey && event.key === 'I') ||
        (event.metaKey && event.altKey && event.key === 'I');
      
      if (isDevtoolsShortcut) {
        event.preventDefault();
        event.stopPropagation();
        try {
          const { WebviewWindow } = await import('@tauri-apps/api/window');
          const webview: any = WebviewWindow.getCurrent();
          if (await (webview.isDevtoolsOpen?.() ?? Promise.resolve(false))) {
            await webview.closeDevtools?.();
          } else {
            await webview.openDevtools?.();
          }
        } catch (e) {
          debugLog.warn('[App] devtools open/close failed, trying toggle:', e);
          try {
            const { WebviewWindow } = await import('@tauri-apps/api/window');
            const webview: any = WebviewWindow.getCurrent();
            await webview.toggleDevtools?.();
          } catch (e2) { debugLog.warn('[App] devtools toggle also failed:', e2); }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

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

  // 监听调试面板的导航请求
  useEffect(() => {
    const handleNavigateToTab = (event: Event) => {
      const customEvent = event as CustomEvent<{ tabName: string }>;
      const tabName = customEvent.detail?.tabName;
      
      // tabName 到 CurrentView 的映射
      const tabToViewMap: Record<string, CurrentView> = {
        'anki': 'task-dashboard',
        'settings': 'settings',
        'chat-v2': 'chat-v2',
        'learning-hub': 'learning-hub',
      };
      
      const targetView = tabToViewMap[tabName];
      if (targetView) {
        console.log(`[App] 导航请求: ${tabName} -> ${targetView}`);
        handleViewChange(targetView);
      } else {
        console.warn(`[App] 未知的 tabName: ${tabName}`);
      }
    };
    
    window.addEventListener('navigate-to-tab', handleNavigateToTab as EventListener);
    return () => window.removeEventListener('navigate-to-tab', handleNavigateToTab as EventListener);
  }, []);

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
    />
    // navigationHistory 已从 deps 中移除：ModernSidebar 仅解构 currentView/onViewChange/topbarTopMargin
  ), [currentView, handleViewChange, leftPanelCollapsed, noopToggle, startDragging, topbarTopMargin]);

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

  const desktopShellSidebarElement = currentView === 'settings'
    ? settingsShellSidebarElement
    : currentView === 'todo'
    ? todoShellSidebarElement
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

  const [annProgress, setAnnProgress] = useState<{ loading: boolean; status?: AnnStatusResponse | null }>({ loading: false, status: null });

  // Poll ANN status on startup
  useEffect(() => {
    let pollInterval: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    
    const checkAnnStatus = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (cancelled) return;
        const status = await invoke<AnnStatusResponse>('get_ann_status');
        if (cancelled) return;
        const building = !status.indexed && status.items > 0;
        setAnnProgress({ loading: building, status });
        
        if (building) {
          // Keep polling if building index
          pollInterval = setTimeout(checkAnnStatus, 2000);
        }
      } catch (e) {
        // ANN 功能可能尚未启用，只在非预期错误时输出警告
        const errMsg = String(e);
        if (!errMsg.includes('not found') && !errMsg.includes('not implemented')) {
          console.warn('ANN status check failed:', e);
        }
      }
    };
    
    checkAnnStatus();
    return () => {
      cancelled = true;
      if (pollInterval) clearTimeout(pollInterval);
    };
  }, []);

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
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_NEW_SESSION));
      });
      return;
    }

    window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.CHAT_NEW_SESSION));
  }, [currentView, setCurrentView]);
  const openCommandPalette = useCallback(() => {
    commandPaletteTriggerRef.current?.();
  }, []);
  const [currentChatHeaderTitle, setCurrentChatHeaderTitle] = useState('');
  const [currentChatHeaderGroupName, setCurrentChatHeaderGroupName] = useState('');
  const currentChatHeaderStoreUnsubscribeRef = useRef<(() => void) | null>(null);
  const currentChatHeaderSubscribedSessionIdRef = useRef<string | null>(null);
  const desktopHeaderNewSessionTooltipLabel = currentChatHeaderGroupName
    ? t('chatV2:page.newSessionInGroup', {
      groupName: currentChatHeaderGroupName,
      defaultValue: '在 {{groupName}} 中新建会话',
    })
    : desktopHeaderNavHotzoneLabel;
  const shouldShowDesktopHeaderNavControls = currentView !== 'settings' && currentView !== 'todo';
  const desktopHeaderNavControls = (
    <DesktopHeaderNavControls
      canGoBack={unifiedCanGoBack}
      canGoForward={unifiedCanGoForward}
      onGoBack={unifiedGoBack}
      onGoForward={unifiedGoForward}
      onNewSession={handleCreateChatSession}
      onTitlebarDoubleClick={toggleDesktopWindowMaximize}
      newSessionLabel={desktopHeaderNewSessionTooltipLabel}
      backTitle={t('common:navigation.back_tooltip', { shortcut: navigationShortcuts.back })}
      backLabel={t('common:navigation.back')}
      forwardTitle={t('common:navigation.forward_tooltip', { shortcut: navigationShortcuts.forward })}
      forwardLabel={t('common:navigation.forward')}
      collapsed={leftPanelCollapsed}
    />
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

    return getSessionTitleText(state.title, t('chatV2:page.untitled', '未命名会话'));
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
      setCurrentChatHeaderTitle('');
      setCurrentChatHeaderGroupName('');
      return;
    }

    const chatHeaderStore = sessionManager.get(chatHeaderSessionId);
    setCurrentChatHeaderTitle(getChatHeaderTitleFromStoreState(chatHeaderStore?.getState()));
    setCurrentChatHeaderGroupName(getChatHeaderGroupNameFromStoreState(chatHeaderStore?.getState()));
  }, [getChatHeaderGroupNameFromStoreState, getChatHeaderTitleFromStoreState, t]);

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

  useEffect(() => {
    window.addEventListener('chat-v2:groups-updated', syncCurrentChatHeaderGroupName);
    return () => {
      window.removeEventListener('chat-v2:groups-updated', syncCurrentChatHeaderGroupName);
    };
  }, [syncCurrentChatHeaderGroupName]);

  const desktopShellViewLabel = useMemo(() => {
    if (currentView === 'chat-v2') {
      return currentChatHeaderTitle;
    }

    const labels: Partial<Record<CurrentView, string>> = {
      'chat-v2': t('sidebar:navigation.chat_v2', '新会话'),
      'learning-hub': t('sidebar:navigation.learning_hub', '学习资源'),
      'settings': t('sidebar:navigation.settings', '系统'),
      'dashboard': t('common:navigation.dashboard', '总览'),
      'task-dashboard': t('sidebar:navigation.anki_generation', '制卡任务'),
      'skills-management': t('sidebar:navigation.skills_management', '技能管理'),
      'data-management': t('common:navigation.data_management', '数据管理'),
      'template-management': t('sidebar:navigation.template_management', '模板库'),
      'ui-lab': t('sidebar:navigation.ui_lab', '样式调试'),
      'template-json-preview': t('common:navigation.template_json_preview', '模板预览'),
      'pdf-reader': t('common:navigation.pdf_reader', 'PDF 阅读器'),
      'tree-test': t('common:navigation.tree_test', 'Tree Test'),
      'crepe-demo': t('common:navigation.crepe_demo', 'Crepe Demo'),
      'chat-v2-test': t('common:navigation.chat_v2_test', 'Chat V2 Test'),
      'llm-playground': 'LLM Playground',
    };

    return labels[currentView] ?? t('common:app.default_header', '新对话');
  }, [currentChatHeaderTitle, currentView, t]);

  // 🚀 性能优化：memoize 各视图内容，防止切换视图时所有已缓存视图子树被重新协调
  // 当 App 因 currentView 变化而重渲染时，useMemo 返回相同的 React 元素引用，
  // React 协调器看到相同引用后会跳过整个子树的 diff，大幅减少切换耗时。
  // 仅包含稳定依赖（useCallback/useState setter/ref）的视图可安全 memoize。
  const dashboardContent = useMemo(() => (
    <CustomScrollArea className="flex-1" viewportClassName="flex-1" trackOffsetTop={12} trackOffsetBottom={12}>
      <Suspense fallback={<PageLoadingFallback />}>
        <LazySOTADashboard onBack={() => setCurrentView('chat-v2')} />
      </Suspense>
    </CustomScrollArea>
  ), [setCurrentView]);

  const settingsContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazySettings onBack={() => setCurrentView('chat-v2')} />
    </Suspense>
  ), [setCurrentView]);

  const closeMobileSettingsSheet = useCallback(() => {
    setMobileSettingsSheetOpen(false);
  }, []);

  const mobileSettingsSheetContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazySettings onBack={closeMobileSettingsSheet} mobilePresentation="sheet" />
    </Suspense>
  ), [closeMobileSettingsSheet]);

  const taskDashboardContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <TaskDashboardPage
        onNavigateToChat={(sessionId) => {
          setCurrentView('chat-v2');
          window.dispatchEvent(
            new CustomEvent('navigate-to-session', { detail: { sessionId } })
          );
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
    <Suspense fallback={<PageLoadingFallback />}><LazyChatV2Page /></Suspense>
  ), []);

  // template-management: 依赖仅在模板选择流程触发时变化，日常视图切换中保持稳定
  const templateManagementContent = useMemo(() => (
    <Suspense fallback={<PageLoadingFallback />}>
      <LazyTemplateManagementPage
        isSelectingMode={isSelectingTemplate}
        onTemplateSelected={handleTemplateSelected}
        onCancel={handleTemplateSelectionCancel}
        onBackToAnki={() => setCurrentView('task-dashboard')}
        refreshToken={templateManagementRefreshTick}
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
      <LazyDataImportExport />
      <LazyImportConversationDialog
        open={showImportConversation}
        onOpenChange={setShowImportConversation}
        onImportSuccess={handleImportConversationSuccess}
      />
    </Suspense>
  ), [showImportConversation, handleImportConversationSuccess]);

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
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background dark:bg-zinc-950">
        <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }
  if (needsAgreement === true) {
    return <UserAgreementDialog onAccept={acceptAgreement} />;
  }

  return (
    <CommandPaletteProvider
        currentView={currentView}
        navigate={commandPaletteNavigate}
        toggleTheme={toggleDarkMode}
        isDarkMode={isDarkMode}
        switchLanguage={switchLanguage}
      >
      <TextContextMenuProvider>
      <MobileLayoutProvider>
      <MobileHeaderProvider>
      {/* ★ 移动端顶栏活跃视图同步 - 必须在 MobileHeaderProvider 内部 */}
      <MobileHeaderActiveViewSync activeView={currentView} />
      <LearningHubNavigationProvider>
      <div
        data-shell-role="app-shell"
        data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}
        className={cn(
          'relative flex h-dvh w-full overflow-hidden font-sans text-foreground'
          // 背景由 App.css 的 [data-shell-role="app-shell"] 规则根据 data-sidebar-visible
          // 切换到 --shell-navigation-surface / --shell-backdrop，保证工作区左下凹角
          // 透出的颜色与侧边栏严格同源，避免主题切换时出现色差（与左上凹角一致）。
          //
          // 注意：刻意不在此层加 `transition-colors duration-500`。
          // 工作区圆角凹陷处会透出本层背景；如果本层做颜色过渡，而相邻的 workspace、
          // titlebar 是瞬间变色，主题切换中间帧就会出现色差（左下凹角白底闪烁问题）。
          // 业界最佳实践（Notion / Linear / VS Code）：主题切换瞬间生效，避免接缝问题。
        )}
        style={appShellCustomProperties}
      >
        {/* Skip navigation link for keyboard accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-[9999] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:text-sm focus:font-medium focus:shadow-lg"
        >
          {t('common:aria.skip_to_main_content', '跳转到主内容')}
        </a>
        {/* 移动端：统一顶部导航栏 */}
        {isSmallScreen && (
          <UnifiedMobileHeader
            canGoBack={unifiedCanGoBack}
            onBack={unifiedGoBack}
            className="fixed top-0 left-0 right-0 z-[1100]"
          />
        )}

        {/* 桌面端：固定顶部栏 - 覆盖整个顶部包括侧边栏 */}
        {!isSmallScreen && (
        <header
          data-shell-layer="window-chrome"
          className="desktop-shell-titlebar fixed top-0 left-0 right-0 z-[1100] grid transition-[grid-template-columns] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
          style={{
            paddingTop: `${topbarTopMargin}px`,
            height: `${DESKTOP_SHELL.titlebarBaseHeight + topbarTopMargin}px`,
            minHeight: `${DESKTOP_SHELL.titlebarBaseHeight + topbarTopMargin}px`,
            gridTemplateColumns: `${desktopNavigationWidth}px minmax(0, 1fr)`,
          }}
          onMouseDown={handleDesktopTitlebarMouseDown}
        >
          {shouldUseDesktopFloatingAccessory ? (
            <div
              className="pointer-events-none absolute z-20 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
              style={{
                left: `${desktopFloatingAccessoryOffset}px`,
                top: `${topbarTopMargin}px`,
                height: `${DESKTOP_SHELL.titlebarBaseHeight}px`,
                width: `${desktopFloatingAccessoryWidth}px`,
                opacity: 1,
              }}
            >
              <div className="pointer-events-auto inline-flex h-full max-w-full items-center justify-between gap-1.5 overflow-hidden pr-1.5">
                <div className="flex items-center">
                  {desktopSidebarAccessoryContent}
                </div>
                {shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}
              </div>
            </div>
          ) : null}

          <div
            className={cn(
              'desktop-shell-header-cell desktop-shell-header-cell--nav relative z-10 flex min-w-0 items-center justify-end overflow-hidden transition-[padding] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none',
              leftPanelCollapsed ? 'px-0' : 'px-4'
            )}
          >
            <div
              className="desktop-shell-header-hotzone flex min-w-0 items-center justify-end"
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
            className="desktop-shell-header-cell desktop-shell-header-cell--workspace relative z-10 flex min-w-0 items-center justify-between px-5 transition-[padding-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
            style={{ paddingLeft: `${20 + desktopTitlebarLeadingInset}px` }}
          >
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

              <div className="min-w-0 pl-1">
                <div className="min-w-0 desktop-shell-header-title">
                  {currentView === 'learning-hub' ? (
                    <LearningHubTopbarBreadcrumb currentView={currentView} />
                  ) : (
                    <TextSwap
                      text={desktopShellViewLabel}
                      className="block max-w-full truncate"
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2" data-no-drag>
              {isWindows() && <WindowControls />}
            </div>
          </div>
        </header>
        )}

        {/* 桌面端：主导航侧边栏 */}
        {!isSmallScreen ? (
          <div
            className={cn(
              'h-full flex-shrink-0',
              'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
              leftPanelCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'
            )}
          >
            {desktopShellSidebarElement}
          </div>
        ) : null}

        <div
          data-shell-layer="workspace"
          data-sidebar-visible={isDesktopSidebarSurfaceVisible ? 'true' : 'false'}
          className="desktop-shell-workspace flex flex-1 flex-col h-full min-w-0 relative overflow-hidden"
          style={{
            // 移动端：48px 基础高度 + topbarTopMargin，桌面端：使用原有标题栏高度
            paddingTop: isSmallScreen ? 'var(--mobile-header-total-height)' : `${DESKTOP_SHELL.titlebarBaseHeight + topbarTopMargin}px`,
          }}
        >
          <MigrationStatusBanner />

          {/* 🆕 维护模式全局横幅 */}
          {maintenanceMode && (
            <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm">
              <Warning size={16} className="shrink-0" />
              <span className="font-medium shrink-0">{t('common:maintenance.banner_title', '维护模式')}</span>
              <span className="flex-1 truncate">
                {maintenanceReason || t('common:maintenance.banner_description', '系统正在进行维护操作，部分功能暂时受限。')}
              </span>
              <NotionButton
                variant="ghost"
                size="sm"
                className="shrink-0 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 h-6 px-2 text-xs"
                onClick={() => {
                  if (currentView === 'settings') {
                    // 已在设置页面，直接通过事件切换到数据治理标签
                    window.dispatchEvent(
                      new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'data-governance' } })
                    );
                  } else {
                    setPendingSettingsTab('data-governance');
                    setCurrentView('settings');
                  }
                }}
              >
                {t('common:maintenance.go_to_data_governance', '查看详情')}
              </NotionButton>
            </div>
          )}

          <main
            id="main-content"
            role="main"
            className={cn(
              "flex-1 relative overflow-hidden w-full"
              // 移除 pb-16: InputBarUI 已通过 bottom: 64px 处理底部导航间距
              // 之前的 pb-16 会缩小 content-body 高度，导致输入框被双重偏移
            )}
            data-tour-id="analysis-main"
          >
            <div ref={contentBodyRef} className={`content-body w-full h-full relative ${currentView === 'settings' ? 'settings-view' : ''}`}>
              {/* ★ 废弃视图已移除（2026-01 清理）：analysis, library, exam-sheet */}

              {renderViewLayer('dashboard', dashboardContent, 'overflow-hidden')}

              {!isSmallScreen && renderViewLayer('settings', settingsContent, 'overflow-hidden')}

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

              {import.meta.env.DEV && renderViewLayer('tree-test', <Suspense fallback={<PageLoadingFallback />}><LazyTreeDragTest /></Suspense>)}

              {import.meta.env.DEV && renderViewLayer('crepe-demo', <Suspense fallback={<PageLoadingFallback />}><LazyCrepeDemoPage onBack={() => setCurrentView('settings')} /></Suspense>)}

              {import.meta.env.DEV && renderViewLayer('chat-v2-test', <Suspense fallback={<PageLoadingFallback />}><LazyChatV2IntegrationTest /></Suspense>)}

              {import.meta.env.DEV && renderViewLayer('llm-playground', <Suspense fallback={<PageLoadingFallback />}><LazyLLMOutputPlayground /></Suspense>)}

              {/* Chat V2 正式入口 */}
              {renderViewLayer('chat-v2', chatV2Content)}

              {/* ★ 废弃视图已移除（2026-01 清理）：bridge-to-irec */}

            </div>
          </main>
        </div>

        {isSmallScreen && (
          <Sheet open={mobileSettingsSheetOpen} onOpenChange={setMobileSettingsSheetOpen}>
            <SheetContent
              side="bottom"
              data-slot="mobile-settings-sheet"
              overlayClassName="bg-[color:var(--mobile-sheet-scrim)]"
              hideCloseButton
              className="flex h-[min(86dvh,calc(100dvh-0.5rem))] max-h-[calc(100dvh-0.5rem)] flex-col overflow-hidden rounded-b-none rounded-t-[24px] border-x-0 border-b-0 border-t border-[color:var(--mobile-sheet-border)] bg-[color:var(--mobile-sheet-surface)] p-0 text-[color:var(--mobile-sheet-foreground)] shadow-[var(--mobile-sheet-shadow)] duration-200 ease-out"
            >
              <div className="flex h-7 shrink-0 items-center justify-center">
                <div className="h-1 w-12 rounded-full bg-[color:var(--mobile-sheet-handle)]" />
              </div>
              <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[color:var(--mobile-sheet-header-border)] px-5 pb-3 pt-1">
                <div className="min-w-0">
                  <SheetTitle className="text-[18px] font-semibold leading-6 text-[color:var(--mobile-sheet-foreground)]">
                    {t('settings:title', '系统设置')}
                  </SheetTitle>
                  <SheetDescription className="mt-1 text-[13px] leading-5 text-[color:var(--mobile-sheet-muted-foreground)]">
                    {t('settings:study_ui_descriptions.default', '应用偏好与数据选项')}
                  </SheetDescription>
                </div>
                <SheetClose asChild>
                  <button
                    type="button"
                    className={settingsMobileSheetCloseButtonClassName}
                    aria-label={t('common:actions.close', '关闭')}
                  >
                    <X size={20} />
                  </button>
                </SheetClose>
              </div>
              {mobileSettingsSheetContent}
            </SheetContent>
          </Sheet>
        )}

      </div>
      {/* CmdK 由 Notes 模块内部管理 */}
      {annProgress.loading && (
        <div className="ann-progress-bar" style={{
          position: 'fixed',
          top: pageContainerTop,
          left: 0,
          right: 0,
          height: '4px',
          backgroundColor: 'hsl(var(--primary))',
          zIndex: 10000,
          animation: 'pulse 2s ease-in-out infinite'
        }}>
          <div style={{
            position: 'absolute',
            top: '4px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'hsl(var(--popover))',
            color: 'hsl(var(--popover-foreground))',
            padding: '4px 8px',
            borderRadius: '0 0 4px 4px',
            fontSize: '12px'
          }}>
            {t('common:ann_indexing', { count: annProgress.status?.items ?? 0 })}
          </div>
        </div>
      )}
      
      {/* 全局通知容器 */}
      <NotificationContainer />

      {/* 启动时自动更新检查弹窗 */}
      <StartupUpdateNotification updater={updater} />
      
      {/* 云存储配置弹窗 - 移到全局位置避免被 renderViewLayer 的 visibility 影响 */}
      <NotionDialog open={showCloudStorageSettings} onOpenChange={setShowCloudStorageSettings} maxWidth="max-w-[560px]">
        <NotionDialogBody>
          <CloudStorageSection isDialog />
        </NotionDialogBody>
      </NotionDialog>
      {/* 全局悬浮调试面板（按需懒加载，避免生产首包引入调试模块） */}
      {shouldRenderDebugPanel && (
        <Suspense fallback={null}>
          <LazyGlobalDebugPanel />
        </Suspense>
      )}

      {/* 命令面板 */}
      <CommandPalette />

      {/* Global Pomodoro Timer */}
      <GlobalPomodoroWidget />

      {/* 调试面板入口由全局悬浮按钮统一控制 */}
      
      {/* 笔记编辑器 Portal - 用于白板远程桌面模式（已改造为 useNotesOptional，无需 NotesProvider） */}
      <Suspense fallback={null}>
        <LazyNoteEditorPortal />
      </Suspense>
      </LearningHubNavigationProvider>
      </MobileHeaderProvider>
      </MobileLayoutProvider>
      </TextContextMenuProvider>
      </CommandPaletteProvider>
  );
}

export default App;
