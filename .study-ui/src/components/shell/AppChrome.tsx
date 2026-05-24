import React, { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  List,
  NotePencil,
  Pulse,
  X,
} from "@phosphor-icons/react";

import { useAppSettings } from "@/components/settings/AppSettingsProvider";
import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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

function SidebarFrameIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 256 256" className="size-[18px] fill-none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="18">
      <rect x="32" y="48" width="192" height="160" rx="14" />
    </svg>
  );
}

function SidebarFrameWithLeftRailIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 256 256" className="size-[18px] fill-none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="18">
      <rect x="32" y="48" width="192" height="160" rx="14" />
      <path d="M88 48v160" />
    </svg>
  );
}

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
  const showMacDesktopNewConversationShortcut =
    desktopPlatform === "macos" && shouldRenderDockedSidebar && layoutPolicy.density === "desktop";
  const mobileSettingsDragStartYRef = useRef<number | null>(null);
  const mobileSettingsDragOffsetRef = useRef(0);
  const [mobileSettingsDragOffset, setMobileSettingsDragOffset] = useState(0);
  const [isMobileSettingsDragging, setIsMobileSettingsDragging] = useState(false);
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
  const resetMobileSettingsDrag = () => {
    mobileSettingsDragStartYRef.current = null;
    mobileSettingsDragOffsetRef.current = 0;
    setMobileSettingsDragOffset(0);
    setIsMobileSettingsDragging(false);
  };
  const handleMobileSettingsSheetOpenChange = (open: boolean) => {
    if (!open) {
      resetMobileSettingsDrag();
      onReturnToApp();
    }
  };
  const handleMobileSettingsDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    mobileSettingsDragStartYRef.current = event.clientY;
    setIsMobileSettingsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleMobileSettingsDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mobileSettingsDragStartYRef.current === null) {
      return;
    }

    const nextOffset = Math.max(0, event.clientY - mobileSettingsDragStartYRef.current);
    mobileSettingsDragOffsetRef.current = nextOffset;
    setMobileSettingsDragOffset(nextOffset);
  };
  const handleMobileSettingsDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const shouldClose = mobileSettingsDragOffsetRef.current > 96;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    resetMobileSettingsDrag();

    if (shouldClose) {
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
  const toggleLabel = "切换边栏";
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
        {isCompactViewport ? <List size={21} weight="regular" /> : isSidebarVisible ? <SidebarFrameWithLeftRailIcon /> : <SidebarFrameIcon />}
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
          {isSidebarVisible ? <SidebarFrameWithLeftRailIcon /> : <SidebarFrameIcon />}
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
        "relative flex h-dvh w-screen overflow-hidden font-sans text-foreground transition-colors duration-200 ease-out motion-reduce:transition-none",
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
            <SheetContent side="left" className="w-[min(92vw,19rem)] border-r p-0 [&>button]:hidden">
              <SheetTitle className="sr-only">侧边栏</SheetTitle>
              <SheetDescription className="sr-only">
                移动端侧边栏，可切换对话、学习资源和设置。
              </SheetDescription>
              <Sidebar
                activeSettingsTab={activeSettingsTab}
                className="w-full"
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
                showNewConversationShortcut={false}
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
                showNewConversationShortcut={showMacDesktopNewConversationShortcut}
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
              overlayClassName="bg-[rgba(17,17,17,0.4)]"
              className="flex h-[min(86dvh,calc(100dvh-0.5rem))] max-h-[calc(100dvh-0.5rem)] flex-col overflow-hidden rounded-b-none rounded-t-[24px] border-x-0 border-b-0 border-t border-[#E0E3EA] bg-[#FFFFFF] p-0 text-[#111111] shadow-[0_-12px_34px_rgba(17,17,17,0.10)] ease-out duration-200 [&>button]:hidden"
              style={
                mobileSettingsDragOffset > 0
                  ? {
                    transform: `translateY(${mobileSettingsDragOffset}px)`,
                    transition: isMobileSettingsDragging ? "none" : undefined,
                  }
                  : undefined
              }
            >
              <div
                data-slot="mobile-settings-sheet-drag-zone"
                className="flex h-7 touch-none items-center justify-center pt-2"
                onPointerDown={handleMobileSettingsDragStart}
                onPointerMove={handleMobileSettingsDragMove}
                onPointerUp={handleMobileSettingsDragEnd}
                onPointerCancel={handleMobileSettingsDragEnd}
                onLostPointerCapture={resetMobileSettingsDrag}
              >
                <div data-slot="mobile-settings-sheet-drag-handle" className="h-1 w-12 rounded-full bg-[#C9CDD6]" />
              </div>

              <header
                data-slot="mobile-settings-sheet-header"
                className="flex items-center justify-between gap-5 border-b border-[rgba(17,17,17,0.08)] px-5 pb-3 pt-1"
              >
                <div className="min-w-0 space-y-0.5">
                  <SheetTitle className="text-sm font-semibold leading-5 tracking-[-0.01em] text-[#111111]">
                    系统设置
                  </SheetTitle>
                  <SheetDescription className="text-xs font-medium leading-5 text-[#5C5C5F]">
                    应用偏好与数据选项
                  </SheetDescription>
                </div>
                <SheetClose asChild>
                  <button
                    type="button"
                    aria-label="关闭系统设置"
                    className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-[#3A3A3C] transition-[background-color,transform] hover:bg-[#EEF0F4] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[rgba(0,113,227,0.5)]"
                  >
                    <X size={20} weight="regular" />
                  </button>
                </SheetClose>
              </header>

              <div data-slot="mobile-settings-sheet-nav-rail" className="relative shrink-0 bg-white py-2">
                <nav
                  data-slot="mobile-settings-sheet-nav"
                  aria-label="移动端设置分类"
                  className="flex snap-x gap-2 overflow-x-auto px-5 py-1 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {settingsNavItems.map((item) => {
                    const isActiveMobileSettingsTab = activeSettingsTab === item.id;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-slot={`mobile-settings-sheet-nav-${item.id}`}
                        aria-pressed={isActiveMobileSettingsTab}
                        onClick={isActiveMobileSettingsTab ? undefined : () => onSelectSettingsTab(item.id)}
                        className={cn(
                          "flex min-h-11 snap-start shrink-0 items-center justify-center gap-1.5 rounded-[14px] px-3.5 text-[0.78rem] font-medium tracking-[-0.01em] transition-[background-color,box-shadow,color,transform]",
                          "active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[rgba(0,113,227,0.5)]",
                          isActiveMobileSettingsTab
                            ? "bg-[#EEF0F4] text-[#111111] shadow-none"
                            : "bg-transparent text-[#3A3A3C] hover:bg-[#EEF0F4]",
                        )}
                      >
                        <span className="flex size-5 items-center justify-center [&_svg]:size-4">{item.icon}</span>
                        <span className="whitespace-nowrap">{item.label}</span>
                      </button>
                    );
                  })}
                </nav>
                <div
                  aria-hidden="true"
                  data-slot="mobile-settings-sheet-nav-edge"
                  className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-white via-white/85 to-transparent"
                />
              </div>

              <ScrollArea
                data-slot="mobile-settings-sheet-scroll"
                className="min-h-0 flex-1"
                viewportClassName="px-5 pb-[calc(1.25rem+var(--safe-area-bottom))] pt-4"
              >
                <div
                  data-slot="mobile-settings-sheet-real-content"
                  className="[--touch-target-size:var(--control-height-touch)] [--workspace-max-width:100%] [&_[data-slot=settings-page-header]]:hidden [&_input[type=range]]:min-h-11"
                >
                  {settingsContent}
                </div>
              </ScrollArea>
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
          <div
            className={cn(
              "relative flex min-w-0 flex-1 flex-col overflow-hidden transition-colors duration-200 ease-out",
              mainWorkspaceSurfaceClass,
              isDockedSidebarExpanded && "rounded-tl-[var(--radius-page)] rounded-bl-[var(--radius-page)] border-l",
              isDockedSidebarExpanded && splitSeamClass,
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
                <ScrollArea
                  className="box-border flex-1"
                  viewportProps={{
                    style: {
                      paddingBottom: settingsScrollPaddingBottom,
                      paddingLeft: settingsScrollPaddingLeft,
                      paddingRight: settingsScrollPaddingRight,
                      paddingTop: settingsScrollPaddingTop,
                    },
                  }}
                >
                  {settingsContent}
                </ScrollArea>
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
