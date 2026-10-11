export const DESKTOP_SHELL = {
  navigationWidth: 320,
  navigationMinWidth: 260,
  navigationMaxWidth: 480,
  navigationCloseSnapWidth: 180,
  navigationDefaultSnapDistance: 24,
  titlebarBaseHeight: 40,
  macTrafficLightsSpacer: 68,
} as const;

export interface ShellSidebarResizeResult {
  collapsed: boolean;
  width: number;
}

export interface ShellSidebarDragLayout {
  trackWidth: number;
  surfaceWidth: number;
  translateX: number;
}

export function getShellSidebarMaxWidth(_viewportWidth?: number) {
  return DESKTOP_SHELL.navigationMaxWidth;
}

export function clampShellSidebarWidth(width: number, viewportWidth?: number) {
  return Math.min(
    getShellSidebarMaxWidth(viewportWidth),
    Math.max(DESKTOP_SHELL.navigationMinWidth, Math.round(width))
  );
}

export function resolveShellSidebarResize(
  requestedWidth: number,
  previousExpandedWidth: number,
  viewportWidth?: number
): ShellSidebarResizeResult {
  if (requestedWidth <= DESKTOP_SHELL.navigationCloseSnapWidth) {
    return {
      collapsed: true,
      width: clampShellSidebarWidth(previousExpandedWidth, viewportWidth),
    };
  }

  const width = clampShellSidebarWidth(requestedWidth, viewportWidth);
  if (Math.abs(width - DESKTOP_SHELL.navigationWidth) <= DESKTOP_SHELL.navigationDefaultSnapDistance) {
    return {
      collapsed: false,
      width: DESKTOP_SHELL.navigationWidth,
    };
  }

  return { collapsed: false, width };
}

export function getShellSidebarDragLayout(
  requestedWidth: number,
  _previousExpandedWidth: number,
  viewportWidth?: number
): ShellSidebarDragLayout {
  const width = clampShellSidebarWidth(requestedWidth, viewportWidth);

  return {
    trackWidth: width,
    surfaceWidth: width,
    translateX: 0,
  };
}

// SHELL-1: 移动端无持久侧栏（由 MobileSlidingLayout 抽屉取代），宽度为 0
export function getShellSidebarWidth(
  isSmallScreen: boolean,
  preferredWidth: number = DESKTOP_SHELL.navigationWidth,
  viewportWidth?: number
) {
  return isSmallScreen ? 0 : clampShellSidebarWidth(preferredWidth, viewportWidth);
}

export interface ShellTitlebarTopInsetInput {
  isSmallScreen: boolean;
  isMacOS: boolean;
  /** 用户在「开发者选项 → 顶部栏顶部边距」里手填的额外边距（px） */
  manualTopMargin: number;
  /** Android 原生注入的顶部安全区（CSS px：状态栏 / 刘海 / 厂商顶部手柄条）；非 Android 为 null */
  androidSafeAreaTop: number | null;
}

/**
 * 桌面壳（宽屏布局）标题栏的顶部内缩。
 *
 * - 小屏走移动壳自己的 safe-area 契约，这里恒为 0；
 * - macOS 红绿灯与自绘控件共用原生标题栏，额外纵向内缩会画出重复工具栏；
 * - #472: Android 平板（宽屏 → 桌面壳）edge-to-edge 绘制在状态栏下方，此前只认
 *   手填边距（默认 0），顶栏按钮与状态栏 / vivo 顶部小横条重叠。这里取原生安全区
 *   与手填边距的较大值：手填值只能加大留白，不能把顶栏推回状态栏里。
 */
export function resolveShellTitlebarTopInset({
  isSmallScreen,
  isMacOS,
  manualTopMargin,
  androidSafeAreaTop,
}: ShellTitlebarTopInsetInput): number {
  if (isSmallScreen || isMacOS) return 0;
  const manual = Number.isFinite(manualTopMargin) && manualTopMargin > 0 ? Math.round(manualTopMargin) : 0;
  if (androidSafeAreaTop === null || !Number.isFinite(androidSafeAreaTop)) return manual;
  return Math.max(manual, Math.max(0, Math.round(androidSafeAreaTop)));
}
