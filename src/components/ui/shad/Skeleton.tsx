import * as React from 'react';
import { cn } from '../../../lib/utils';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'pulse' | 'shimmer';
}

const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(({ className, variant = 'shimmer', children, ...props }, ref) => {
  if (variant === 'pulse') {
    return (
      <div
        ref={ref}
        className={cn('animate-pulse rounded-md bg-muted/50', className)}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn(
        'relative overflow-hidden rounded-md bg-muted/50',
        className
      )}
      {...props}
    >
      {/* shimmer sweep */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 -translate-x-1/3 bg-gradient-to-r',
          'from-transparent via-foreground/10 to-transparent animate-sweep'
        )}
      />
      {children}
    </div>
  );
});
Skeleton.displayName = 'Skeleton';

export { Skeleton };
