import React, { useMemo, useSyncExternalStore } from "react";
import {
  CaretRight,
  Database,
  GearSix,
  List,
  NotePencil,
  Pulse,
  User,
  X,
} from "@phosphor-icons/react";

import { useAppSettings } from "@/components/settings/AppSettingsProvider";
import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { getAppLayoutPolicy } from "@/lib/app-layout-policy";
import {
  APP_LAYOUT_TOKENS,
  getHeaderTopInset,
  getMacTitlebarControlTopInset,
  getMainAreaTopOffset,
  getNavigationSurfaceClass,
  getMainWorkspaceSurfaceClass,
  getOverlayLeadingInset,
  getShellBackdropClass,
  getSplitSeamClass,
  getTitlebarMode,
  shouldShowCustomWindowControls,
  type DesktopPlatform,
} from "@/lib/app-shell";
import {
  getBrowserResponsiveEnvironment,
  getServerResponsiveEnvironment,
  subscribeResponsiveEnvironment,
} from "@/lib/responsive-env";
import { cn } from "@/lib/utils";

import { FramelessResizeHandles } from "./FramelessResizeHandles";
import { ShellButton } from "./ShellButton";
import { Sidebar } from "./Sidebar";
import { SidebarUpdateBadge } from "./SidebarUpdateBadge";
import { Titlebar } from "./Titlebar";
import { WindowControls } from "./WindowControls";

function SidebarDockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 256 256" className="size-[18px] fill-current">
      <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H80V200H40ZM216,200H96V56H216V200Z" />
    </svg>
  );
}

const mobileSettingsSheetTabs = [
  { id: "general", slot: "general", label: "通用设置", icon: <GearSix size={20} weight="regular" /> },
  { id: "about", slot: "account", label: "账号管理", icon: <User size={20} weight="regular" /> },
  { id: "advanced", slot: "data", label: "数据管理", icon: <Database size={20} weight="regular" />, trailingIcon: <CaretRight size={14} weight="bold" /> },
] as const;

