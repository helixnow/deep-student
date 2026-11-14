import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CaretLeft, CaretRight, Terminal, Warning } from '@phosphor-icons/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogBody } from '@/components/ui/DsDialog';
import { TextSwap } from '@/components/ui/TextSwap';
import { WindowControls } from '@/components/WindowControls';
import { DesktopShellTitleEditor } from '@/components/DesktopShellTitleEditor';
import { NotificationContainer } from '@/components/NotificationContainer';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { MigrationStatusBanner } from '@/components/system-status/MigrationStatusBanner';
import { WelcomeOnboardingDialog } from '@/components/onboarding/WelcomeOnboardingDialog';
import {
  MobileLayoutProvider,
  MobileHeaderProvider,
  MobileHeaderNavProvider,
  MobileHeaderActiveViewSync,
  MobileAppNavigationProvider,
} from '@/components/layout';
import { CommandPalette } from '@/command-palette/CommandPalette';
import { CommandPaletteProvider, useCommandPalette } from '@/command-palette/CommandPaletteProvider';
import { TextContextMenuProvider } from '@/components/context-menu/TextContextMenu';
import { GlobalPomodoroWidget } from '@/features/pomodoro/components/GlobalPomodoroWidget';
import { DueMistakesReviewHost } from '@/features/learning-today/DueMistakesReviewHost';
import { DailySprintHost, ExamReadinessHud } from '@/components/exam-sprint';
import { LearningHubNavigationProvider } from '@/features/learning-hub';
import { GoalStatusChip } from '@/features/chat/components/GoalStatusChip';
import { StudyComposeIcon } from '@/components/icons/StudySidebarIcons';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from './DesktopShellIcons';
import { TauriAPI } from '@/utils/tauriApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { isMacOS, isWindows } from '@/utils/platform';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { Z_INDEX } from '@/config/zIndex';
import type { CurrentView } from '@/types/navigation';
import type { ShellView } from '@/ui-kernel/contracts/shell';
import { PageLoadingFallback } from '@/lazyComponents';
import { CardsHubTabs } from './CardsHubTabs';
import { DesktopShellSidebarLayers } from './DesktopShellSidebarLayers';
import { DesktopSidebarResizeHandle } from './DesktopSidebarResizeHandle';
import { DesktopShellSidebarPortalProvider } from './DesktopShellSidebarPortal';
import { DesktopShellHeaderPortalProvider } from './DesktopShellHeaderPortal';
import {
  DESKTOP_SHELL,
  getShellSidebarMaxWidth,
} from './desktopShell';
import {
  handleDesktopToolbarButtonClick,
  handleDesktopToolbarButtonMouseDown,
  handleHeaderHotzoneClick,
  handleHeaderHotzoneKeyDown,
} from './desktopHeaderHotzone';
import { useDesktopSidebarLayout } from './useDesktopSidebarLayout';
import { useDesktopWindowMaximizeToggle } from '@/app/hooks/useDesktopWindowMaximizeToggle';
import type { useDesktopTitlebarInteractions } from '@/app/hooks/useDesktopTitlebarInteractions';
import { LazyAgentBridge, LazyWorkbenchDesktop } from '@/app/workbench/lazyDesktop';

const CloudStorageSection = React.lazy(() =>
  import('@/features/settings/components/CloudStorageSection').then(m => ({ default: m.CloudStorageSection }))
);
const LazyGlobalDebugPanel = React.lazy(() => import('@/components/dev/GlobalDebugPanel'));
const LazyDevMobileRecoveryFab = React.lazy(() => import('@/dev/DevMobileRecoveryFab'));

export interface AppShellChromeProps {
  t: TFunction;
  isSmallScreen: boolean;
  workbenchActive: boolean;
  leftPanelCollapsed: boolean;
  currentView: CurrentView;
  isDemoShell: boolean;

  /** 命令面板 / 主题 / 语言 */
  commandPaletteNavigate: (view: CurrentView, params?: Record<string, unknown>) => void;
  toggleDarkMode: () => void;
  isDarkMode: boolean;
  switchLanguage: (lang: 'zh-CN' | 'en-US') => void;

