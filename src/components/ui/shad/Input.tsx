import * as React from 'react';
import { cn } from '../../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        // 使用 shadcn 主题变量，转换为更接近 Notion 的透明风格
        'flex w-full rounded-md border border-transparent bg-transparent hover:bg-muted/30 px-3 py-2 text-sm text-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:border-border/60 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-border/50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
