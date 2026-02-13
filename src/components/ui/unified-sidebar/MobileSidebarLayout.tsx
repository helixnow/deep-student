/**
 * MobileSidebarLayout - 移动端侧边栏统一布局组件
 *
 * 提供统一的移动端侧边栏布局规范：
 * - 统一的头部（关闭按钮 + 可选标题）
 * - 统一的内容区域（可滚动）
 * - 统一的底部（可选操作区）
 * - 统一的样式和间距
 */

import React, { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MobileSidebarLayoutProps {
  /** 子内容 */
  children: ReactNode;
  /** 关闭回调 */
  onClose: () => void;
  /** 可选标题（移动端顶栏已有主标题，这里一般用副标题或不显示） */
  title?: string;
  /** 可选副标题 */
  subtitle?: string;
  /** 头部右侧操作区 */
  headerActions?: ReactNode;
  /** 底部操作区 */
  footer?: ReactNode;
  /** 是否显示头部分隔线 */
  showHeaderBorder?: boolean;
  /** 是否显示底部分隔线 */
  showFooterBorder?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 内容区域自定义类名 */
  contentClassName?: string;
  /** 是否隐藏头部（完全自定义场景） */
  hideHeader?: boolean;
}

export const MobileSidebarLayout: React.FC<MobileSidebarLayoutProps> = ({
  children,
  onClose,
  title,
  subtitle,
  headerActions,
  footer,
  showHeaderBorder = false,
  showFooterBorder = true,
  className,
  contentClassName,
  hideHeader = false,
}) => {
  const { t } = useTranslation(['common']);
  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* 头部 */}
      {!hideHeader && (
        <div
          className={cn(
            'flex items-center gap-3 px-4 py-3 shrink-0',
            showHeaderBorder && 'border-b border-border'
          )}
        >
          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-accent/80 active:bg-accent transition-colors -ml-1"
            aria-label={t('common:sidebar.close')}
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </button>

          {/* 标题区域 */}
          {(title || subtitle) && (
            <div className="flex-1 min-w-0">
              {title && (
                <h3 className="text-sm font-medium text-foreground truncate">
                  {title}
                </h3>
              )}
              {subtitle && (
                <p className="text-xs text-muted-foreground truncate">
                  {subtitle}
                </p>
              )}
            </div>
          )}

          {/* 右侧操作区 */}
          {headerActions && (
            <div className="flex items-center gap-1 shrink-0">
              {headerActions}
            </div>
          )}
        </div>
      )}

      {/* 内容区域 */}
      <div className={cn('flex-1 min-h-0 overflow-y-auto', contentClassName)}>
        {children}
      </div>

      {/* 底部区域 */}
      {footer && (
        <div
          className={cn(
            'shrink-0 px-4 py-3',
            showFooterBorder && 'border-t border-border'
          )}
        >
          {footer}
        </div>
      )}
    </div>
  );
};

/**
 * MobileSidebarSection - 移动端侧边栏分组组件
 *
 * 用于在侧边栏中创建带标题的分组
 */
export interface MobileSidebarSectionProps {
  /** 分组标题 */
  title?: string;
  /** 子内容 */
  children: ReactNode;
  /** 自定义类名 */
  className?: string;
}

export const MobileSidebarSection: React.FC<MobileSidebarSectionProps> = ({
  title,
  children,
  className,
}) => {
  return (
    <div className={cn('px-3 py-2', className)}>
      {title && (
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-2 py-2">
          {title}
        </h4>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
};

/**
 * MobileSidebarItem - 移动端侧边栏项目组件
 *
 * 用于创建统一样式的侧边栏列表项
 */
export interface MobileSidebarItemProps {
  /** 图标 */
  icon?: ReactNode;
  /** 标题 */
  title: string;
  /** 副标题/描述 */
  subtitle?: string;
  /** 右侧内容（如计数、状态等） */
  trailing?: ReactNode;
  /** 是否选中 */
  selected?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 点击回调 */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
}

export const MobileSidebarItem: React.FC<MobileSidebarItemProps> = ({
  icon,
  title,
  subtitle,
  trailing,
  selected = false,
  disabled = false,
  onClick,
  className,
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
        'hover:bg-accent/50 active:bg-accent',
        selected && 'bg-accent text-accent-foreground',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      {/* 图标 */}
      {icon && (
        <span className={cn(
          'flex items-center justify-center w-5 h-5 shrink-0',
          selected ? 'text-foreground' : 'text-muted-foreground'
        )}>
          {icon}
        </span>
      )}

      {/* 文字区域 */}
      <div className="flex-1 min-w-0">
        <div className={cn(
          'text-sm truncate',
          selected ? 'font-medium' : 'font-normal'
        )}>
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-muted-foreground truncate">
            {subtitle}
          </div>
        )}
      </div>

      {/* 右侧内容 */}
      {trailing && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {trailing}
        </span>
      )}
    </button>
  );
};

export default MobileSidebarLayout;