type AppChromeProps = {
  desktopPlatform: DesktopPlatform;
  currentMode: "app" | "settings";
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  activeSettingsTab: string;
  folderItems: Array<{ id: string; label: string; icon: React.ReactNode; active: boolean; count: number }>;
  settingsNavItems: Array<{ id: string; label: string; icon: React.ReactNode }>;
  threadItems: Array<{ id: number | string; title: string; active: boolean; meta?: string; folderId: string; pinned?: boolean }>;
  appContent: React.ReactNode;
  settingsContent: React.ReactNode;
  onToggleMobileSidebar: () => void;
  onToggleSidebarCollapsed: () => void;
  onOpenSettings: () => void;
  onReturnToApp: () => void;
  onSelectSettingsTab: (tabId: string) => void;
};

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function AppChrome({
  activeSettingsTab,
  appContent,
  currentMode,
  desktopPlatform,
  folderItems,
  mobileSidebarOpen,
  onOpenSettings,
  onReturnToApp,
  onSelectSettingsTab,
  onToggleMobileSidebar,
  onToggleSidebarCollapsed,
  sidebarCollapsed,
  settingsContent,
  settingsNavItems,
  threadItems,
}: AppChromeProps) {
  const { settings } = useAppSettings();
  const { windowBackgroundPreference } = useTheme();
  const titlebarMode = useMemo(() => getTitlebarMode(desktopPlatform), [desktopPlatform]);
  const responsiveEnvironment = useSyncExternalStore(
    subscribeResponsiveEnvironment,
    getBrowserResponsiveEnvironment,
    getServerResponsiveEnvironment,
  );
  const layoutPolicy = useMemo(
    () => getAppLayoutPolicy(responsiveEnvironment),
    [responsiveEnvironment],
  );
  const isCompactViewport = layoutPolicy.isCompact;
  const shouldRenderDrawerSidebar = layoutPolicy.sidebarMode === "drawer";
  const shouldRenderDockedSidebar = layoutPolicy.sidebarMode === "docked";
  const shouldPinSidebarOpen = currentMode === "settings" && shouldRenderDockedSidebar;
  const isSidebarVisible = shouldRenderDrawerSidebar
    ? mobileSidebarOpen
    : !sidebarCollapsed || shouldPinSidebarOpen;
  const headerTopInset = getHeaderTopInset(
    isSidebarVisible,
    titlebarMode,
    settings.titlebarTopInset,
  );
  const showFloatingSidebarToggle = false;
  const showResizeHandles = titlebarMode === "frameless" && hasTauriRuntime();
  const shouldRenderMobileSettingsSheet = layoutPolicy.formFactor === "phone";
  const isMobileSettingsSheetOpen = currentMode === "settings" && shouldRenderMobileSettingsSheet;
  const shouldShowAppSurface = currentMode === "app" || isMobileSettingsSheetOpen;
  const mainAreaTopOffset = getMainAreaTopOffset(isSidebarVisible, titlebarMode);
  const mainDragHotspotHeight = mainAreaTopOffset + headerTopInset + 46;
  const collapsedSidebarToggleTop = mainAreaTopOffset + headerTopInset + 6;
  const isDockedSidebarExpanded = shouldRenderDockedSidebar && isSidebarVisible;
  const dockedSidebarSurfaceClass = getNavigationSurfaceClass(windowBackgroundPreference);
  const mainWorkspaceChromeClass = getNavigationSurfaceClass(windowBackgroundPreference);
  const mainWorkspaceSurfaceClass = getMainWorkspaceSurfaceClass(windowBackgroundPreference);
  const splitSeamClass = getSplitSeamClass(windowBackgroundPreference);
  const handleToggleSidebar = () => {
    if (shouldRenderDrawerSidebar) {
      onToggleMobileSidebar();
      return;
    }

    onToggleSidebarCollapsed();
  };
  const handleMobileSettingsSheetOpenChange = (open: boolean) => {
    if (!open) {
      onReturnToApp();
    }
  };

  const appHeaderTitle = "新对话";
  const showDesktopHeaderStatus = !isCompactViewport;
  const showCompactHeaderActions = isCompactViewport;
  const activeSettingsItem = settingsNavItems.find((item) => item.id === activeSettingsTab);
  const settingsPageTitle = activeSettingsItem?.label ?? "设置";
  const settingsScrollPaddingTop = `calc(${mainDragHotspotHeight + 28}px + var(--safe-area-top))`;
  const settingsScrollPaddingBottom = `calc(2.5rem + var(--safe-area-bottom))`;
  const settingsScrollPaddingLeft = "calc(var(--page-gutter-inline) + var(--layout-safe-area-left))";
  const settingsScrollPaddingRight = "calc(var(--page-gutter-inline) + var(--layout-safe-area-right))";
  const toggleLabel = isSidebarVisible ? "收起侧边栏" : "展开侧边栏";
  const sidebarToggleAccessoryOffset =
    isCompactViewport ? 16 : titlebarMode === "native-transparent" ? getOverlayLeadingInset(titlebarMode) : 16;
  const titlebarAccessoryInset =
    sidebarToggleAccessoryOffset + APP_LAYOUT_TOKENS.MAC_TITLE_LEADING_OFFSET_AFTER_TOGGLE;
  const sharedTrafficLightsAccessoryInset =
    titlebarAccessoryInset +
    APP_LAYOUT_TOKENS.MAC_TITLE_LEADING_OFFSET_AFTER_TOGGLE +
    APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE;
  const sharedTrafficLightsAccessoryWidth = isDockedSidebarExpanded
    ? APP_LAYOUT_TOKENS.FLOATING_SIDEBAR_WIDTH - sidebarToggleAccessoryOffset - 16
    : sharedTrafficLightsAccessoryInset - sidebarToggleAccessoryOffset;
  const sidebarToggleAccessoryContent = (
    <div data-slot="compact-leading-sidebar-accessory" className="flex items-center gap-1.5">
      <ShellButton
        variant="icon"
        onClick={handleToggleSidebar}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          isCompactViewport && "rounded-full bg-card/85 shadow-sm shadow-black/5 hover:bg-card",
        )}
        aria-label={toggleLabel}
      >
        {isCompactViewport ? <List size={21} weight="regular" /> : <SidebarDockIcon />}
      </ShellButton>
      {!isCompactViewport ? <SidebarUpdateBadge className="shrink-0" /> : null}
    </div>
  );
  const sharedTrafficLightsAccessoryContent = (
    <div
      className="flex items-center justify-between pr-1.5 transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
      style={{ width: sharedTrafficLightsAccessoryWidth }}
    >
      <div className="flex items-center">
        <ShellButton
          variant="icon"
          onClick={handleToggleSidebar}
          className="text-muted-foreground hover:text-foreground"
          aria-label={toggleLabel}
        >
          <SidebarDockIcon />
        </ShellButton>
        <div
          aria-hidden={isSidebarVisible}
          className={cn(
            "overflow-hidden transition-[width,opacity,margin-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
            !isSidebarVisible ? "ml-1.5 w-[calc(var(--button-icon-size)+0.125rem)] opacity-100" : "ml-0 w-0 opacity-0",
          )}
        >
          <div
            className={cn(
              "flex w-[var(--button-icon-size)] items-center justify-center transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
              !isSidebarVisible ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
            )}
          >
            <ShellButton
              variant="icon"
              className="text-muted-foreground hover:text-foreground"
              tabIndex={!isSidebarVisible ? undefined : -1}
              aria-label="新建对话"
            >
              <NotePencil size={18} weight="regular" />
            </ShellButton>
          </div>
        </div>
      </div>
      <SidebarUpdateBadge className="shrink-0" />
    </div>
  );
  const sidebarToggleAccessory = !isSidebarVisible ? (
    sidebarToggleAccessoryContent
  ) : null;
  const sharedTrafficLightsAccessory =
    desktopPlatform === "macos" && titlebarMode === "native-transparent" && !isCompactViewport && currentMode === "app"
      ? (
        <div data-slot="traffic-lights-accessory"
          className="pointer-events-none absolute z-30"
          style={{
            left: sidebarToggleAccessoryOffset,
            top: getMacTitlebarControlTopInset(titlebarMode),
          }}
        >
          <div className="pointer-events-auto">{sharedTrafficLightsAccessoryContent}</div>
        </div>
      ) : null;
  const titlebarLeadingInset = !isDockedSidebarExpanded
    ? sharedTrafficLightsAccessory
      ? sharedTrafficLightsAccessoryInset
      : sidebarToggleAccessory
      ? titlebarAccessoryInset
      : 0
    : 0;

  return (
    <div
      data-compact={layoutPolicy.isCompact ? "true" : "false"}
      data-density={layoutPolicy.density}
      data-form-factor={layoutPolicy.formFactor}
      data-platform={desktopPlatform}
      data-shell-mode={layoutPolicy.shellMode}
      data-sidebar-collapsed={isDockedSidebarExpanded ? "false" : "true"}
      data-sidebar-mode={layoutPolicy.sidebarMode}
      data-sidebar-visible={isSidebarVisible ? "true" : "false"}
      className={cn(
        "relative flex h-dvh w-screen overflow-hidden font-sans text-foreground subpixel-antialiased transition-colors duration-200 ease-out motion-reduce:transition-none",
        getShellBackdropClass(desktopPlatform, titlebarMode, windowBackgroundPreference),
      )}
      style={{ zoom: settings.interfaceScale / 100 }}
    >
      <FramelessResizeHandles enabled={showResizeHandles} />

      <div className="relative z-0 flex min-w-0 flex-1 overflow-hidden">
        {sharedTrafficLightsAccessory}

        {shouldRenderDrawerSidebar ? (
          <Sheet
            open={shouldRenderDrawerSidebar && isSidebarVisible}
            onOpenChange={(open) => {
              if (open !== isSidebarVisible) {
                handleToggleSidebar();
              }
            }}
          >
            <SheetContent side="left" className="w-[min(92vw,19rem)] border-r p-0">
              <SheetTitle className="sr-only">侧边栏</SheetTitle>
              <SheetDescription className="sr-only">
                移动端侧边栏，可切换对话、学习资源和设置。
              </SheetDescription>
              <Sidebar
                activeSettingsTab={activeSettingsTab}
                closeOnSelect={shouldRenderDrawerSidebar}
                currentMode={currentMode}
                folderItems={folderItems}
                isSidebarVisible={isSidebarVisible}
                isSidebarClosing={false}
                onOpenSettings={onOpenSettings}
                onReturnToApp={onReturnToApp}
                onSelectSettingsTab={onSelectSettingsTab}
                onToggleSidebar={handleToggleSidebar}
                settingsNavItems={settingsNavItems}
                showFloatingSidebarToggle={showFloatingSidebarToggle}
                threadItems={threadItems}
                titlebarMode={titlebarMode}
                windowBackgroundPreference={windowBackgroundPreference}
              />
            </SheetContent>
          </Sheet>
        ) : shouldRenderDockedSidebar ? (
          <div
            data-floating-sidebar-layer
            className={cn(
              "relative z-20 shrink-0 overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
              dockedSidebarSurfaceClass,
            )}
            style={{ width: isDockedSidebarExpanded ? APP_LAYOUT_TOKENS.FLOATING_SIDEBAR_WIDTH : 0 }}
          >
            <div
              className={cn(
                "h-full w-68 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
                isDockedSidebarExpanded ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
              )}
            >
              <Sidebar
                activeSettingsTab={activeSettingsTab}
                closeOnSelect={shouldRenderDrawerSidebar}
                currentMode={currentMode}
                folderItems={folderItems}
                isSidebarVisible={isDockedSidebarExpanded}
                isSidebarClosing={false}
                onOpenSettings={onOpenSettings}
                onReturnToApp={onReturnToApp}
                onSelectSettingsTab={onSelectSettingsTab}
                onToggleSidebar={handleToggleSidebar}
                settingsNavItems={settingsNavItems}
                showFloatingSidebarToggle={showFloatingSidebarToggle}
                threadItems={threadItems}
                titlebarMode={titlebarMode}
                windowBackgroundPreference={windowBackgroundPreference}
              />
            </div>
          </div>
        ) : null}

        {shouldRenderMobileSettingsSheet ? (
          <Sheet open={isMobileSettingsSheetOpen} onOpenChange={handleMobileSettingsSheetOpenChange}>
            <SheetContent
              side="bottom"
              data-slot="mobile-settings-sheet"
              overlayClassName="bg-[rgba(0,0,0,0.72)]"
              className="h-[calc(100dvh-1.75rem)] max-h-[calc(100dvh-1.75rem)] overflow-y-auto rounded-t-[2rem] border-0 bg-[#26272b] px-6 pb-[calc(2rem+var(--safe-area-bottom))] pt-7 text-white shadow-[0_-24px_80px_rgba(0,0,0,0.28)] [&>button]:hidden"
            >
              <header data-slot="mobile-settings-sheet-header" className="flex items-start justify-between gap-5">
                <div className="space-y-2">
                  <SheetTitle className="text-2xl font-semibold tracking-[-0.03em] text-white">
                    系统设置
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    移动端系统设置面板，可调整主题和语言。
                  </SheetDescription>
                </div>
                <SheetClose asChild>
                  <button
                    type="button"
                    aria-label="关闭系统设置"
                    className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-white/86 transition-colors hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-white/30"
                  >
                    <X size={28} weight="regular" />
                  </button>
                </SheetClose>
              </header>

              <nav
                data-slot="mobile-settings-sheet-nav"
                className="mt-8 grid grid-cols-[1.08fr_0.96fr_1fr] gap-2 pb-1"
              >
                {mobileSettingsSheetTabs.map((item) => {
                  const isActiveMobileSettingsTab = activeSettingsTab === item.id;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-slot={`mobile-settings-sheet-nav-${item.slot}`}
                      aria-pressed={isActiveMobileSettingsTab}
                      onClick={isActiveMobileSettingsTab ? undefined : () => onSelectSettingsTab(item.id)}
                      className={cn(
                        "flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-[1.05rem] px-1.5 text-[0.86rem] font-medium tracking-[-0.02em] transition-colors",
                        isActiveMobileSettingsTab
                          ? "bg-white/10 text-white"
                          : "text-white/72 hover:bg-white/7 hover:text-white/88",
                      )}
                    >
                      {item.icon}
                      <span className="whitespace-nowrap">{item.label}</span>
                      {"trailingIcon" in item ? item.trailingIcon : null}
                    </button>
                  );
                })}
              </nav>

              <div
                data-slot="mobile-settings-sheet-real-content"
                data-theme="dark"
                data-window-background="opaque"
                className="mt-10 border-t border-white/8 pt-6 [--background:#26272b] [--border:rgba(255,255,255,0.12)] [--foreground:#f5f5f5] [--interactive-hover:rgba(255,255,255,0.08)] [--interactive-selected:rgba(255,255,255,0.14)] [--muted-foreground:rgba(255,255,255,0.58)] [--secondary:#303136] [--shell-panel-strong:#2b2c31] [--touch-target-size:var(--control-height-touch)] [&_input[type=range]]:min-h-11"
              >
                {settingsContent}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}

        <main
          aria-label={currentMode === "settings" ? `设置 - ${settingsPageTitle}` : undefined}
          className={cn(
            "relative z-10 flex min-w-0 flex-1 overflow-hidden",
            isDockedSidebarExpanded && mainWorkspaceChromeClass,
          )}
        >
          {isDockedSidebarExpanded ? (
            <div
              aria-hidden="true"
              className={cn("pointer-events-none absolute inset-y-0 left-0 z-20 w-px", splitSeamClass)}
            />
          ) : null}

          <div
            className={cn(
              "relative flex min-w-0 flex-1 flex-col overflow-hidden transition-colors duration-200 ease-out",
              mainWorkspaceSurfaceClass,
              isDockedSidebarExpanded && "ml-px rounded-tl-[var(--radius-section)] rounded-bl-[var(--radius-section)]",
            )}
          >
            {shouldShowAppSurface ? (
              <div className="box-border flex h-full min-h-0 flex-col">
                <Titlebar
                  variant="app"
                  desktopPlatform={desktopPlatform}
                  headerTopInset={headerTopInset}
                  titlebarMode={titlebarMode}
                  windowBackgroundPreference={windowBackgroundPreference}
                  leadingAccessory={sharedTrafficLightsAccessory ? null : sidebarToggleAccessory}
                  leadingInset={titlebarLeadingInset}
                  leadingAccessoryOffset={sidebarToggleAccessoryOffset}
                >
                  <>
                    <div className="flex min-w-0 items-center">
                      <h1 className="hidden truncate text-sm font-medium text-foreground sm:block">
                        {appHeaderTitle}
                      </h1>
                    </div>
                    <div
                      data-slot="app-header-actions"
                      className="pointer-events-auto flex shrink-0 items-center gap-2 text-muted-foreground"
                    >
                      {showDesktopHeaderStatus ? (
                        <>
                          <Button variant="ghost" size="sm" className="rounded-lg text-muted-foreground">
                            本地环境
                          </Button>
                          <Button variant="outline" size="sm" className="rounded-lg">
                            提交模式
                          </Button>
                          <span
                            data-slot="app-header-status-icon"
                            className="inline-flex size-7 items-center justify-center rounded-full bg-secondary text-muted-foreground"
                          >
                            <Pulse size={14} weight="regular" />
                          </span>
                          <div
                            data-slot="app-header-diff-summary"
                            className="flex items-center gap-2 pl-1 text-xs font-medium"
                          >
                            <span className="text-primary">+12</span>
                            <span className="text-destructive">-3</span>
                          </div>
                        </>
                      ) : null}
                      {showCompactHeaderActions ? (
                        <ShellButton
                          variant="icon"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="新建对话"
                        >
                          <NotePencil size={18} weight="regular" />
                        </ShellButton>
                      ) : null}
                    </div>
                  </>
                </Titlebar>
                <div className="min-h-0 flex-1">{appContent}</div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                {!isSidebarVisible ? (
                  <div
                    className="absolute left-4 z-30"
                    style={{ top: `calc(${collapsedSidebarToggleTop}px + var(--safe-area-top))` }}
                  >
                    {sidebarToggleAccessory}
                  </div>
                ) : null}
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-20"
                  style={{ height: `calc(${mainDragHotspotHeight}px + var(--safe-area-top))` }}
                >
                  <div data-tauri-drag-region className="absolute inset-0" />
                  <WindowControls
                    visible={shouldShowCustomWindowControls(desktopPlatform, titlebarMode)}
                  />
                </div>
                <div
                  className="custom-scrollbar box-border flex-1 overflow-y-auto"
                  style={{
                    paddingBottom: settingsScrollPaddingBottom,
                    paddingLeft: settingsScrollPaddingLeft,
                    paddingRight: settingsScrollPaddingRight,
                    paddingTop: settingsScrollPaddingTop,
                  }}
                >
                  {settingsContent}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      <style>{`
        :root {
          --mac-signal-height: ${APP_LAYOUT_TOKENS.MAC_SAFE_ZONE}px;
          --win-control-width: ${APP_LAYOUT_TOKENS.WIN_SAFE_ZONE}px;
        }
      `}</style>
    </div>
  );
}
