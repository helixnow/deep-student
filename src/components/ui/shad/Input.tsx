import * as React from 'react';
import { cn } from '../../../lib/utils';
import { inputShellClass } from './inputShell';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        inputShellClass,
        // 单行输入独有：触达目标高度 + file input 样式
        'flex w-full min-h-[var(--touch-target-size)] lg:min-h-[var(--button-height)]',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
