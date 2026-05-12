import { MACOS_TITLEBAR_GEOMETRY } from "./macos-titlebar-geometry.ts";

export const APPLE_ALIGNMENT_LAYERS = [
  "window chrome",
  "navigation",
  "workspace",
] as const;

export const APPLE_ALIGNMENT_KEYWORDS = [
  "unified",
  "quiet",
  "task-first",
  "material-light",
  "native rhythm",
] as const;

export const APP_LAYOUT_TOKENS = {
  MAC_SAFE_ZONE: MACOS_TITLEBAR_GEOMETRY.shell.safeZone,
  MAC_TRAFFIC_LIGHTS_LEADING: MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsLeading,
  MAC_TRAFFIC_LIGHTS_TOP_INSET: MACOS_TITLEBAR_GEOMETRY.nativeTrafficLightInset.y,
  MAC_TRAFFIC_LIGHTS_VISUAL_SIZE: MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsVisualSize,
  MAC_TRAFFIC_LIGHTS_WIDTH: MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsWidth,
  MAC_TRAFFIC_LIGHTS_GAP: MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsGap,
  MAC_TITLEBAR_CONTROL_SIZE: MACOS_TITLEBAR_GEOMETRY.shell.titlebarControlSize,
  MAC_TRAFFIC_LIGHTS_TRAILING_EDGE:
    MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsLeading +
    MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsWidth,
  MAC_TOGGLE_LEADING_OFFSET_FROM_TRAFFIC_LIGHTS:
    MACOS_TITLEBAR_GEOMETRY.shell.trafficLightsGap,
  MAC_TITLE_LEADING_OFFSET_AFTER_TOGGLE:
    MACOS_TITLEBAR_GEOMETRY.shell.titlebarControlSize + 8,
  FLOATING_SIDEBAR_WIDTH: 272,
  MAIN_AREA_TOP_OFFSET_OVERLAY: 12,
  MAIN_AREA_TOP_OFFSET_FRAMELESS: 6,
  MAIN_PANE_CONTENT_OFFSET: 16,
  TITLEBAR_INSET_OVERLAY: 8,
  TITLEBAR_INSET_FRAMELESS: 6,
  WIN_SAFE_ZONE: 120,
} as const;

export type DesktopPlatform = "macos" | "windows" | "other";
export type TitlebarMode = "native-overlay" | "native-transparent" | "frameless";
export type WindowBackgroundMode = "opaque" | "translucent";
type FloatingSidebarLayout = {
  edgeInset: number;
  surfaceClassName: string;
};

export function detectDesktopPlatform(input: {
  platform?: string | null;
  userAgent?: string | null;
}): DesktopPlatform {
  const platform = (input.platform ?? "").toLowerCase();
  const userAgent = (input.userAgent ?? "").toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "macos";
  }

  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }

  return "other";
}

export function getTitlebarMode(platform: DesktopPlatform): TitlebarMode {
  if (platform === "macos") {
    return "native-transparent";
  }

  return "frameless";
}

export function getMainAreaTopOffset(
  isSidebarOpen: boolean,
  titlebarMode: TitlebarMode,
) {
  void isSidebarOpen;
  return titlebarMode === "native-overlay"
    ? APP_LAYOUT_TOKENS.MAIN_AREA_TOP_OFFSET_OVERLAY
    : APP_LAYOUT_TOKENS.MAIN_AREA_TOP_OFFSET_FRAMELESS;
}

export function getHeaderTopInset(
  isSidebarVisible: boolean,
  titlebarMode: TitlebarMode,
  explicitInset?: number,
) {
  if (explicitInset !== undefined && explicitInset >= 0) {
    return explicitInset;
  }

  if (titlebarMode === "native-overlay") {
    return APP_LAYOUT_TOKENS.TITLEBAR_INSET_OVERLAY;
  }

  return isSidebarVisible
    ? APP_LAYOUT_TOKENS.TITLEBAR_INSET_FRAMELESS
    : APP_LAYOUT_TOKENS.TITLEBAR_INSET_FRAMELESS;
}

export function getOverlayLeadingInset(titlebarMode: TitlebarMode) {
  return titlebarMode === "native-overlay" || titlebarMode === "native-transparent"
    ? APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TRAILING_EDGE +
        APP_LAYOUT_TOKENS.MAC_TOGGLE_LEADING_OFFSET_FROM_TRAFFIC_LIGHTS
    : 0;
}

export function getMacTitlebarControlTopInset(titlebarMode: TitlebarMode) {
  if (titlebarMode !== "native-overlay" && titlebarMode !== "native-transparent") {
    return 0;
  }

  return Math.round(
    APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TOP_INSET +
      APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_VISUAL_SIZE / 2 -
      APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE / 2,
  );
}

export function getSidebarHeaderHeight(titlebarMode: TitlebarMode) {
  if (titlebarMode === "native-transparent") {
    return getMacTitlebarControlTopInset(titlebarMode) * 2 + APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE;
  }

  return 52;
}

export function getFloatingSidebarTogglePosition(titlebarMode: TitlebarMode) {
  if (titlebarMode !== "native-overlay") {
    return null;
  }

  return {
    top: getMacTitlebarControlTopInset(titlebarMode),
    left: getOverlayLeadingInset(titlebarMode),
  } as const;
}

export function getFloatingSidebarLayout(titlebarMode: TitlebarMode): FloatingSidebarLayout {
  void titlebarMode;

  return {
    edgeInset: 0,
    surfaceClassName: "w-68 shrink-0",
  };
}

export function getMainPaneContentOffset(isSidebarVisible: boolean) {
  return isSidebarVisible ? APP_LAYOUT_TOKENS.MAIN_PANE_CONTENT_OFFSET : 0;
}

export function getNavigationSurfaceClass(windowBackgroundPreference: WindowBackgroundMode) {
  return windowBackgroundPreference === "opaque"
    ? "bg-sidebar"
    : "bg-[color:var(--shell-panel)]";
}

export function getTitlebarSurfaceClass(windowBackgroundPreference: WindowBackgroundMode) {
  return windowBackgroundPreference === "opaque"
    ? "bg-background"
    : "bg-[color:var(--shell-titlebar)]";
}

export function getSidebarSurfaceClass(windowBackgroundPreference: WindowBackgroundMode) {
  return getNavigationSurfaceClass(windowBackgroundPreference);
}

export function getMainWorkspaceSurfaceClass(windowBackgroundPreference: WindowBackgroundMode) {
  return windowBackgroundPreference === "opaque"
    ? "bg-background"
    : "bg-[color:var(--shell-panel-strong)]";
}

export function getSplitSeamClass(windowBackgroundPreference: WindowBackgroundMode) {
  return windowBackgroundPreference === "opaque" ? "border-sidebar-border/80" : "border-sidebar-border/55";
}

export function shouldShowCustomWindowControls(
  platform: DesktopPlatform,
  titlebarMode: TitlebarMode,
) {
  return platform === "windows" && titlebarMode === "frameless";
}

export function getHeaderRightPadding(
  platform: DesktopPlatform,
  titlebarMode: TitlebarMode,
) {
  return shouldShowCustomWindowControls(platform, titlebarMode)
    ? APP_LAYOUT_TOKENS.WIN_SAFE_ZONE
    : 24;
}

export function getShellBackdropClass(
  platform: DesktopPlatform,
  titlebarMode: TitlebarMode,
  windowBackgroundPreference: WindowBackgroundMode,
) {
  void platform;
  void titlebarMode;

  if (windowBackgroundPreference === "opaque") {
    return "bg-background";
  }

  return "bg-[color:var(--shell-backdrop)]";
}
