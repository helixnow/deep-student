import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  buttonBaseClassName,
  buttonIconSizeClassNames,
  buttonSizeClassNames,
  buttonToneClassNames,
  shellNavBaseClassName,
  type ButtonPrimitiveSize,
  type ButtonPrimitiveVariant,
} from '@/components/ui/buttonPrimitiveContract';

/**
 * Notion 风格按钮变体，映射到 Phase 7 共享 primitive contract。
 */
export type NotionButtonVariant = Exclude<ButtonPrimitiveVariant, 'link'>;

/**
 * Notion 风格按钮尺寸。手机和平板保持触控密度，桌面在 lg 后压缩。
 */
export type NotionButtonSize = ButtonPrimitiveSize;

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

// 开发模式：iconOnly 缺少 aria-label 的警告去重（每个调用位置只提醒一次）
const _warnedIconOnly = new Set<string>();

/**
 * Notion 风格按钮组件
 * 
 * 特点：
 * - 使用 study-ui 共享按钮 token
 * - 手机和平板保持 44px 触控区域
 * - hover/active/focus 均走语义 token
 */
export const NotionButton = React.forwardRef<HTMLButtonElement, NotionButtonProps>(
  ({ className, variant = 'default', size = 'md', iconOnly: iconOnlyProp = false, children, disabled, type, ...props }, ref) => {
    // size="icon" 等价于 iconOnly 模式
    const iconOnly = iconOnlyProp || size === 'icon';
    const resolvedSize: NotionButtonSize = size === 'icon' ? 'icon' : size;
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
            : buttonBaseClassName,
          // 防止文字换行竖排
          'whitespace-nowrap',
          variant === 'nav' ? null : 'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',
          // 变体样式
          buttonToneClassNames[variant],
          // 尺寸样式
          iconOnly ? buttonIconSizeClassNames[resolvedSize] : variant !== 'nav' ? buttonSizeClassNames[resolvedSize] : null,
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