  /** 移动壳与全局导航 */
  handleMobileAppNavigate: (view: CurrentView) => boolean;
  mobileHeaderCanGoBack: boolean;
  handleMobileHeaderBack: () => void;
  unifiedCanGoBack: boolean;
  unifiedCanGoForward: boolean;
  unifiedGoBack: () => void;
  unifiedGoForward: () => void;
  desktopShellViewLabel: string;
  cardsHubMobileTabs: React.ReactNode;
  handleViewChange: (view: CurrentView) => void;
  setCurrentView: (view: CurrentView) => void;

  /** 侧栏布局（宽度、拖拽、标题栏高度、CSS 变量） */
  layout: ReturnType<typeof useDesktopSidebarLayout>;
  /** 标题栏热区 / 新建会话 / 命令面板触发 */
  interactions: ReturnType<typeof useDesktopTitlebarInteractions>;
  toggleDesktopWindowMaximize: () => void | Promise<void>;
  activeShell: ShellView['shell'] | undefined;
  currentChatHeaderTitle: string;
  currentChatHeaderGroupName: string;
  currentChatHeaderSessionId: string | null;
  saveCurrentChatHeaderTitle: (sessionId: string, title: string) => Promise<void>;
  setDesktopPageHeaderTarget: (node: HTMLDivElement | null) => void;
  setDesktopChatHeaderTarget: (node: HTMLDivElement | null) => void;

  /** 侧栏门户与保活层 */
  desktopShellSidebarPortalValue: React.ComponentProps<typeof DesktopShellSidebarPortalProvider>['value'];
  desktopShellHeaderPortalValue: React.ComponentProps<typeof DesktopShellHeaderPortalProvider>['value'];
  desktopShellSidebarKind: React.ComponentProps<typeof DesktopShellSidebarLayers>['activeKind'];
  desktopShellSidebarLayers: React.ComponentProps<typeof DesktopShellSidebarLayers>['layers'];
  registeredViewLayers: React.ReactNode;
  contentBodyRef: React.RefObject<HTMLDivElement | null>;

  /** 维护模式横幅 */
  maintenanceMode: boolean;
  maintenanceReason: string;
  maintenanceRequiresRestart: boolean;

  /** 全局浮层 */
  showCloudStorageSettings: boolean;
  setShowCloudStorageSettings: (open: boolean) => void;
  debugPanelRequested: boolean;
  debugPanelOpenRequest: number;
  welcomeOnboardingOpen: boolean;
  dismissWelcomeOnboarding: () => void;
}

/**
 * App 的壳层渲染树：providers → 桌面标题栏 / 侧栏 / 工作区 → 全局浮层。
 *
 * W38：从 App.tsx 原样搬出（DOM 结构、data-* 属性、条件与事件绑定不变）。
 * 视图内容仍由 `useViewLayer` 组装的 `registeredViewLayers` 传入，保持 children 引用稳定。
 */
