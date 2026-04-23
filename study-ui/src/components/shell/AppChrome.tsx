import React, { useMemo, useSyncExternalStore } from "react";
import { NotePencil, Pulse } from "@phosphor-icons/react";

import { useAppSettings } from "@/components/settings/AppSettingsProvider";
import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
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

  const appHeaderTitle = "新对话";
  const activeSettingsItem = settingsNavItems.find((item) => item.id === activeSettingsTab);
  const settingsPageTitle = activeSettingsItem?.label ?? "设置";
  const settingsScrollPaddingTop = `calc(${mainDragHotspotHeight + 28}px + var(--safe-area-top))`;
  const settingsScrollPaddingBottom = `calc(2.5rem + var(--safe-area-bottom))`;
  const toggleLabel = isSidebarVisible ? "收起侧边栏" : "展开侧边栏";
  const sidebarToggleAccessoryOffset =
    titlebarMode === "native-transparent" ? getOverlayLeadingInset(titlebarMode) : 16;
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
    <div className="flex items-center gap-1.5">
      <ShellButton
        variant="icon"
        onClick={handleToggleSidebar}
        className="text-muted-foreground hover:text-foreground"
        aria-label={toggleLabel}
      >
        <SidebarDockIcon />
      </ShellButton>
      <SidebarUpdateBadge className="shrink-0" />
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
      data-platform={desktopPlatform}
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
              <Sidebar
                activeSettingsTab={activeSettingsTab}
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
            {currentMode === "app" ? (
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
                      <h1 className="truncate text-sm font-medium text-foreground">
                        {appHeaderTitle}
                      </h1>
                    </div>
                    <div
                      data-slot="app-header-actions"
                      className="flex shrink-0 items-center gap-2 text-muted-foreground"
                    >
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
                  className="custom-scrollbar box-border flex-1 overflow-y-auto px-6 pb-10 md:px-20"
                  style={{ paddingBottom: settingsScrollPaddingBottom, paddingTop: settingsScrollPaddingTop }}
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
