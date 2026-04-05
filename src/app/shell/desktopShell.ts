export const DESKTOP_SHELL = {
  navigationWidth: 272,
  mobileNavigationWidth: 110,
  titlebarBaseHeight: 40,
  macTrafficLightsSpacer: 68,
} as const;

export function getShellSidebarWidth(isSmallScreen: boolean) {
  return isSmallScreen ? DESKTOP_SHELL.mobileNavigationWidth : DESKTOP_SHELL.navigationWidth;
}
