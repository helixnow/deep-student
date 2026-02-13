/**
 * UnifiedSidebar - 统一的左侧栏组件导出
 */

export {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
  UnifiedSidebarFooter,
  useUnifiedSidebar,
} from './UnifiedSidebar';

export { UnifiedSidebarSection } from './UnifiedSidebarSection';

export { SidebarSheet } from './SidebarSheet';
export { SidebarDrawer } from './SidebarDrawer';
export {
  MobileSidebarLayout,
  MobileSidebarSection,
  MobileSidebarItem,
  type MobileSidebarLayoutProps,
  type MobileSidebarSectionProps,
  type MobileSidebarItemProps,
} from './MobileSidebarLayout';

export type {
  UnifiedSidebarProps,
  UnifiedSidebarHeaderProps,
  UnifiedSidebarContentProps,
  UnifiedSidebarItemProps,
  UnifiedSidebarFooterProps,
  UnifiedSidebarContextValue,
  SidebarDisplayMode,
  DrawerSide,
  SidebarSheetProps,
  SidebarDrawerProps,
} from './types';
