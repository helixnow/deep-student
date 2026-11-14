/**
 * UnifiedMobileHeader - 统一的移动端顶部导航栏
 *
 * 嵌在页面滑动轨道的主栏里，跟着原页面一起平移，而不是 fixed 盖住侧栏。
 * 支持：
 * - 手机横屏紧凑高度（40px）与左右安全区避让
 * - 4 层阶梯渐进模糊垫层（MobileProgressiveBlurBar），向外延伸 14px 羽化尾迹
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CaretLeft, CaretRight, List } from '@phosphor-icons/react';
import { DESKTOP_SHELL } from '@/app/shell/desktopShell';
import { DsButton } from '@/components/ui/DsButton';
import { shellIconButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import { usePhoneLandscape } from '@/hooks/useBreakpoint';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import { cn } from '@/utils/cn';
import { isMacOS, isMobilePlatform } from '@/utils/platform';
import { useMobileHeaderContextSafe, useMobileHeaderNav } from './MobileHeaderContext';
import { useMobileLayoutSafe } from './MobileLayoutContext';

export interface MobileProgressiveBlurBarProps {
  /** 渐进模糊方向：top 为顶栏向下消融，bottom 为底栏向上消融 */
  position?: 'top' | 'bottom';
  /** 向外延伸羽化尾迹高度（px），默认 14px */
  tailPx?: number;
  /** 额外的 className */
  className?: string;
}

const PROGRESSIVE_BLUR_STEPS = [
  { filter: 'blur(1px)', maskStops: 'black 0%, black 28%, transparent 100%' },
  { filter: 'blur(2px)', maskStops: 'black 0%, black 20%, transparent 82%' },
  { filter: 'blur(4px)', maskStops: 'black 0%, black 12%, transparent 62%' },
  { filter: 'blur(8px) saturate(140%)', maskStops: 'black 0%, transparent 42%' },
] as const;

/**
 * 移动端 4 层阶梯渐进模糊条
 * 通过分段 mask-image 递减模糊半径，配合语义背景色线性渐变与 14px 羽化尾迹，
 * 让滚入栏后的列表与消息自然消融，无硬切边界。
 */
export const MobileProgressiveBlurBar: React.FC<MobileProgressiveBlurBarProps> = ({
  position = 'top',
  tailPx = MOBILE_LAYOUT.PROGRESSIVE_BLUR_TAIL_PX,
  className,
}) => {
  const direction = position === 'top' ? 'to bottom' : 'to top';
  const placementStyle: React.CSSProperties =
    position === 'top'
      ? { top: 0, bottom: `-${tailPx}px` }
      : { bottom: 0, top: `-${tailPx}px` };
  const tintGradient = `linear-gradient(${direction}, hsl(var(--background) / 0.92) 0%, hsl(var(--background) / 0.72) 48%, hsl(var(--background) / 0.28) 78%, hsl(var(--background) / 0) 100%)`;

  return (
    <div
      aria-hidden="true"
      data-mobile-progressive-blur={position}
      className={cn('pointer-events-none absolute inset-x-0 z-0 select-none', className)}
      style={placementStyle}
    >
      {PROGRESSIVE_BLUR_STEPS.map((step, index) => {
        const maskValue = `linear-gradient(${direction}, ${step.maskStops})`;
        return (
          <span
            key={step.filter}
            data-blur-layer={index + 1}
            className="pointer-events-none absolute inset-0"
            style={{
              backdropFilter: step.filter,
              WebkitBackdropFilter: step.filter,
              maskImage: maskValue,
              WebkitMaskImage: maskValue,
            }}
          />
        );
      })}
      <div
        data-blur-tint
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: tintGradient }}
      />
    </div>
  );
};

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
  /** 是否启用 4 层阶梯渐进模糊垫层（默认启用） */
  progressiveBlur?: boolean;
}

