import { cn } from '@/lib/utils';

export type ButtonPrimitiveVariant =
  | 'primary'
  | 'danger'
  | 'success'
  | 'warning'
  | 'ghost'
  | 'default'
  | 'outline'
  | 'secondary'
  | 'destructive'
  | 'utility'
  | 'nav'
  | 'shell'
  | 'link';

export type ButtonPrimitiveSize = 'sm' | 'md' | 'lg' | 'icon' | 'default';

// ui-press-coarse：触屏（pointer:coarse）统一按压反馈（独立 scale 属性，
// 不影响桌面鼠标 active 手感；定义见 src/styles/ui-motion.css 移动追加区）
export const buttonBaseClassName =
  'ui-press-coarse inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-[13px] font-medium leading-none transition-[background-color,border-color,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

export const shellNavBaseClassName =
  'ui-press-coarse inline-flex shrink-0 appearance-none items-center gap-2 whitespace-nowrap text-[13px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

// 2026-09 裁定：DsButton 只保留两套油漆——ghost（透明）与 danger。
// variant 名仍可用，避免扫全库改调用点；primary/outline/default 等一律走 ghost。
const GHOST_TONE =
  'border-[color:var(--button-plain-border)] bg-[var(--button-plain-bg)] text-muted-foreground hover:bg-[var(--button-plain-hover-bg)] hover:text-foreground active:bg-[var(--button-plain-active-bg)]';
const DANGER_TONE =
  'border-[color:var(--button-destructive-border)] bg-[var(--button-destructive-bg)] text-destructive-foreground hover:bg-[var(--button-destructive-hover-bg)] active:bg-[var(--button-destructive-active-bg)]';

export const buttonToneClassNames: Record<ButtonPrimitiveVariant, string> = {
  ghost: GHOST_TONE,
  primary: GHOST_TONE,
  default: GHOST_TONE,
  outline: GHOST_TONE,
  secondary: GHOST_TONE,
  utility: GHOST_TONE,
  shell: GHOST_TONE,
  success: GHOST_TONE,
  warning: GHOST_TONE,
  danger: DANGER_TONE,
  destructive: DANGER_TONE,
  nav:
    'flex min-h-[2.75rem] w-full min-w-0 justify-start gap-2.5 overflow-hidden rounded-2xl border-transparent bg-transparent px-2.5 py-1.5 text-left text-sm text-[color:var(--shell-navigation-muted)] lg:min-h-9 hover:bg-[color:var(--sidebar-quiet-hover)] hover:text-[color:var(--shell-navigation-foreground)] active:bg-[color:var(--sidebar-quiet-active)]',
  link:
    'border-transparent bg-transparent text-[color:var(--button-primary-foreground)] underline-offset-4 hover:underline',
};

// 移动端（<lg）按钮统一 44px 触控高度；字号/图标同步放大保持壳-内容比例协调
// （修复前 sm=text-xs≈10.5px、图标 16px 贴在 44px 壳上，「按钮太大字太小」）。
// 桌面端由 lg: 前缀恢复原有紧凑字号；svg 规则仅 max-lg 生效，桌面图标尺寸不动。
export const buttonSizeClassNames: Record<ButtonPrimitiveSize, string> = {
  default:
    'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-[14px] lg:h-[var(--button-height)] lg:text-[13px] max-lg:[&_svg]:h-[18px] max-lg:[&_svg]:w-[18px]',
  sm:
    'h-[var(--touch-target-size)] px-[var(--button-padding-x-sm)] text-[13px] lg:h-[var(--button-height-sm)] lg:text-xs max-lg:[&_svg]:h-[18px] max-lg:[&_svg]:w-[18px]',
  md:
    'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-[14px] lg:h-[var(--button-height)] lg:text-[13px] max-lg:[&_svg]:h-[18px] max-lg:[&_svg]:w-[18px]',
  lg:
    'h-[var(--touch-target-size)] px-[var(--button-padding-x-lg)] text-[14px] lg:h-[var(--button-height-lg)] lg:text-sm max-lg:[&_svg]:h-[18px] max-lg:[&_svg]:w-[18px]',
  icon:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] rounded-[var(--button-radius)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] max-lg:[&_svg]:h-5 max-lg:[&_svg]:w-5',
};

export const buttonIconSizeClassNames: Record<ButtonPrimitiveSize, string> = {
  default:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] max-lg:[&_svg]:h-5 max-lg:[&_svg]:w-5',
  sm:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-height-sm)] lg:w-[var(--button-height-sm)] max-lg:[&_svg]:h-5 max-lg:[&_svg]:w-5',
  md:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] max-lg:[&_svg]:h-5 max-lg:[&_svg]:w-5',
  lg:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-height-lg)] lg:w-[var(--button-height-lg)] max-lg:[&_svg]:h-5 max-lg:[&_svg]:w-5',
  icon:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] max-lg:[&_svg]:h-5 max-lg:[&_svg]:w-5',
};

export const shellNavButtonClassName = cn(shellNavBaseClassName, buttonToneClassNames.nav);

export const shellIconButtonClassName = cn(
  buttonBaseClassName,
  buttonToneClassNames.ghost,
  buttonSizeClassNames.icon,
  'shell-icon-button justify-center !rounded-full text-[color:var(--shell-navigation-muted)] hover:text-[color:var(--shell-navigation-foreground)]'
);
