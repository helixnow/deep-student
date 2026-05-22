/**
 * UnifiedSidebar - 统一的左侧栏组件
 * 
 * 用于 Chat V2、学习资源、知识图谱、系统设置等页面
 * 提供一致的设计风格和交互体验
 */

import React, { createContext, useContext, useState, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MacTopSafeDragZone } from '@/components/layout/MacTopSafeDragZone';
import { NotionButton } from '@/components/ui/NotionButton';
import { shellIconButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { Input } from '@/components/ui/shad/Input';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SidebarSheet } from './SidebarSheet';
import { SidebarDrawer } from './SidebarDrawer';
import {
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  CircleNotch,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react';
import type {
  UnifiedSidebarProps,
  UnifiedSidebarContextValue,
  UnifiedSidebarHeaderProps,
  UnifiedSidebarContentProps,
  UnifiedSidebarItemProps,
  UnifiedSidebarFooterProps,
  SidebarDisplayMode,
} from './types';

// ============================================================================
// 样式配置常量 - 减少嵌套三元表达式复杂度
// ============================================================================

/**
 * 侧边栏样式配置
 * 根据显示模式（桌面端/移动端/移动滑动模式）提供不同的样式值
 */
const SIDEBAR_STYLES = {
  /** 桌面端样式 */
  desktop: {
    header: { height: '40px', padding: 'px-2', gap: 'gap-0.5' },
    search: { iconSize: 'w-3.5 h-3.5', inputPadding: 'pl-8 pr-3 py-1.5 text-sm' },
    button: { padding: 'p-1.5', iconSize: 'w-4 h-4' },
    item: { padding: 'gap-2.5 px-2 py-2 mx-1', iconSize: 'w-4 h-4', textSize: 'text-[13px]', indicator: 'w-[3px] h-4' },
    content: { viewportPadding: 'py-1', spacing: 'space-y-0.5' },
    footer: { padding: 'p-3' },
    actions: { gap: 'gap-0.5', opacity: 'opacity-0 group-hover:opacity-100', btnPadding: 'p-1', iconSize: 'w-3 h-3' },
  },
  /** 移动端样式（drawer/sheet 模式） */
  mobile: {
    header: { height: '48px', padding: 'px-3 py-2', gap: 'gap-1' },
    search: { iconSize: 'w-4 h-4', inputPadding: 'pl-9 pr-3 py-2.5 text-base' },
    button: { padding: 'p-2.5', iconSize: 'w-5 h-5' },
    item: { padding: 'gap-3 px-3 py-3 mx-2', iconSize: 'w-5 h-5', textSize: 'text-base', indicator: 'w-1 h-6' },
    content: { viewportPadding: 'py-2', spacing: 'space-y-1' },
    footer: { padding: 'p-4' },
    actions: { gap: 'gap-1', opacity: 'opacity-100', btnPadding: 'p-2', iconSize: 'w-4 h-4' },
  },
  /** 移动滑动模式样式（紧凑布局） */
  mobileSliding: {
    header: { height: 'var(--touch-target-size)', padding: 'px-2 py-1.5', gap: 'gap-0.5' },
    search: { iconSize: 'w-3.5 h-3.5', inputPadding: 'pl-8 pr-3 py-1.5 text-sm' },
    button: { padding: 'p-1.5', iconSize: 'w-4 h-4' },
    item: { padding: 'gap-2.5 px-3 py-2 mx-1', iconSize: 'w-4 h-4', textSize: 'text-[13px]', indicator: 'w-[3px] h-4' },
    content: { viewportPadding: 'py-1', spacing: 'space-y-0.5' },
    footer: { padding: 'p-2' },
    actions: { gap: 'gap-0.5', opacity: 'opacity-100', btnPadding: 'p-1', iconSize: 'w-3 h-3' },
  },
} as const;

/** 根据模式获取样式配置 */
function getStyleConfig(isMobileMode: boolean, isMobileSlidingMode: boolean) {
  if (isMobileSlidingMode) return SIDEBAR_STYLES.mobileSliding;
  if (isMobileMode) return SIDEBAR_STYLES.mobile;
  return SIDEBAR_STYLES.desktop;
}

// ============================================================================
// Context
// ============================================================================

export const UnifiedSidebarContext = createContext<UnifiedSidebarContextValue | null>(null);

export const useUnifiedSidebar = () => {
  const ctx = useContext(UnifiedSidebarContext);
  if (!ctx) {
    throw new Error('useUnifiedSidebar must be used within UnifiedSidebar');
  }
  return ctx;
};

// ============================================================================
// Types (导出的类型已移至 types.ts)
// ============================================================================

// ============================================================================
// UnifiedSidebar - 主容器
// ============================================================================

export const UnifiedSidebar: React.FC<UnifiedSidebarProps> = ({
  className,
  children,
  defaultCollapsed = false,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  width = 200,
  collapsedWidth = 32,
  showMacSafeZone = true,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  // 新增的移动端相关 props
  displayMode = 'panel',
  mobileOpen = false,
  onMobileOpenChange,
  enableSwipeClose = true,
  sheetDefaultHeight = 0.6,
  drawerSide = 'left',
  autoResponsive = true,
  onClose,
}) => {
  // 判断是否为全宽模式（移动端侧边栏填满容器）- 增加类型守卫和大小写处理
  const isFullWidth = typeof width === 'string' && width.trim().toLowerCase() === 'full';
  // 判断是否启用移动端样式（全宽模式 + 有关闭回调）- 确保 onClose 是函数
  const isMobileSlidingMode = isFullWidth && typeof onClose === 'function';
  const { isSmallScreen } = useBreakpoint();

  // 内部状态
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const [internalSearchQuery, setInternalSearchQuery] = useState('');

  const collapsed = controlledCollapsed ?? internalCollapsed;
  const setCollapsed = useCallback(
    (value: boolean) => {
      setInternalCollapsed(value);
      onCollapsedChange?.(value);
    },
    [onCollapsedChange]
  );

  const searchQuery = controlledSearchQuery ?? internalSearchQuery;
  const setSearchQuery = useCallback(
    (value: string) => {
      setInternalSearchQuery(value);
      onSearchQueryChange?.(value);
    },
    [onSearchQueryChange]
  );

  // 计算有效的显示模式
  const effectiveMode: SidebarDisplayMode = useMemo(() => {
    if (autoResponsive && isSmallScreen && displayMode === 'panel') {
      return 'sheet';
    }
    return displayMode;
  }, [autoResponsive, isSmallScreen, displayMode]);

  // 🔧 P1-007 性能优化：使用 ref 模式稳定 closeMobile 函数引用
  // 避免因依赖变化导致不必要的重渲染
  const closeMobileRef = useRef<() => void>();
  closeMobileRef.current = () => {
    if (isMobileSlidingMode && onClose) {
      onClose();
    } else {
      onMobileOpenChange?.(false);
    }
  };
  // 稳定的 closeMobile 函数，始终调用最新的 ref 值
  const closeMobile = useCallback(() => {
    closeMobileRef.current?.();
  }, []);

  // Context 值
  const contextValue: UnifiedSidebarContextValue = useMemo(
    () => ({
      collapsed,
      setCollapsed,
      searchQuery,
      setSearchQuery,
      displayMode: effectiveMode,
      isMobile: isSmallScreen,
      closeMobile,
      isMobileSlidingMode,
      onClose,
    }),
    [collapsed, setCollapsed, searchQuery, setSearchQuery, effectiveMode, isSmallScreen, closeMobile, isMobileSlidingMode, onClose]
  );

  // 内容渲染（复用）
  const renderContent = () => {
    const isDrawerOrSheet = effectiveMode === 'drawer' || effectiveMode === 'sheet';
    // 全宽模式或 drawer/sheet 模式下填满容器
    const shouldFillContainer = isFullWidth || isDrawerOrSheet;

    return (
        <div
        className={cn(
          'sidebar-shell-surface flex flex-col transition-[width,opacity] duration-200 pt-[5px] font-sidebar-study-ui',
          'bg-[var(--sidebar-study-surface)]',
          // 全宽模式或 drawer/sheet 模式下，使用 w-full + h-full 填满容器
          shouldFillContainer ? 'w-full h-full overflow-hidden' : 'h-full flex-shrink-0',
          effectiveMode === 'panel' && !isFullWidth && 'border-r border-[color:var(--sidebar-study-border)]',
          className
        )}
        style={
          // 只有在 panel 模式且不是全宽时才应用固定宽度
          effectiveMode === 'panel' && !isFullWidth
            ? {
                width: collapsed ? collapsedWidth : (width as number),
              }
            : undefined
        }
      >
        {showMacSafeZone && effectiveMode === 'panel' && <MacTopSafeDragZone />}
        {children}
      </div>
    );
  };

  // 根据模式渲染不同容器
  if (effectiveMode === 'sheet') {
    return (
      <UnifiedSidebarContext.Provider value={contextValue}>
        <SidebarSheet
          open={mobileOpen}
          onOpenChange={onMobileOpenChange || (() => {})}
          defaultHeight={sheetDefaultHeight}
          enableSwipeClose={enableSwipeClose}
        >
          {renderContent()}
        </SidebarSheet>
      </UnifiedSidebarContext.Provider>
    );
  }

  if (effectiveMode === 'drawer') {
    // Drawer 模式使用更宽的默认值（至少 280px）
    const numericWidth = typeof width === 'number' ? width : 280;
    const drawerWidth = Math.max(numericWidth, 280);
    return (
      <UnifiedSidebarContext.Provider value={contextValue}>
        <SidebarDrawer
          open={mobileOpen}
          onOpenChange={onMobileOpenChange || (() => {})}
          side={drawerSide}
          width={drawerWidth}
          enableSwipeClose={enableSwipeClose}
        >
          {renderContent()}
        </SidebarDrawer>
      </UnifiedSidebarContext.Provider>
    );
  }

  // 默认 panel 模式
  return (
    <UnifiedSidebarContext.Provider value={contextValue}>
      {renderContent()}
    </UnifiedSidebarContext.Provider>
  );
};

// ============================================================================
// UnifiedSidebarHeader - 头部
// ============================================================================

export const UnifiedSidebarHeader: React.FC<UnifiedSidebarHeaderProps> = ({
  title,
  icon: Icon,
  showSearch = true,
  searchPlaceholder,
  showCreate = false,
  createTitle,
  onCreateClick,
  showRefresh = false,
  refreshTitle,
  onRefreshClick,
  isRefreshing = false,
  showCollapse = true,
  collapseTitle,
  expandTitle,
  extraActions,
  rightActions,
  className,
  children,
}) => {
  const { t } = useTranslation('common');
  const { collapsed, setCollapsed, searchQuery, setSearchQuery, displayMode, closeMobile, isMobile, isMobileSlidingMode } = useUnifiedSidebar();

  // 是否为移动端模式（drawer/sheet 或 移动滑动模式）
  const isMobileMode = displayMode === 'sheet' || displayMode === 'drawer' || isMobileSlidingMode;
  // 获取当前模式的样式配置
  const styles = getStyleConfig(isMobileMode, isMobileSlidingMode);

  // 折叠态：只显示折叠按钮（但 drawer/sheet 模式下显示完整头部）
  if (collapsed && !isMobileMode) {
    return (
      <div className={cn('sidebar-shell-header flex flex-col', className)}>
        <div className="flex items-center justify-center px-1" style={{ height: '40px' }}>
          <NotionButton variant="nav" size="icon" iconOnly onClick={() => setCollapsed(false)} className="!p-1.5" title={expandTitle || t('expand')} aria-label="expand">
            <CaretRight size={16} weight="regular" />
          </NotionButton>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('sidebar-shell-header flex flex-col', className)}>
      {/* 移动端模式：显示关闭按钮行（但移动滑动模式下不显示，因为顶栏已有切换按钮） */}
      {isMobileMode && !isMobileSlidingMode && (
        <div className="flex items-center gap-3 px-3 py-3 border-b border-[color:var(--shell-navigation-border)]">
          <NotionButton variant="utility" size="icon" iconOnly onClick={closeMobile} className={cn(shellIconButtonClassName, 'shrink-0')} aria-label={t('close')}>
            <X size={20} weight="regular" />
          </NotionButton>
          {title && (
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {Icon && <Icon size={20} className="text-primary shrink-0" />}
              <span className="text-base truncate">{title}</span>
            </div>
          )}
        </div>
      )}

      {/* 搜索框和操作按钮行 - 只在有内容时显示 */}
      {(showSearch || showRefresh || showCreate || (showCollapse && !isMobileMode) || extraActions || rightActions || (!isMobileMode && title)) && (
        <div
          className={cn('flex items-center gap-1.5', styles.header.padding)}
          style={{ height: styles.header.height }}
        >
          {/* 搜索框或标题 */}
          {showSearch ? (
            <div className="flex-1 relative">
              <MagnifyingGlass className={cn(
                'absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60',
                styles.search.iconSize
              )} weight="regular" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder || t('search')}
                className={cn(
                  'sidebar-shell-search w-full rounded-2xl bg-background/70 border border-transparent placeholder:text-muted-foreground/50 focus:outline-none focus:bg-background focus:border-[color:var(--sidebar-study-border)] transition-[background-color,border-color] duration-150',
                  styles.search.inputPadding
                )}
/>
            </div>
          ) : !isMobileMode && title ? (
            // 桌面端非移动模式下显示标题（移动端标题在上面的关闭按钮行）
            <div className="flex items-center gap-2 flex-1">
              {Icon && <Icon size={16} className="text-primary" />}
              <span className="text-sm">{title}</span>
            </div>
          ) : (
            <div className="flex-1" />
          )}

        {/* 操作按钮 */}
        <div className={cn('flex items-center', styles.header.gap)}>
          {extraActions}

          {showRefresh && (
            <NotionButton variant="utility" size="icon" iconOnly onClick={onRefreshClick} disabled={isRefreshing} className={styles.button.padding} title={refreshTitle || t('refresh')} aria-label="refresh">
              <ArrowsClockwise className={cn(styles.button.iconSize, isRefreshing && 'animate-spin')} weight="regular" />
            </NotionButton>
          )}

          {showCreate && (
            <NotionButton variant="utility" size="icon" iconOnly onClick={onCreateClick} className={styles.button.padding} title={createTitle || t('create')} aria-label="create">
              <Plus className={styles.button.iconSize} weight="regular" />
            </NotionButton>
          )}

          {rightActions}

          {/* 只在 panel 模式下显示折叠按钮，但在移动滑动模式下不显示（使用关闭按钮代替） */}
          {showCollapse && displayMode === 'panel' && !isMobileSlidingMode && (
            <NotionButton variant="nav" size="icon" iconOnly onClick={() => setCollapsed(true)} className="!p-1.5" title={collapseTitle || t('collapse')} aria-label="collapse">
              <CaretLeft size={16} weight="regular" />
            </NotionButton>
          )}
        </div>
        </div>
      )}

      {/* 子元素区域（如新建表单等） */}
      {children}
    </div>
  );
};