export const UnifiedMobileHeader: React.FC<UnifiedMobileHeaderProps> = ({
  canGoBack = false,
  onBack,
  canGoForward = false,
  onForward,
  className,
  style,
  fallbackTitle,
  progressiveBlur = true,
}) => {
  const { t } = useTranslation(['common']);
  const isPhoneLandscape = usePhoneLandscape();
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

  // 手机横屏优先使用 max(12px, env(safe-area-inset-left/right)) 避让刘海与圆角；
  // macOS 桌面窗口拉窄（< 768）则让出红绿灯宽度；其余竖屏走标准安全区变量。
  const paddingLeft = isPhoneLandscape
    ? 'max(12px, env(safe-area-inset-left))'
    : !isMobilePlatform() && isMacOS()
      ? `${DESKTOP_SHELL.macTrafficLightsSpacer}px`
      : 'calc(0.75rem + var(--mobile-safe-area-left, 0px))';
  const paddingRight = isPhoneLandscape
    ? 'max(12px, env(safe-area-inset-right))'
    : 'calc(0.75rem + var(--mobile-safe-area-right, 0px))';
  const headerHeight = isPhoneLandscape
    ? `${MOBILE_LAYOUT.LANDSCAPE_HEADER_HEIGHT}px`
    : `var(--mobile-header-total-height, ${MOBILE_LAYOUT.mobileHeader.height}px)`;

  if (config.floatingMenuButton && showMenuButton) {
    return (
      <div
        data-mobile-shell="floating-sidebar-trigger"
        data-phone-landscape={isPhoneLandscape ? 'true' : undefined}
        className={cn(
          'pointer-events-none flex w-full items-start justify-between px-3',
          chromeMotionClass,
          className,
        )}
        style={{
          paddingTop: 'calc(var(--mobile-safe-area-top, 0px) + 0.375rem)',
          paddingLeft,
          paddingRight,
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
      data-phone-landscape={isPhoneLandscape ? 'true' : undefined}
      className={cn(
        'relative z-10 flex w-full flex-shrink-0 items-center gap-2 px-3',
        isPhoneLandscape && 'h-10',
        'mobile-shell-header border-b border-transparent bg-transparent shadow-none',
        chromeMotionClass,
        className,
      )}
      style={{
        paddingTop: isPhoneLandscape ? '0px' : 'var(--mobile-safe-area-top, 0px)',
        paddingLeft,
        paddingRight,
        height: headerHeight,
        minHeight: headerHeight,
        ...style,
      }}
    >
      {progressiveBlur && <MobileProgressiveBlurBar position="top" />}

      {/* 左侧：返回箭头、菜单按钮或全局返回按钮 */}
      <nav
        className="relative z-10 flex min-w-[var(--touch-target-size)] shrink-0 items-center lg:min-w-10"
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
      <div className="relative z-10 flex-1 min-w-0 flex flex-col items-center justify-center overflow-hidden">
        {/* titleNode 优先级高于 title，用于面包屑等复杂渲染；均为空时回退到导航标签（D-1） */}
        {config.titleNode ? (
          config.titleNode
        ) : (config.title || fallbackTitle) ? (
          <h1 className="max-w-full truncate text-md font-semibold text-[color:var(--shell-navigation-foreground)]">
            {config.title || fallbackTitle}
          </h1>
        ) : null}
        {config.subtitle && (
          <p className="max-w-full truncate text-caption text-[color:var(--shell-navigation-muted)]">
            {config.subtitle}
          </p>
        )}
      </div>

      {/* 右侧：操作按钮。
          约定：<= 2 个动作（每个 >= 44px 触控目标）。头部无溢出收纳机制，
          超过 2 个会挤压中间标题区并在 320-375px 窄屏溢出；
          更多动作请收进页面内的「更多」菜单，而不是继续往这里塞。 */}
      <div className="relative z-10 flex min-w-[var(--touch-target-size)] shrink-0 items-center justify-end gap-1" data-no-drag>
        {config.rightActions}
      </div>
    </header>
  );
};

/** 页内顶栏：读 App 注入的返回/前进，跟主栏一起滑，不盖侧栏。 */
export const MobileInFlowHeader: React.FC = () => {
  const nav = useMobileHeaderNav();
  const config = useMobileHeaderContextSafe()?.config;
  // 附属行只跟随根状态顶栏：返回箭头（子页/编辑/会话）、隐藏顶栏、浮动菜单形态都让位
  const showAccessory = Boolean(nav?.accessory)
    && !config?.hidden
    && !config?.showBackArrow
    && !config?.floatingMenuButton;
  return (
    <>
      <UnifiedMobileHeader
        canGoBack={nav?.canGoBack}
        onBack={nav?.onBack}
        canGoForward={nav?.canGoForward}
        onForward={nav?.onForward}
        fallbackTitle={nav?.fallbackTitle}
        className="relative shrink-0"
      />
      {showAccessory ? (
        <div data-mobile-shell="header-accessory" className="relative shrink-0">
          {nav?.accessory}
        </div>
      ) : null}
    </>
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
