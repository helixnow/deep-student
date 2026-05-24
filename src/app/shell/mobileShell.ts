import { BREAKPOINTS } from '@/config/breakpoints';
import { MOBILE_LAYOUT, getBottomTabBarHeight } from '@/config/mobileLayout';

const MOBILE_SAFE_AREA_TOP = 'var(--android-safe-area-top, env(safe-area-inset-top, 0px))';
const MOBILE_SAFE_AREA_BOTTOM = 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))';

export const MOBILE_SHELL = {
  breakpointMax: BREAKPOINTS.md - 1,
  headerHeight: MOBILE_LAYOUT.mobileHeader.height,
  bottomBarHeight: MOBILE_LAYOUT.bottomTabBar.defaultHeight,
  compactBottomBarHeight: MOBILE_LAYOUT.bottomTabBar.heightWithoutLabels,
  safeAreaTopVar: '--mobile-safe-area-top',
  safeAreaBottomVar: '--mobile-safe-area-bottom',
  headerHeightVar: '--mobile-header-height',
  headerTotalHeightVar: '--mobile-header-total-height',
  bottomBarHeightVar: '--mobile-bottom-bar-height',
  bottomBarTotalHeightVar: '--mobile-bottom-bar-total-height',
} as const;

export function getMobileSafeAreaTopValue() {
  return MOBILE_SAFE_AREA_TOP;
}

export function getMobileSafeAreaBottomValue() {
  return MOBILE_SAFE_AREA_BOTTOM;
}

export function getMobileBottomBarHeightValue(showLabels = true) {
  return `${getBottomTabBarHeight(showLabels)}px`;
}

export function getMobileShellCssVars({ showTabLabels = true }: { showTabLabels?: boolean } = {}) {
  const bottomBarHeight = getMobileBottomBarHeightValue(showTabLabels);

  return {
    [MOBILE_SHELL.safeAreaTopVar]: getMobileSafeAreaTopValue(),
    [MOBILE_SHELL.safeAreaBottomVar]: getMobileSafeAreaBottomValue(),
    [MOBILE_SHELL.headerHeightVar]: `${MOBILE_SHELL.headerHeight}px`,
    [MOBILE_SHELL.headerTotalHeightVar]: `calc(${MOBILE_SHELL.headerHeight}px + ${getMobileSafeAreaTopValue()})`,
    [MOBILE_SHELL.bottomBarHeightVar]: bottomBarHeight,
    [MOBILE_SHELL.bottomBarTotalHeightVar]: `calc(${bottomBarHeight} + ${getMobileSafeAreaBottomValue()})`,
  } as const;
}
