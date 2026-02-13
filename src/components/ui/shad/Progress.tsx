import * as React from 'react';
import { cn } from '../../../lib/utils';
import './Progress.css';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number | null; // 0-100；null/undefined 表示不确定进度
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, ...props }, ref) => {
    const clamped = typeof value === 'number' ? Math.max(0, Math.min(100, value)) : null;
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={typeof clamped === 'number' ? clamped : undefined}
        className={cn(
          'relative w-full h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]',
          clamped == null && 'progress-indeterminate',
          className
        )}
        {...props}
      >
        <div
          className={cn('bar h-full bg-sky-500 transition-all')}
          style={{ width: clamped == null ? '40%' : `${clamped}%` }}
        />
      </div>
    );
  }
);
Progress.displayName = 'Progress';

export default Progress;

