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
//
// 字号一律走 token 类（text-ui / text-xs / text-sm → --font-size-* ，内含
// --font-size-scale），不写 Tailwind 任意值字号：设置里的「界面字号」缩放
// 对硬编码 px 无效，按钮标签会成为唯一不跟随缩放的一层。高度仍是
// --touch-target-size（移动 44px）/ --button-height（桌面 32px）等固定
// 几何 token，字号放大不会把触控目标压小。
// 新增违规由 eslint 规则 ds-components/no-arbitrary-font-size 拦截。
export const buttonBaseClassName =
  'ui-press-coarse inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-ui font-medium leading-none transition-[background-color,border-color,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

export const shellNavBaseClassName =
  'ui-press-coarse inline-flex shrink-0 appearance-none items-center gap-2 whitespace-nowrap text-ui font-normal leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

export const buttonToneClassNames: Record<ButtonPrimitiveVariant, string> = {
  primary:
    'border-[color:var(--button-prominent-border)] bg-[var(--button-prominent-bg)] text-primary-foreground hover:bg-[var(--button-prominent-hover-bg)] active:bg-[var(--button-prominent-active-bg)]',
  danger:
    'border-[color:var(--button-destructive-border)] bg-[var(--button-destructive-bg)] text-destructive-foreground hover:bg-[var(--button-destructive-hover-bg)] active:bg-[var(--button-destructive-active-bg)]',
  success:
    'border-[color:var(--button-tonal-border)] bg-[var(--button-tonal-bg)] text-[color:hsl(var(--success))] hover:bg-[var(--button-tonal-hover-bg)] active:bg-[var(--button-tonal-active-bg)]',
  warning:
    'border-[color:var(--button-tonal-border)] bg-[var(--button-tonal-bg)] text-[color:hsl(var(--warning))] hover:bg-[var(--button-tonal-hover-bg)] active:bg-[var(--button-tonal-active-bg)]',
  ghost:
    'border-[color:var(--button-plain-border)] bg-[var(--button-plain-bg)] text-muted-foreground hover:bg-[var(--button-plain-hover-bg)] hover:text-foreground active:bg-[var(--button-plain-active-bg)]',
  default:
    'border-[color:var(--button-tonal-border)] bg-[var(--button-tonal-bg)] text-foreground hover:bg-[var(--button-tonal-hover-bg)] active:bg-[var(--button-tonal-active-bg)]',
  outline:
    'border-[color:var(--button-outline-border)] bg-[var(--button-outline-bg)] text-foreground hover:bg-[var(--button-outline-hover-bg)] hover:text-foreground active:bg-[var(--button-outline-active-bg)]',
  secondary:
    'border-[color:var(--button-tonal-border)] bg-[var(--button-tonal-bg)] text-foreground hover:bg-[var(--button-tonal-hover-bg)] active:bg-[var(--button-tonal-active-bg)]',
  destructive:
    'border-[color:var(--button-destructive-border)] bg-[var(--button-destructive-bg)] text-destructive-foreground hover:bg-[var(--button-destructive-hover-bg)] active:bg-[var(--button-destructive-active-bg)]',
  utility:
    'border-[color:var(--button-tonal-border)] bg-[var(--button-tonal-bg)] text-[color:var(--text-secondary)] hover:bg-[var(--button-tonal-hover-bg)] hover:text-[color:var(--text-primary)] active:bg-[var(--button-tonal-active-bg)]',
  nav:
    'flex min-h-[2.75rem] w-full min-w-0 justify-start gap-2.5 overflow-hidden rounded-2xl border-transparent bg-transparent px-2.5 py-1.5 text-left text-sm text-[color:var(--shell-navigation-muted)] lg:min-h-9 hover:bg-[color:var(--sidebar-quiet-hover)] hover:text-[color:var(--shell-navigation-foreground)] active:bg-[color:var(--sidebar-quiet-active)]',
  shell:
    'border-[color:var(--button-tonal-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-primary)] hover:bg-[var(--button-tonal-hover-bg)] active:bg-[var(--button-tonal-active-bg)]',
  link:
    'border-transparent bg-transparent text-[color:var(--button-primary-foreground)] underline-offset-4 hover:underline',
};

// 尺寸压缩条件只有 lg: 视口断点，宽视口 + 粗指针（iPad 横屏等）会被压到
// 32px 命中区。这里在 lg:h-* 之后追加 [@media(pointer:coarse)]:min-h-*：
// 粗指针设备无论视口多宽，命中高度都保底 --touch-target-size（44px）；
// 细指针宽屏不匹配该媒体查询，仍走 lg 压缩，桌面视觉不变。
// 用 min-h 而非 !h：视觉高度（h/lg:h）与命中保底（min-h）分离，
// 调用方局部覆盖 height 时保底依然生效。图标（正方形）尺寸同时追加
// min-w，保证横向命中区不塌。
export const buttonSizeClassNames: Record<ButtonPrimitiveSize, string> = {
  default:
    'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-ui lg:h-[var(--button-height)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
  sm: 'h-[var(--touch-target-size)] px-[var(--button-padding-x-sm)] text-xs lg:h-[var(--button-height-sm)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
  md: 'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-ui lg:h-[var(--button-height)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
  lg: 'h-[var(--touch-target-size)] px-[var(--button-padding-x-lg)] text-sm lg:h-[var(--button-height-lg)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
  icon:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] rounded-[var(--button-radius)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
};

export const buttonIconSizeClassNames: Record<ButtonPrimitiveSize, string> = {
  default:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
  sm:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-height-sm)] lg:w-[var(--button-height-sm)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
  md:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
  lg:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-height-lg)] lg:w-[var(--button-height-lg)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
  icon:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
};

export const shellNavButtonClassName = cn(shellNavBaseClassName, buttonToneClassNames.nav);

export const shellIconButtonClassName = cn(
  buttonBaseClassName,
  buttonToneClassNames.ghost,
  buttonSizeClassNames.icon,
  'shell-icon-button justify-center !rounded-full text-[color:var(--shell-navigation-muted)] hover:text-[color:var(--shell-navigation-foreground)]'
);