export function AppShellChrome(props: AppShellChromeProps) {
  const {
    t, isSmallScreen, workbenchActive, leftPanelCollapsed, currentView, isDemoShell,
    commandPaletteNavigate, toggleDarkMode, isDarkMode, switchLanguage,
    handleMobileAppNavigate, mobileHeaderCanGoBack, handleMobileHeaderBack,
    unifiedCanGoBack, unifiedCanGoForward, unifiedGoBack, unifiedGoForward,
    desktopShellViewLabel, cardsHubMobileTabs, handleViewChange, setCurrentView,
    layout, interactions, toggleDesktopWindowMaximize, activeShell,
    currentChatHeaderTitle, currentChatHeaderGroupName, currentChatHeaderSessionId,
    saveCurrentChatHeaderTitle, setDesktopPageHeaderTarget, setDesktopChatHeaderTarget,
    desktopShellSidebarPortalValue, desktopShellHeaderPortalValue,
    desktopShellSidebarKind, desktopShellSidebarLayers, registeredViewLayers, contentBodyRef,
    maintenanceMode, maintenanceReason, maintenanceRequiresRestart,
    showCloudStorageSettings, setShowCloudStorageSettings,
    debugPanelRequested, debugPanelOpenRequest, welcomeOnboardingOpen, dismissWelcomeOnboarding,
  } = props;

  const {
    appShellRef,
    appShellCustomProperties,
    isDesktopSidebarSurfaceVisible,
    isDesktopSidebarResizing,
    shellTitlebarTopInset,
    shellTitlebarOccupiedHeight,
    desktopNavigationWidth,
    desktopSidebarToggleLabel,
    desktopSidebarResizeLabel,
    handleDesktopSidebarResizeStart,
    handleDesktopSidebarResize,
    handleDesktopSidebarResizeEnd,
    toggleDesktopSidebar,
  } = layout;
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
  } = interactions;

  const desktopFloatingAccessoryOffset = isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer + 16 : 16;
  const desktopHeaderNavHotzoneLabel = t('chatV2:page.newSession');
  const desktopHeaderTitleHotzoneLabel = t('common:command_palette_label');
  const desktopHeaderIconButtonSize = 32;
  const desktopHeaderControlGap = 4;
  // 收起态标题栏前导控件 = 侧栏开关 + DesktopHeaderNavControls 的三个按钮
  const desktopCollapsedControlCount = 4;
  const desktopCollapsedLeadingWidth =
    desktopHeaderIconButtonSize * desktopCollapsedControlCount
    + desktopHeaderControlGap * (desktopCollapsedControlCount - 1)
    + 16;
  const desktopTitlebarLeadingInset = !isSmallScreen && leftPanelCollapsed
    ? (isMacOS() ? DESKTOP_SHELL.macTrafficLightsSpacer : 0) + 16 + desktopCollapsedLeadingWidth
    : 0;
  const desktopHeaderNewSessionTooltipLabel = currentChatHeaderGroupName
    ? t('chatV2:page.newSessionInGroup', { groupName: currentChatHeaderGroupName })
    : desktopHeaderNavHotzoneLabel;
  const shouldShowDesktopSidebarToggle = !activeShell?.hideExpandedSidebarToggle || leftPanelCollapsed;
  const shouldShowDesktopHeaderNavControls =
    !(activeShell?.sidebarOwnsBackNavigation ?? false) || leftPanelCollapsed;
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
          onToggle={toggleDesktopSidebar}
          label={desktopSidebarToggleLabel}
          collapsed={leftPanelCollapsed}
        />
      ) : null}
      {shouldShowDesktopHeaderNavControls ? desktopHeaderNavControls : null}
    </div>
  );

  return (
    <CommandPaletteProvider
        currentView={currentView}
        workbenchActive={workbenchActive}
        navigate={commandPaletteNavigate}
        toggleTheme={toggleDarkMode}
        isDarkMode={isDarkMode}
        switchLanguage={switchLanguage}
      >
      <Suspense fallback={null}>
        <LazyAgentBridge workbenchActive={workbenchActive} />
      </Suspense>
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
                {activeShell?.toolbarSlot ? (
                  <div
                    ref={setDesktopPageHeaderTarget}
                    className="h-full min-w-0 flex-1"
                    data-no-drag
                    data-shell-slot={activeShell.toolbarSlot}
                  />
                ) : activeShell?.chatHeader && currentChatHeaderSessionId && currentChatHeaderTitle ? (
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
                {activeShell?.cardsHubTabs ? (
                  <CardsHubTabs
                    variant="titlebar"
                    currentView={currentView}
                    onNavigate={handleViewChange}
                    className="ml-3"
                  />
                ) : null}

                <ExamReadinessHud variant="study-space-header" className="ml-3" />

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
                activeShell?.contentClass,
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
              registeredViewLayers
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
      <DailySprintHost />

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
  const isMac = isMacOS();

  useEffect(() => {
    onOpenReady?.(open);

    return () => {
      onOpenReady?.(null);
    };
  }, [onOpenReady, open]);
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {`${t('common:command_palette_label')} (${isMac ? '⌘' : 'Ctrl'}+K)`}
      </TooltipContent>
    </Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <DsButton
            variant="ghost"
            size="icon"
            onClick={onToggle}
            className="desktop-shell-toolbar-button desktop-shell-accessory-button"
            aria-label={label}
          >
            {collapsed ? <SidebarFrameIcon /> : <SidebarFrameWithLeftRailIcon />}
          </DsButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
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
        </TooltipTrigger>
        <TooltipContent side="bottom">{backTitle}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
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
        </TooltipTrigger>
        <TooltipContent side="bottom">{forwardTitle}</TooltipContent>
      </Tooltip>
      {showNewSession ? (
        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent side="bottom">{newSessionLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
