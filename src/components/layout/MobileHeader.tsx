/**
 * MobileHeader - 移动端顶部导航栏
 *
 * 提供移动端页面顶部的标准导航栏
 * 支持返回按钮、标题、右侧操作按钮
 */

import React, { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ChevronLeft, Menu } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';

export interface MobileHeaderProps {
  /** 标题 */
  title?: string;
  /** 副标题 */
  subtitle?: string;
  /** 是否显示返回按钮 */
  showBack?: boolean;
  /** 返回按钮点击回调 */
  onBack?: () => void;
  /** 是否显示菜单按钮 */
  showMenu?: boolean;
  /** 菜单按钮点击回调 */
  onMenuClick?: () => void;
  /** 右侧操作区域 */
  rightActions?: ReactNode;
  /** 额外的 className */
  className?: string;
  /** 是否透明背景 */
  transparent?: boolean;
  /** 子元素（替代默认标题区域） */
  children?: ReactNode;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  title,
  subtitle,
  showBack = false,
  onBack,
  showMenu = false,
  onMenuClick,
  rightActions,
  className,
  transparent = false,
  children,
}) => {
  const { t } = useTranslation(['common']);
  return (
    <header
      className={cn(
        // 基础布局
        "flex items-center gap-2 px-2 h-12",
        // 安全区域 - 使用 CSS 类以支持 Android fallback
        "safe-area-top",
        // 样式
        transparent
          ? "bg-transparent"
          : "bg-background/95 backdrop-blur-lg border-b border-border",
        className
      )}
    >
      {/* 左侧：返回/菜单按钮 */}
      <div className="flex items-center">
        {showBack && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="h-9 w-9 -ml-1"
            style={{ minWidth: 36, minHeight: 36 }}
            aria-label={t('common:mobile_header.back')}
          >
            <ChevronLeft style={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }} />
          </NotionButton>
        )}

        {showMenu && !showBack && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={onMenuClick}
            className="h-9 w-9 -ml-1"
            style={{ minWidth: 36, minHeight: 36 }}
            aria-label={t('common:mobile_header.menu')}
          >
            <Menu style={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }} />
          </NotionButton>
        )}
      </div>

      {/* 中间：标题区域 */}
      <div className="flex-1 min-w-0">
        {children ?? (
          <div className="flex flex-col items-center justify-center">
            {title && (
              <h1 className="text-base font-semibold truncate">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">
                {subtitle}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 右侧：操作按钮 */}
      <div className="flex items-center gap-1">
        {rightActions}
      </div>
    </header>
  );
};

export default MobileHeader;
