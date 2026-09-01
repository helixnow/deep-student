/**
 * UnifiedMobileHeader - 统一的移动端顶部导航栏
 *
 * 嵌在页面滑动轨道的主栏里，跟着原页面一起平移，而不是 fixed 盖住侧栏。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CaretLeft, CaretRight, List } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { shellIconButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { useMobileHeaderContextSafe, useMobileHeaderNav } from './MobileHeaderContext';
import { useMobileLayoutSafe } from './MobileLayoutContext';
import { isMobilePlatform } from '@/utils/platform';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';

export interface UnifiedMobileHeaderProps {
  /** 是否可以返回（有历史记录） */
  canGoBack?: boolean;
  /** 返回回调 */
  onBack?: () => void;
  /** 是否可以前进（回退后产生的前向历史） */
  canGoForward?: boolean;
  /** 前进回调 */
  onForward?: () => void;
  /** 额外的 className */
  className?: string;
  /** 额外的内联样式（App.tsx 用于传入 Z_INDEX token 等，避免类名魔法数） */
  style?: React.CSSProperties;
  /** D-1: 当前视图未注册 useMobileHeader 时的兜底标题（取导航标签），避免顶栏空白 */
  fallbackTitle?: string;
}

export const UnifiedMobileHeader: React.FC<UnifiedMobileHeaderProps> = ({
  canGoBack = false,
  onBack,
  canGoForward = false,
  onForward,
  className,
  style,
  fallbackTitle,
}) => {
  const { t } = useTranslation(['common']);
  const ctx = useMobileHeaderContextSafe();
  const config = ctx?.config ?? {
    title: '',
    titleNode: undefined,
    subtitle: undefined,
    rightActions: undefined,
    showMenu: false,
    floatingMenuButton: false,
    onMenuClick: undefined,
    showBackArrow: false,
    suppressGlobalBackButton: false,
  };

  const hideChrome = !!config.hidden;
  const chrome = useMotionPresence(!hideChrome, {
    exitMs: readCssDurationMs('--panel-close-dur', 350),
    enter: 'transition',
  });
  const chromeMotionClass = cn(
    'transition-opacity duration-[var(--panel-close-dur,350ms)] ease-[var(--panel-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none',
    !chrome.shown && 'opacity-0 pointer-events-none',
  );

  // 决定左侧显示什么按钮：
  // 1. showBackArrow 优先 - 显示返回箭头（使用 onMenuClick 回调）
  // 2. showMenu - 显示菜单图标
  // 3. canGoBack - 显示全局返回按钮
  const showBackArrowButton = config.showBackArrow && config.onMenuClick;
  const showMenuButton = !showBackArrowButton && config.showMenu && config.onMenuClick;
  const showGlobalNavigation =
    !config.suppressGlobalBackButton && !showBackArrowButton && !showMenuButton;
  const showBackButton = showGlobalNavigation && canGoBack && Boolean(onBack);
  // 进入全局历史导航语境后保留前进按钮槽位：后退产生前向历史时按钮只切换
  // disabled，不再让标题和右侧操作横向跳动。页内返回箭头/菜单模式仍不显示。
  const showForwardButton =
    showGlobalNavigation && Boolean(onForward) && (showBackButton || canGoForward);

  if (!chrome.mounted) {
    return null;
  }

  if (config.floatingMenuButton && showMenuButton) {
    return (
      <div
        data-mobile-shell="floating-sidebar-trigger"
        className={cn(
          "pointer-events-none flex w-full items-start justify-between px-3",
          chromeMotionClass,
          className
        )}
        style={{
          paddingTop: 'calc(var(--mobile-safe-area-top, 0px) + 0.375rem)',
          paddingLeft: 'calc(0.75rem + var(--mobile-safe-area-left, 0px))',
          paddingRight: 'calc(0.75rem + var(--mobile-safe-area-right, 0px))',
          ...style,
        }}
      >
        <DsButton
          variant="ghost"
          size="icon"
          onClick={config.onMenuClick}
          className={cn(shellIconButtonClassName, 'pointer-events-auto')}
          data-mobile-floating-menu-button
          aria-label={t('common:mobile_header.open_sidebar')}
        >
          <List size={21} weight="regular" />
        </DsButton>
        {config.rightActions ? (
          <div className="pointer-events-auto flex shrink-0 items-center" data-no-drag>
            {config.rightActions}
          </div>
        ) : (
          <span className="min-w-[var(--touch-target-size)]" aria-hidden />
        )}
      </div>
    );
  }

  return (
    <header
      // 移动平台（Android/iOS）上 data-tauri-drag-region 会干扰触摸点击事件，
      // 且移动端本无窗口拖拽需求；仅桌面窄窗口场景保留拖拽区
      {...(!isMobilePlatform() ? { 'data-tauri-drag-region': true } : {})}
      data-mobile-shell="header"
      className={cn(
        // 基础布局
        "flex w-full flex-shrink-0 items-center gap-2 px-3",
        // 样式 — 不用 backdrop-blur，避免与下方工具栏/遮罩叠出「顶栏阴影」
        "mobile-shell-header border-b border-transparent bg-transparent shadow-none",
        chromeMotionClass,
        className
      )}
      style={{
        paddingTop: 'var(--mobile-safe-area-top, 0px)',
        // 横屏刘海/挖孔机型：左右叠加安全区（px-3 = 12px 基础内边距）
        paddingLeft: 'calc(0.75rem + var(--mobile-safe-area-left, 0px))',
        paddingRight: 'calc(0.75rem + var(--mobile-safe-area-right, 0px))',
        height: 'var(--mobile-header-total-height, 56px)',
        minHeight: 'var(--mobile-header-total-height, 56px)',
        ...style,
      }}
    >
      {/* 左侧：返回箭头、菜单按钮或全局返回按钮 */}
      <nav
        className="flex min-w-[var(--touch-target-size)] shrink-0 items-center lg:min-w-10"
        aria-label={t('common:navigation_label')}
        data-no-drag
      >
        {showBackArrowButton && (
          <DsButton
            variant="ghost"
            size="icon"
            onClick={config.onMenuClick}
            className={cn(shellIconButtonClassName, '-ml-1')}
            aria-label={t('common:mobile_header.back')}
          >
            <CaretLeft size={20} weight="regular" />
          </DsButton>
        )}
        {showMenuButton && (
          <DsButton
            variant="ghost"
            size="icon"
            onClick={config.onMenuClick}
            className={shellIconButtonClassName}
            aria-label={t('common:mobile_header.open_sidebar')}
          >
            <List size={21} weight="regular" />
          </DsButton>
        )}
        {showBackButton && (
          <DsButton
            variant="ghost"
            size="icon"
            onClick={onBack}
            className={cn(shellIconButtonClassName, '-ml-1')}
            aria-label={t('common:mobile_header.back')}
          >
            <CaretLeft size={20} weight="regular" />
          </DsButton>
        )}
        {showForwardButton && (
          <DsButton
            variant="ghost"
            size="icon"
            onClick={onForward}
            disabled={!canGoForward}
            className={cn(shellIconButtonClassName, showBackButton ? '-ml-0.5' : '-ml-1')}
            aria-label={t('common:mobile_header.forward')}
          >
            <CaretRight size={20} weight="regular" />
          </DsButton>
        )}
      </nav>

      {/* 中间：标题区域 */}
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center overflow-hidden">
        {/* titleNode 优先级高于 title，用于面包屑等复杂渲染；均为空时回退到导航标签（D-1） */}
        {config.titleNode ? (
          config.titleNode
        ) : (config.title || fallbackTitle) ? (
          <h1 className="max-w-full truncate text-[15px] font-semibold text-[color:var(--shell-navigation-foreground)]">
            {config.title || fallbackTitle}
          </h1>
        ) : null}
        {config.subtitle && (
          <p className="max-w-full truncate text-[11px] text-[color:var(--shell-navigation-muted)]">
            {config.subtitle}
          </p>
        )}
      </div>

      {/* 右侧：操作按钮。
          约定：≤2 个动作（每个 ≥44px 触控目标）。头部无溢出收纳机制，
          超过 2 个会挤压中间标题区并在 320-375px 窄屏溢出；
          更多动作请收进页面内的「更多」菜单，而不是继续往这里塞。 */}
      <div className="flex min-w-[var(--touch-target-size)] shrink-0 items-center justify-end gap-1" data-no-drag>
        {config.rightActions}
      </div>
    </header>
  );
};

/** 页内顶栏：读 App 注入的返回/前进，跟主栏一起滑，不盖侧栏。 */
export const MobileInFlowHeader: React.FC = () => {
  const nav = useMobileHeaderNav();
  return (
    <UnifiedMobileHeader
      canGoBack={nav?.canGoBack}
      onBack={nav?.onBack}
      canGoForward={nav?.canGoForward}
      onForward={nav?.onForward}
      fallbackTitle={nav?.fallbackTitle}
      className="relative shrink-0"
    />
  );
};

/** 无滑动抽屉的移动页：顶栏仍在页面顶部文档流里。 */
export const MobilePageScaffold: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isMobile = useMobileLayoutSafe()?.isMobile ?? false;
  if (!isMobile) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <MobileInFlowHeader />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
};

export default UnifiedMobileHeader;
