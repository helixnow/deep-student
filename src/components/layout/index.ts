/**
 * Layout 组件导出
 */

// 移动端布局组件
export { BottomTabBar, type BottomTabBarProps } from './BottomTabBar';
export { MobileSlidingLayout, type ScreenPosition } from './MobileSlidingLayout';
export {
  MobileLayoutProvider,
  useMobileLayout,
  useMobileLayoutSafe,
  type SidebarType,
} from './MobileLayoutContext';
export { MobileHeader, type MobileHeaderProps } from './MobileHeader';

// 统一移动端顶栏
export {
  MobileHeaderProvider,
  useMobileHeader,
  useMobileHeaderContext,
  useMobileHeaderContextSafe,
  useSetMobileHeaderActiveView,
  MobileHeaderActiveViewSync,
  type MobileHeaderConfig,
} from './MobileHeaderContext';
export { UnifiedMobileHeader, type UnifiedMobileHeaderProps } from './UnifiedMobileHeader';

// 现有桌面端组件
export { MacTopSafeDragZone } from './MacTopSafeDragZone';
export { default as Topbar } from './Topbar';
