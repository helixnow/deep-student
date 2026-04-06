import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Notion 风格按钮变体
 * - primary: 蓝色文字 + 浅蓝背景（主要操作）
 * - danger: 红色文字 + 浅红背景（危险/删除操作）
 * - success: 绿色文字 + 浅绿背景（成功/确认操作）
 * - warning: 橙色文字 + 浅橙背景（警告操作）
 * - ghost: 灰色文字 + 透明背景（次要操作）
 * - default: 灰色文字 + 浅灰背景（默认操作）
 */
export type NotionButtonVariant =
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
  | 'shell';

/**
 * Notion 风格按钮尺寸
 * - sm: 小尺寸 (h-7)
 * - md: 中等尺寸 (h-8)
 * - lg: 大尺寸 (h-9)
 */
export type NotionButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'default';

export interface NotionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 按钮变体 */
  variant?: NotionButtonVariant;
  /** 按钮尺寸 */
  size?: NotionButtonSize;
  /** 是否为图标按钮（正方形） */
  iconOnly?: boolean;
  /** 子元素 */
  children?: React.ReactNode;
}

const shellNavBaseClassName =
  'inline-flex shrink-0 appearance-none items-center gap-2 whitespace-nowrap text-[13px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-inherit';

const variantStyles: Record<NotionButtonVariant, string> = {
  primary: 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] hover:bg-[color:var(--button-primary-hover)] active:bg-[color:var(--button-primary-active)]',
  danger: 'border-[color:var(--button-danger-border)] bg-[color:var(--button-danger-surface)] text-[color:var(--button-danger-foreground)] hover:bg-[color:var(--button-danger-hover)] active:bg-[color:var(--button-danger-active)]',
  success: 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--success)] hover:bg-[color:var(--button-primary-hover)] active:bg-[color:var(--button-primary-active)]',
  warning: 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:hsl(var(--warning))] hover:bg-[color:var(--button-primary-hover)] active:bg-[color:var(--button-primary-active)]',
  ghost: 'border-transparent bg-transparent text-[color:var(--button-utility-foreground)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]',
  default: 'border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] text-[color:var(--text-primary)] hover:bg-[color:var(--button-utility-hover)] active:bg-[color:var(--button-utility-active)]',
  // 兼容 shadcn 变体名称
  outline: 'border-[color:var(--button-utility-border)] bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)]',
  secondary: 'border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] text-[color:var(--text-primary)] hover:bg-[color:var(--button-utility-hover)] active:bg-[color:var(--button-utility-active)]',
  destructive: 'border-[color:var(--button-danger-border)] bg-[color:var(--button-danger-surface)] text-[color:var(--button-danger-foreground)] hover:bg-[color:var(--button-danger-hover)] active:bg-[color:var(--button-danger-active)]',
  utility: 'border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] text-[color:var(--button-utility-foreground)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]',
  nav: 'flex min-h-[2.75rem] w-full min-w-0 justify-start gap-2.5 overflow-hidden rounded-2xl border-transparent bg-transparent px-2.5 py-1.5 text-left text-sm text-[color:var(--shell-navigation-muted)] md:min-h-9 hover:bg-[color:var(--sidebar-quiet-hover)] hover:text-[color:var(--shell-navigation-foreground)] active:bg-[color:var(--sidebar-quiet-active)]',
  shell: 'border-[color:var(--button-utility-border)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-primary)] shadow-[var(--shadow-shell-soft)] hover:bg-[color:var(--button-utility-hover)] active:bg-[color:var(--button-utility-active)]',
};

const sizeStyles: Record<NotionButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2',
  lg: 'h-9 px-4 text-sm gap-2',
  icon: 'h-8 w-8',
  default: 'h-8 px-3 text-[13px] gap-2',
};

const iconSizeStyles: Record<NotionButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-9 w-9',
  icon: 'h-8 w-8',
  default: 'h-8 w-8',
};

// 开发模式：iconOnly 缺少 aria-label 的警告去重（每个调用位置只提醒一次）
const _warnedIconOnly = new Set<string>();

/**
 * Notion 风格按钮组件
 * 
 * 特点：
 * - 彩色文字 + 浅色背景
 * - 简洁的 hover/active 效果
 * - 无 focus ring 装饰
 * - 圆角适中 (rounded-lg)
 */
export const NotionButton = React.forwardRef<HTMLButtonElement, NotionButtonProps>(
  ({ className, variant = 'default', size = 'md', iconOnly: iconOnlyProp = false, children, disabled, type, ...props }, ref) => {
    // size="icon" 等价于 iconOnly 模式
    const iconOnly = iconOnlyProp || size === 'icon';
    const resolvedSize: NotionButtonSize = size === 'icon' ? 'md' : size;
    // 开发模式下，iconOnly 按钮缺少 aria-label 时发出警告（每个调用位置只提醒一次）
    if (process.env.NODE_ENV === 'development' && iconOnly && !props['aria-label']) {
      const stack = new Error().stack ?? '';
      const caller = stack.split('\n')[2] ?? 'unknown';
      if (!_warnedIconOnly.has(caller)) {
        _warnedIconOnly.add(caller);
        console.warn('[NotionButton] iconOnly button should have an aria-label for accessibility\n  at', caller.trim());
      }
    }

    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        disabled={disabled}
        className={cn(
          // 基础样式
          variant === 'nav'
            ? shellNavBaseClassName
            : 'inline-flex items-center justify-center rounded-[var(--radius-shell-control)] border font-medium shadow-none transition-colors duration-150',
          // 防止文字换行竖排
          'whitespace-nowrap',
          variant === 'nav' ? null : 'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',
          // 变体样式
          variantStyles[variant],
          // 尺寸样式
          iconOnly ? iconSizeStyles[resolvedSize] : variant !== 'icon' && variant !== 'nav' ? sizeStyles[resolvedSize] : null,
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);

NotionButton.displayName = 'NotionButton';

export default NotionButton;
