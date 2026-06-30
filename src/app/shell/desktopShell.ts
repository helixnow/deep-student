export const DESKTOP_SHELL = {
  navigationWidth: 272,
  titlebarBaseHeight: 40,
  macTrafficLightsSpacer: 68,
} as const;

// SHELL-1: 移动端无持久侧栏（由 MobileSlidingLayout 抽屉取代），宽度为 0
export function getShellSidebarWidth(isSmallScreen: boolean) {
  return isSmallScreen ? 0 : DESKTOP_SHELL.navigationWidth;
}
