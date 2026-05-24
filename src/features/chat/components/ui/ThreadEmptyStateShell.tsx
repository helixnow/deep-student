import React from 'react';
import { cn } from '@/utils/cn';
import { ThreadContentShell } from './ThreadContentShell';

export interface ThreadEmptyStateShellProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  titleClassName?: string;
  contentClassName?: string;
}

/**
 * Shared empty-state shell for thread-aligned chat landing states.
 */
export const ThreadEmptyStateShell: React.FC<ThreadEmptyStateShellProps> = ({
  title,
  className,
  titleClassName,
  contentClassName,
  children,
  ...props
}) => {
  return (
    <ThreadContentShell className={cn('flex min-h-full items-center', className)}>
      <section
        data-slot="thread-empty-state"
        className={cn('flex w-full flex-col items-center justify-center gap-4 text-center', contentClassName)}
        {...props}
      >
        <h2
          data-slot="thread-empty-primary-action"
          className={cn('text-balance text-xl font-medium text-foreground', titleClassName)}
        >
          {title}
        </h2>
        {children}
      </section>
    </ThreadContentShell>
  );
};
