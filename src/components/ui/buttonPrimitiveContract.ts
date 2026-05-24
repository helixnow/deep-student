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

export const buttonBaseClassName =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--button-radius)] border text-[13px] font-medium leading-none transition-[background-color,border-color,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] disabled:pointer-events-none disabled:opacity-50 select-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

export const shellNavBaseClassName =
  'inline-flex shrink-0 appearance-none items-center gap-2 whitespace-nowrap text-[13px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

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

export const buttonSizeClassNames: Record<ButtonPrimitiveSize, string> = {
  default: 'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-[13px] lg:h-[var(--button-height)]',
  sm: 'h-[var(--touch-target-size)] px-[var(--button-padding-x-sm)] text-xs lg:h-[var(--button-height-sm)]',
  md: 'h-[var(--touch-target-size)] px-[var(--button-padding-x)] text-[13px] lg:h-[var(--button-height)]',
  lg: 'h-[var(--touch-target-size)] px-[var(--button-padding-x-lg)] text-sm lg:h-[var(--button-height-lg)]',
  icon:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] rounded-[var(--button-radius)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]',
};

export const buttonIconSizeClassNames: Record<ButtonPrimitiveSize, string> = {
  default:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]',
  sm:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-height-sm)] lg:w-[var(--button-height-sm)]',
  md:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]',
  lg:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-height-lg)] lg:w-[var(--button-height-lg)]',
  icon:
    'h-[var(--touch-target-size)] w-[var(--touch-target-size)] p-0 lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]',
};

export const shellNavButtonClassName = cn(shellNavBaseClassName, buttonToneClassNames.nav);

export const shellIconButtonClassName = cn(
  buttonBaseClassName,
  buttonToneClassNames.ghost,
  buttonSizeClassNames.icon,
  'justify-center rounded-full text-[color:var(--shell-navigation-muted)] hover:text-[color:var(--shell-navigation-foreground)]'
);
