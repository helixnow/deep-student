import React, { useEffect, useRef } from 'react';
import { CustomScrollArea } from '../components/custom-scroll-area';
import { cn } from './lib/cn';

export type ChatContainerRootProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export type ChatContainerContentProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export type ChatContainerScrollAnchorProps = {
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export function ChatContainerRoot({
  children,
  className,
  role = 'log',
  onScroll,
  ...props
}: ChatContainerRootProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Scroll to bottom on mount
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      // Keep pinned to bottom when content grows
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <CustomScrollArea
      className={cn('h-full w-full', className)}
      viewportClassName="flex h-full w-full flex-col"
      viewportRef={containerRef}
      viewportProps={{ role, onScroll }}
      {...props}
    >
      {children}
    </CustomScrollArea>
  );
}

export function ChatContainerContent({ children, className, ...props }: ChatContainerContentProps) {
  return (
    <div className={cn('flex w-full flex-col gap-3 p-3', className)} {...props}>
      {children}
    </div>
  );
}

export function ChatContainerScrollAnchor({ className, ...props }: ChatContainerScrollAnchorProps) {
  return <div className={cn('h-px w-full shrink-0 scroll-mt-4', className)} aria-hidden="true" {...props} />;
}
