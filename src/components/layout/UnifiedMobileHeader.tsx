/**
 * UnifiedMobileHeader - 统一的移动端顶部导航栏
 *
 * 在 App.tsx 级别渲染，从 MobileHeaderContext 读取配置
 * 提供统一的返回按钮（使用全局历史导航）
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CaretLeft, List } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { shellIconButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { useMobileHeaderContextSafe } from './MobileHeaderContext';
import { isAndroid } from '@/utils/platform';

export interface UnifiedMobileHeaderProps {
  /** 是否可以返回（有历史记录） */
  canGoBack?: boolean;
  /** 返回回调 */
  onBack?: () => void;
  /** 额外的 className */
  className?: string;
}

export const UnifiedMobileHeader: React.FC<UnifiedMobileHeaderProps> = ({
  canGoBack = false,
  onBack,
  className,
}) => {
  const { t } = useTranslation(['common']);
  const ctx = useMobileHeaderContextSafe();
  const config = ctx?.config ?? { title: '', titleNode: undefined, subtitle: undefined, rightActions: undefined, showMenu: false, onMenuClick: undefined, showBackArrow: false, suppressGlobalBackButton: false };

  if (config.hidden) {
    return null;
  }

  // 决定左侧显示什么按钮：
  // 1. showBackArrow 优先 - 显示返回箭头（使用 onMenuClick 回调）
  // 2. showMenu - 显示菜单图标
  // 3. canGoBack - 显示全局返回按钮
  const showBackArrowButton = config.showBackArrow && config.onMenuClick;
  const showMenuButton = !showBackArrowButton && config.showMenu && config.onMenuClick;
  const showBackButton = !config.suppressGlobalBackButton && !showBackArrowButton && !showMenuButton && canGoBack;

  return (
    <header
      // Android WebView 上 data-tauri-drag-region 会干扰触摸点击事件，因此不设置
      {...(!isAndroid() ? { 'data-tauri-drag-region': true } : {})}
      data-mobile-shell="header"
      className={cn(
        // 基础布局
        "flex w-full flex-shrink-0 items-center gap-2 px-3",
        // 样式
        "border-b border-[color:var(--shell-chrome-border)] bg-[color:var(--shell-titlebar-surface)]/95 backdrop-blur-md",
        className
      )}
      style={{
        paddingTop: 'var(--mobile-safe-area-top, 0px)',
        height: 'var(--mobile-header-total-height, 56px)',
        minHeight: 'var(--mobile-header-total-height, 56px)',
      }}
    >
      {/* 左侧：返回箭头、菜单按钮或全局返回按钮 */}
      <div className="flex min-w-[var(--touch-target-size)] items-center lg:min-w-10">
        {showBackArrowButton && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={config.onMenuClick}
            className={cn(shellIconButtonClassName, '-ml-1')}
            aria-label={t('common:mobile_header.back')}
          >
            <CaretLeft size={20} weight="regular" />
          </NotionButton>
        )}
        {showMenuButton && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={config.onMenuClick}
            className={shellIconButtonClassName}
            aria-label="展开侧边栏"
          >
            <List size={21} weight="regular" />
          </NotionButton>
        )}
        {showBackButton && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={onBack}
            className={cn(shellIconButtonClassName, '-ml-1')}
            aria-label={t('common:mobile_header.back')}
          >
            <CaretLeft size={20} weight="regular" />
          </NotionButton>
        )}
      </div>

      {/* 中间：标题区域 */}
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center overflow-hidden">
        {/* titleNode 优先级高于 title，用于面包屑等复杂渲染 */}
        {config.titleNode ? (
          config.titleNode
        ) : config.title ? (
          <h1 className="max-w-full truncate text-[15px] font-semibold text-[color:var(--shell-navigation-foreground)]">
            {config.title}
          </h1>
        ) : null}
        {config.subtitle && (
          <p className="max-w-full truncate text-[11px] text-[color:var(--shell-navigation-muted)]">
            {config.subtitle}
          </p>
        )}
      </div>

      {/* 右侧：操作按钮 */}
      <div className="flex min-w-[var(--touch-target-size)] items-center justify-end gap-1">
        {config.rightActions}
      </div>
    </header>
  );
};

export default UnifiedMobileHeader;