// ============================================================================
// UnifiedSidebarContent - 内容区域
// ============================================================================

export const UnifiedSidebarContent: React.FC<UnifiedSidebarContentProps> = ({
  children,
  isLoading = false,
  error,
  onRetry,
  isEmpty = false,
  emptyIcon: EmptyIcon,
  emptyTitle,
  emptyDescription,
  emptyActionText,
  onEmptyAction,
  className,
}) => {
  const { t } = useTranslation('common');
  const { collapsed, displayMode, isMobileSlidingMode } = useUnifiedSidebar();
  // 是否为移动端模式（drawer/sheet 或 移动滑动模式）
  const isMobileMode = displayMode === 'sheet' || displayMode === 'drawer' || isMobileSlidingMode;
  // 获取当前模式的样式配置
  const styles = getStyleConfig(isMobileMode, isMobileSlidingMode);

  // 折叠态不显示内容（但移动端模式下始终显示）
  if (collapsed && !isMobileMode) {
    return null;
  }

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center', isMobileMode ? 'py-12' : 'py-8')}>
        <CircleNotch className={cn('animate-spin text-muted-foreground', isMobileMode ? 'w-6 h-6' : 'w-5 h-5')} weight="regular" />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn(
        'text-center text-destructive',
        isMobileMode ? 'px-4 py-6 text-base' : 'px-3 py-4 text-sm'
      )}>
        <p>{error}</p>
        {onRetry && (
          <NotionButton variant="ghost" size={isMobileMode ? 'md' : 'sm'} onClick={onRetry} className="mt-2">
            {t('retry')}
          </NotionButton>
        )}
      </div>
    );
  }

  // 空状态
  if (isEmpty) {
    return (
      <div className={cn('text-center', isMobileMode ? 'py-16 px-6' : 'py-12 px-4')}>
        {EmptyIcon && (
          <EmptyIcon className={cn(
            'mx-auto mb-3 text-muted-foreground/30',
            isMobileMode ? 'w-14 h-14' : 'w-10 h-10'
          )} />
        )}
        {emptyTitle && (
          <p className={cn(
            'text-muted-foreground/70 mb-2',
            isMobileMode ? 'text-base' : 'text-sm'
          )}>{emptyTitle}</p>
        )}
        {emptyDescription && (
          <p className={cn(
            'text-muted-foreground/50 mb-3',
            isMobileMode ? 'text-sm' : 'text-xs'
          )}>{emptyDescription}</p>
        )}
        {emptyActionText && onEmptyAction && (
          <NotionButton variant="ghost" size="sm" onClick={onEmptyAction} className={cn('text-primary hover:text-primary/80 hover:underline', isMobileMode ? 'text-base py-2 px-4' : 'text-xs')}>
            {emptyActionText}
          </NotionButton>
        )}
      </div>
    );
  }

  return (
    <CustomScrollArea
      className={cn('flex-1 min-h-0', className)}
      viewportClassName={styles.content.viewportPadding}
    >
      <div className={styles.content.spacing}>
        {children}
      </div>
    </CustomScrollArea>
  );
};

