import React from 'react';
import { cn } from '@/lib/utils';
import { useMotionPresence } from '@/hooks/useMotionPresence';

type UiPresenceProps = React.HTMLAttributes<HTMLDivElement> & {
  open: boolean;
  inClass: string;
  outClass: string;
  /** Close animation budget. Defaults to `--dropdown-close-dur` (150ms). */
  exitMs?: number;
  enter?: 'animation' | 'transition';
};

/**
 * Mount-gated overlay wrapper: plays `inClass` on open, keeps the node for
 * `outClass` + `data-state="closed"` on close, then unmounts.
 */
export function UiPresence({
  open,
  inClass,
  outClass,
  exitMs = 150,
  enter = 'animation',
  className,
  children,
  ...rest
}: UiPresenceProps) {
  const presence = useMotionPresence(open, { exitMs, enter });
  if (!presence.mounted) return null;

  return (
    <div
      {...rest}
      data-state={presence.exiting ? 'closed' : 'open'}
      aria-hidden={presence.exiting ? true : rest['aria-hidden']}
      className={cn(presence.exiting ? outClass : inClass, className)}
    >
      {children}
    </div>
  );
}
