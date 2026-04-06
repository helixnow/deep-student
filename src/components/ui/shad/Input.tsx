import * as React from 'react';
import { cn } from '../../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        // 使用 shadcn 主题变量，转换为更接近 Notion 的透明风格
        'flex w-full rounded-[var(--radius-shell-control)] border bg-[color:var(--input-shell-surface)] border-[color:var(--input-shell-border)] px-3 py-2 text-sm text-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/50 hover:bg-[color:var(--surface-panel-strong)] focus-visible:outline-none focus-visible:border-[color:var(--input-shell-focus)] focus-visible:bg-[color:var(--surface-panel-strong)] focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
