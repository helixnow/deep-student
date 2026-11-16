import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';

/** 搜索框（`@deepstudent/ui` 公共 API）：受控，`onChange` 直接给出字符串；组字（IME）期间不派发。 */
export interface DsSearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'defaultValue'> {
  value: string;
  onChange: (value: string) => void;
}

export const DsSearchInput = React.forwardRef<HTMLInputElement, DsSearchInputProps>(
  ({ value, onChange, className, placeholder, ...props }, ref) => (
    <div className={cn('relative flex w-full min-w-0 items-center', className)}>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <Input
        ref={ref}
        type="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={props['aria-label'] ?? placeholder}
        placeholder={placeholder}
        {...props}
        value={value}
        onChange={event => onChange(event.target.value)}
        className="pl-9"
      />
    </div>
  ),
);
DsSearchInput.displayName = 'DsSearchInput';
