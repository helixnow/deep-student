import * as React from 'react';
import { cn } from '../../../lib/utils';
import { inputShellClass } from './inputShell';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        inputShellClass,
        // 多行输入独有：最小高度 + 可垂直缩放
        'flex w-full min-h-[80px] resize-y',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };

