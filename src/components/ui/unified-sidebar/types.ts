/**
 * UnifiedSidebar 类型定义
 *
 * 包含所有与 UnifiedSidebar 相关的类型定义
 */

import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

// ============================================================================
// 显示模式相关类型
// ============================================================================

/**
 * 侧边栏显示模式
 * - panel: 面板模式（桌面端，固定在页面左侧）
 * - sheet: 底部弹出模式（移动端，从底部弹出）
 * - drawer: 抽屉模式（移动端/平板，从左侧或右侧滑出）
 */
export type SidebarDisplayMode = 'panel' | 'sheet' | 'drawer';

/**
 * 抽屉侧边位置
 */
export type DrawerSide = 'left' | 'right';

// ============================================================================
// Context 相关类型
// ============================================================================

/**
 * UnifiedSidebar Context 值类型
 */
export interface UnifiedSidebarContextValue {
  /** 是否折叠 */
  collapsed: boolean;
  /** 设置折叠状态 */
  setCollapsed: (collapsed: boolean) => void;
  /** 搜索查询字符串 */
  searchQuery: string;
  /** 设置搜索查询 */
  setSearchQuery: (query: string) => void;
  /** 当前显示模式 */
  displayMode: SidebarDisplayMode;
  /** 是否为移动端 */
  isMobile: boolean;
  /** 关闭移动端侧边栏 */
  closeMobile: () => void;
  /** 是否为移动滑动模式（width='full' + onClose） */
  isMobileSlidingMode: boolean;
  /** 关闭回调（用于移动滑动模式） */
  onClose?: () => void;
}

// ============================================================================
// 组件 Props 相关类型
// ============================================================================

/**
 * UnifiedSidebar 主组件 Props
 */
export interface UnifiedSidebarProps {
  /** 额外的 className */
  className?: string;
  /** 子元素 */
  children: ReactNode;

  // 折叠状态相关
  /** 默认是否折叠 */
  defaultCollapsed?: boolean;
  /** 受控折叠状态 */
  collapsed?: boolean;
  /** 折叠状态变化回调 */
  onCollapsedChange?: (collapsed: boolean) => void;

  // 尺寸相关
  /** 展开时的宽度 */
  width?: number | string;
  /** 折叠时的宽度 */
  collapsedWidth?: number | string;

  // 搜索相关
  /** 受控搜索查询 */
  searchQuery?: string;
  /** 搜索查询变化回调 */
  onSearchQueryChange?: (query: string) => void;

  // 显示相关
  /** 是否显示 Mac 顶部安全区域 */
  showMacSafeZone?: boolean;

  // 显示模式相关（新增）
  /** 显示模式 */
  displayMode?: SidebarDisplayMode;
  /** 移动端是否打开（用于 sheet 和 drawer 模式） */
  mobileOpen?: boolean;
  /** 移动端打开状态变化回调 */
  onMobileOpenChange?: (open: boolean) => void;
  /** 是否自动响应式切换（在小屏幕时自动从 panel 切换到 sheet） */
  autoResponsive?: boolean;
  /** 是否启用滑动关闭（用于 sheet 和 drawer 模式） */
  enableSwipeClose?: boolean;
  /** Sheet 默认高度（0-1 之间的小数，表示视口高度的百分比） */
  sheetDefaultHeight?: number;
  /** Drawer 侧边位置 */
  drawerSide?: DrawerSide;
  /**
   * 关闭回调（用于 width='full' 模式的移动端侧边栏）
   * 当设置此回调时，侧边栏会显示移动端样式（更大的触控区域、关闭按钮等）
   */
  onClose?: () => void;
}

/**
 * UnifiedSidebarHeader Props
 */
export interface UnifiedSidebarHeaderProps {
  /** 标题 */
  title?: string;
  /** 标题图标 */
  icon?: LucideIcon;
  /** 是否显示搜索框 */
  showSearch?: boolean;
  /** 搜索框占位符 */
  searchPlaceholder?: string;
  /** 是否显示新建按钮 */
  showCreate?: boolean;
  /** 新建按钮提示 */
  createTitle?: string;
  /** 新建按钮点击回调 */
  onCreateClick?: () => void;
  /** 是否显示刷新按钮 */
  showRefresh?: boolean;
  /** 刷新按钮提示 */
  refreshTitle?: string;
  /** 刷新按钮点击回调 */
  onRefreshClick?: () => void;
  /** 是否正在刷新 */
  isRefreshing?: boolean;
  /** 是否显示折叠按钮 */
  showCollapse?: boolean;
  /** 折叠按钮提示（展开时） */
  collapseTitle?: string;
  /** 折叠按钮提示（折叠时） */
  expandTitle?: string;
  /** 额外的操作按钮（左侧） */
  extraActions?: ReactNode;
  /** 额外的操作按钮（右侧，折叠按钮之前） */
  rightActions?: ReactNode;
  /** 额外的 className */
  className?: string;
  /** 子元素（如新建表单等） */
  children?: ReactNode;
}

/**
 * UnifiedSidebarContent Props
 */
export interface UnifiedSidebarContentProps {
  /** 子元素 */
  children: ReactNode;
  /** 是否加载中 */
  isLoading?: boolean;
  /** 错误信息 */
  error?: string | null;
  /** 错误重试回调 */
  onRetry?: () => void;
  /** 是否为空 */
  isEmpty?: boolean;
  /** 空状态图标 */
  emptyIcon?: LucideIcon;
  /** 空状态标题 */
  emptyTitle?: string;
  /** 空状态描述 */
  emptyDescription?: string;
  /** 空状态操作按钮文本 */
  emptyActionText?: string;
  /** 空状态操作按钮点击回调 */
  onEmptyAction?: () => void;
  /** 额外的 className */
  className?: string;
}

/**
 * UnifiedSidebarItem Props
 */
export interface UnifiedSidebarItemProps {
  /** 项目 ID */
  id: string;
  /** 是否选中 */
  isSelected?: boolean;
  /** 是否正在编辑 */
  isEditing?: boolean;
  /** 点击回调 */
  onClick?: () => void;
  /** 图标 */
  icon?: LucideIcon | ReactNode;
  /** 颜色标记（如圆点颜色） */
  colorDot?: string;
  /** 标题 */
  title: string;
  /** 描述/副标题 */
  description?: string;
  /** 统计信息 */
  stats?: ReactNode;
  /** 标签（如"默认"） */
  badge?: string;
  /** 是否显示编辑按钮 */
  showEdit?: boolean;
  /** 编辑按钮点击回调 */
  onEditClick?: (e: React.MouseEvent) => void;
  /** 是否显示删除按钮 */
  showDelete?: boolean;
  /** 删除按钮点击回调 */
  onDeleteClick?: (e: React.MouseEvent) => void;
  /** 额外的操作按钮 */
  extraActions?: ReactNode;
  /** 编辑模式内容 */
  editContent?: ReactNode;
  /** 额外的 className */
  className?: string;
  /** 子元素 */
  children?: ReactNode;
}

/**
 * UnifiedSidebarFooter Props
 */
export interface UnifiedSidebarFooterProps {
  /** 子元素 */
  children: ReactNode;
  /** 额外的 className */
  className?: string;
}

// ============================================================================
// Sheet 和 Drawer 组件 Props
// ============================================================================

/**
 * SidebarSheet Props
 */
export interface SidebarSheetProps {
  /** 子元素 */
  children: ReactNode;
  /** 是否打开 */
  open: boolean;
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void;
  /** 默认高度（0-1 之间的小数，表示视口高度的百分比） */
  defaultHeight?: number;
  /** 是否启用滑动关闭 */
  enableSwipeClose?: boolean;
  /** 额外的 className */
  className?: string;
}

/**
 * SidebarDrawer Props
 */
export interface SidebarDrawerProps {
  /** 子元素 */
  children: ReactNode;
  /** 是否打开 */
  open: boolean;
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void;
  /** 侧边位置 */
  side?: DrawerSide;
  /** 宽度 */
  width?: number | string;
  /** 是否启用滑动关闭 */
  enableSwipeClose?: boolean;
  /** 额外的 className */
  className?: string;

  // ★ 统一头部布局支持（2024-12 新增）
  /** 是否显示统一头部 */
  showHeader?: boolean;
  /** 头部标题（建议不设置，因为移动端顶栏已有主标题） */
  headerTitle?: string;
  /** 头部副标题 */
  headerSubtitle?: string;
  /** 头部右侧操作区 */
  headerActions?: ReactNode;
}
