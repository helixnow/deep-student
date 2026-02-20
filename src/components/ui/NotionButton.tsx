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
export type NotionButtonVariant = 'primary' | 'danger' | 'success' | 'warning' | 'ghost' | 'default' | 'outline' | 'secondary' | 'destructive';

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

const variantStyles: Record<NotionButtonVariant, string> = {
  primary: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 active:bg-blue-500/25',
  danger: 'text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 active:bg-red-500/25',
  success: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/25',
  warning: 'text-orange-600 dark:text-orange-400 bg-orange-500/10 hover:bg-orange-500/20 active:bg-orange-500/25',
  ghost: 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10 active:bg-black/10 dark:active:bg-white/15',
  default: 'text-foreground/80 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 active:bg-black/15 dark:active:bg-white/15',
  // 兼容 shadcn 变体名称
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  secondary: 'text-foreground/80 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 active:bg-black/15 dark:active:bg-white/15',
  destructive: 'text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 active:bg-red-500/25',
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
          'inline-flex items-center justify-center font-medium rounded-md transition-colors duration-150',
          // 防止文字换行竖排
          'whitespace-nowrap',
          // 禁用样式
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',
          // 变体样式
          variantStyles[variant],
          // 尺寸样式
          iconOnly ? iconSizeStyles[resolvedSize] : sizeStyles[resolvedSize],
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
