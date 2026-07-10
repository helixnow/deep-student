/**
 * Layout 组件导出
 */

// 移动端布局组件
export {
  MobileUnifiedDrawerProvider,
  useMobileUnifiedDrawer,
} from './MobileDrawerContext';
export {
  MobileSidebarNavigation,
  MOBILE_APP_NAVIGATE_EVENT,
} from './MobileSidebarNavigation';
export { MobileSlidingLayout, DEFAULT_GESTURE_IGNORE_SELECTOR, type ScreenPosition } from './MobileSlidingLayout';
export {
  MobileLayoutProvider,
  useMobileLayout,
  useMobileLayoutSafe,
  type SidebarType,
} from './MobileLayoutContext';
// MobileHeader（旧版自绘顶栏）已废弃：全部视图统一走 useMobileHeader + UnifiedMobileHeader，
// 不再从公共入口导出，防止新代码误用（文件保留仅为源码断言测试引用）。

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
