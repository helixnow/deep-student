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
