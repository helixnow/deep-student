import * as React from 'react';
import { cn } from '../../../lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // 使用 shadcn 主题变量，转换为更接近 Notion 的透明风格
        'flex w-full rounded-md border border-transparent bg-transparent hover:bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:border-border/60 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-border/50 disabled:cursor-not-allowed disabled:opacity-50 resize-y transition-colors',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };

