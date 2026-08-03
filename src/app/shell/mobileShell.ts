import { BREAKPOINTS } from '@/config/breakpoints';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';

const MOBILE_SAFE_AREA_TOP = 'var(--android-safe-area-top, env(safe-area-inset-top, 0px))';
const MOBILE_SAFE_AREA_BOTTOM = 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))';
// 横向安全区：横屏刘海/挖孔机型（顶栏与左缘抽屉消费）
const MOBILE_SAFE_AREA_LEFT = 'var(--android-safe-area-left, env(safe-area-inset-left, 0px))';
const MOBILE_SAFE_AREA_RIGHT = 'var(--android-safe-area-right, env(safe-area-inset-right, 0px))';

export const MOBILE_SHELL = {
  breakpointMax: BREAKPOINTS.md - 1,
  headerHeight: MOBILE_LAYOUT.mobileHeader.height,
  safeAreaTopVar: '--mobile-safe-area-top',
  safeAreaBottomVar: '--mobile-safe-area-bottom',
  safeAreaLeftVar: '--mobile-safe-area-left',
  safeAreaRightVar: '--mobile-safe-area-right',
  headerHeightVar: '--mobile-header-height',
  headerTotalHeightVar: '--mobile-header-total-height',
} as const;

export function getMobileSafeAreaTopValue() {
  return MOBILE_SAFE_AREA_TOP;
}

export function getMobileSafeAreaBottomValue() {
  return MOBILE_SAFE_AREA_BOTTOM;
}

export function getMobileSafeAreaLeftValue() {
  return MOBILE_SAFE_AREA_LEFT;
}

export function getMobileSafeAreaRightValue() {
  return MOBILE_SAFE_AREA_RIGHT;
}

export function getMobileShellCssVars() {
  return {
    [MOBILE_SHELL.safeAreaTopVar]: getMobileSafeAreaTopValue(),
    [MOBILE_SHELL.safeAreaBottomVar]: getMobileSafeAreaBottomValue(),
    [MOBILE_SHELL.safeAreaLeftVar]: getMobileSafeAreaLeftValue(),
    [MOBILE_SHELL.safeAreaRightVar]: getMobileSafeAreaRightValue(),
    [MOBILE_SHELL.headerHeightVar]: `${MOBILE_SHELL.headerHeight}px`,
    [MOBILE_SHELL.headerTotalHeightVar]: `calc(${MOBILE_SHELL.headerHeight}px + ${getMobileSafeAreaTopValue()})`,
  } as const;
}
