/**
 * UnifiedMobileHeader - 统一的移动端顶部导航栏
 *
 * 在 App.tsx 级别渲染，从 MobileHeaderContext 读取配置
 * 提供统一的返回按钮（使用全局历史导航）
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ChevronLeft, Menu } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
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
      className={cn(
        // 基础布局
        "flex items-center gap-2 px-3 w-full flex-shrink-0",
        // 样式
        "bg-background/95 backdrop-blur-lg",
        className
      )}
      style={{
        // 使用 CSS 变量应用顶部边距，默认回退到 30px（移动端默认值）
        paddingTop: 'var(--topbar-safe-area, 30px)',
        // 高度 = 基础高度 56px + 顶部安全区域
        height: 'calc(56px + var(--topbar-safe-area, 30px))',
        minHeight: 'calc(56px + var(--topbar-safe-area, 30px))',
      }}
    >
      {/* 左侧：返回箭头、菜单按钮或全局返回按钮 */}
      <div className="flex items-center w-10">
        {showBackArrowButton && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={config.onMenuClick}
            className="h-9 w-9 -ml-1"
            style={{ minWidth: 36, minHeight: 36 }}
            aria-label={t('common:mobile_header.back')}
          >
            <ChevronLeft style={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }} />
          </NotionButton>
        )}
        {showMenuButton && (
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={config.onMenuClick}
            className="h-9 w-9 -ml-1"
            style={{ minWidth: 36, minHeight: 36 }}
            aria-label={t('common:mobile_header.open_menu')}
          >
            <Menu style={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }} />
          </NotionButton>
        )}
        {showBackButton && (
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
      </div>

      {/* 中间：标题区域 */}
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center overflow-hidden">
        {/* titleNode 优先级高于 title，用于面包屑等复杂渲染 */}
        {config.titleNode ? (
          config.titleNode
        ) : config.title ? (
          <h1 className="text-base font-semibold truncate max-w-full">
            {config.title}
          </h1>
        ) : null}
        {config.subtitle && (
          <p className="text-xs text-muted-foreground truncate max-w-full">
            {config.subtitle}
          </p>
        )}
      </div>

      {/* 右侧：操作按钮 */}
      <div className="flex items-center gap-1 min-w-[40px] justify-end">
        {config.rightActions}
      </div>
    </header>
  );
};

export default UnifiedMobileHeader;
