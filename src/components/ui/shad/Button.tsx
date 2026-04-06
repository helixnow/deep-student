import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../lib/utils';
import './Button.css';

const buttonVariants = cva(
        'inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-shell-control)] border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] hover:bg-[color:var(--button-primary-hover)] active:bg-[color:var(--button-primary-active)]',
        destructive: 'border-[color:var(--button-danger-border)] bg-[color:var(--button-danger-surface)] text-[color:var(--button-danger-foreground)] hover:bg-[color:var(--button-danger-hover)] active:bg-[color:var(--button-danger-active)]',
        outline: 'border-[color:var(--button-utility-border)] bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)]',
        secondary: 'border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)] text-[color:var(--text-primary)] hover:bg-[color:var(--button-utility-hover)] active:bg-[color:var(--button-utility-active)]',
        ghost: 'border-transparent bg-transparent text-[color:var(--button-utility-foreground)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)] active:bg-[color:var(--button-utility-active)]',
        link: 'border-transparent bg-transparent text-[color:var(--button-primary-foreground)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((
  { className, variant, size, asChild = false, style, ...props },
  ref,
) => {
  const Comp = asChild ? Slot : 'button';

  // 为各尺寸添加最小像素值，确保 Android WebView 正确渲染
  // 防止在 Android 上由于 rem 单位解析问题导致元素变小或消失
  const sizeStyles: Record<string, React.CSSProperties> = {
    icon: { minWidth: 32, minHeight: 32, flexShrink: 0 },
    sm: { minHeight: 32, flexShrink: 0 },
    default: { minHeight: 36, flexShrink: 0 },
    lg: { minHeight: 40, flexShrink: 0 },
  };
  const sizeStyle = sizeStyles[size ?? 'default'] ?? {};

  return (
    <Comp
      data-shad-button=""
      data-size={size ?? 'default'}
      className={cn(buttonVariants({ variant, size }), className)}
      style={{ ...sizeStyle, ...style }}
      ref={ref}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
