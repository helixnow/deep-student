import * as React from 'react';
import { cn } from '../../../lib/utils';
import { inputShellClass } from './inputShell';
import { useImeSafeControlledValue } from './useImeSafeControlledValue';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, value, onChange, onCompositionStart, onCompositionEnd, onBlur, ...props }, ref) => {
    // 受控输入的 IME 组字保护：组字期间不回写 DOM、不向父组件派发（Android 搜狗英文/日文输入，issue 455）
    const imeSafe = useImeSafeControlledValue<HTMLInputElement>({
      value,
      onChange,
      onCompositionStart,
      onCompositionEnd,
      onBlur,
    });
    return (
      <input
        type={type}
        className={cn(
          inputShellClass,
          type === 'search' && 'ds-search-input',
          // 单行输入独有：触达目标高度 + file input 样式
          'flex w-full min-h-[var(--touch-target-size)] lg:min-h-[var(--button-height)] [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          className
        )}
        ref={ref}
        {...props}
        {...imeSafe}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
