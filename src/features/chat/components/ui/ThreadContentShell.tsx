import React from 'react';
import { cn } from '@/utils/cn';

export interface ThreadContentShellProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: 'thread' | 'full';
}

/**
 * Shared thread-width shell for all chat-column aligned surfaces.
 *
 * This keeps messages, input bar, empty states, and thread-level controls
 * pinned to the same width contract without repeating utility classes.
 */
export const ThreadContentShell: React.FC<ThreadContentShellProps> = ({
  width = 'thread',
  className,
  children,
  ...props
}) => {
  return (
    <div
      data-slot="thread-content-shell"
      className={cn('mx-auto w-full', width === 'full' ? 'max-w-full' : 'max-w-thread', className)}
      {...props}
    >
      {children}
    </div>
  );
};