// ============================================================================
// UnifiedSidebarItem - 列表项
// ============================================================================

export const UnifiedSidebarItem: React.FC<UnifiedSidebarItemProps> = ({
  id,
  isSelected = false,
  isEditing = false,
  onClick,
  icon,
  colorDot,
  title,
  description,
  stats,
  badge,
  showEdit = false,
  onEditClick,
  showDelete = false,
  onDeleteClick,
  extraActions,
  editContent,
  className,
  children,
}) => {
  const { displayMode, isMobileSlidingMode, closeMobile } = useUnifiedSidebar();
  // 是否为移动端模式（drawer/sheet 或 移动滑动模式）
  const isMobileMode = displayMode === 'sheet' || displayMode === 'drawer' || isMobileSlidingMode;
  // 获取当前模式的样式配置
  const styles = getStyleConfig(isMobileMode, isMobileSlidingMode);

  const handleClick = useCallback(() => {
    if (!isEditing && onClick) {
      onClick();
      // 移动端模式下点击项目后自动关闭侧边栏
      if (isMobileMode) {
        closeMobile();
      }
    }
  }, [isEditing, onClick, isMobileMode, closeMobile]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditing) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleClick();
  }, [isEditing, handleClick]);

  // 渲染图标
  const renderIcon = () => {
    if (colorDot) {
      // colorDot 尺寸略小于图标
      const dotSize = isMobileMode && !isMobileSlidingMode ? 'w-3 h-3' : 'w-2.5 h-2.5';
      return (
        <div
          className={cn('rounded-full flex-shrink-0', dotSize)}
          style={{ backgroundColor: colorDot }}
/>
      );
    }
    if (icon) {
      if (React.isValidElement(icon)) {
        return icon;
      }
      const IconComponent = icon as React.ElementType;
      return (
        <IconComponent
          className={cn(
            'flex-shrink-0 transition-colors',
            styles.item.iconSize,
            isSelected ? 'text-foreground' : 'text-muted-foreground'
          )}
/>
      );
    }
    return null;
  };

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={isEditing ? -1 : 0}
      aria-pressed={isSelected}
      data-selected={isSelected}
      className={cn(
        'sidebar-shell-item group relative flex items-center rounded-2xl cursor-pointer transition-[background-color,color,box-shadow] duration-150',
        styles.item.padding,
        isSelected
          ? 'bg-[var(--sidebar-study-selected)] text-foreground'
          : 'text-foreground/80 hover:text-foreground hover:bg-[var(--sidebar-study-hover)]',
        className
      )}
    >

      {/* 图标 */}
      {renderIcon()}

      {/* 内容区域 */}
      <div className="flex-1 min-w-0">
        {isEditing && editContent ? (
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {editContent}
          </div>
        ) : (
          <>
            <div className="flex items-start gap-1.5">
              {badge && (
                <span className={cn(
                  'px-1.5 py-0.5 rounded bg-accent text-accent-foreground font-medium flex-shrink-0',
                  isMobileMode && !isMobileSlidingMode ? 'text-xs' : 'text-[10px]'
                )}>
                  {badge}
                </span>
              )}
              <span
                className={cn(
                  'line-clamp-2 break-words',
                  styles.item.textSize,
                  isSelected ? 'font-normal hover:font-normal' : 'font-normal hover:font-normal'
                )}
              >
                {title}
              </span>
            </div>
            {description && (
              <p className={cn(
                'text-muted-foreground truncate mt-0.5',
                isMobileMode && !isMobileSlidingMode ? 'text-sm' : 'text-xs'
              )}>
                {description}
              </p>
            )}
            {stats && (
              <div className={cn(
                'flex items-center gap-2 mt-0.5 text-muted-foreground',
                isMobileMode && !isMobileSlidingMode ? 'text-xs' : 'text-[11px]'
              )}>
                {stats}
              </div>
            )}
            {children}
          </>
        )}
      </div>

      {/* 操作按钮 - 移动端始终显示，桌面端悬停显示 */}
      {!isEditing && (showEdit || showDelete || extraActions) && (
        <div className={cn('flex transition-opacity', styles.actions.gap, styles.actions.opacity)}>
          {extraActions}
          {showEdit && onEditClick && (
            <NotionButton variant="utility" size="icon" iconOnly onClick={onEditClick} className={styles.actions.btnPadding} aria-label="edit">
              <PencilSimple className={styles.actions.iconSize} weight="regular" />
            </NotionButton>
          )}
          {showDelete && onDeleteClick && (
            <NotionButton variant="utility" size="icon" iconOnly onClick={onDeleteClick} className={styles.actions.btnPadding} aria-label="delete">
              <Trash className={styles.actions.iconSize} weight="regular" />
            </NotionButton>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// UnifiedSidebarFooter - 底部区域
// ============================================================================

export const UnifiedSidebarFooter: React.FC<UnifiedSidebarFooterProps> = ({
  children,
  className,
}) => {
  const { collapsed, displayMode, isMobileSlidingMode } = useUnifiedSidebar();
  // 是否为移动端模式（drawer/sheet 或 移动滑动模式）
  const isMobileMode = displayMode === 'sheet' || displayMode === 'drawer' || isMobileSlidingMode;
  // 获取当前模式的样式配置
  const styles = getStyleConfig(isMobileMode, isMobileSlidingMode);

  // 折叠态不显示（但移动端模式下始终显示）
  if (collapsed && !isMobileMode) {
    return null;
  }

  return (
    <div className={cn('sidebar-shell-footer border-t border-[color:var(--shell-navigation-border)]', styles.footer.padding, className)}>
      {children}
    </div>
  );
};

// ============================================================================
// 导出
// ============================================================================

export default UnifiedSidebar;
